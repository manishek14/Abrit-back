import { Repository } from 'typeorm';
import { InboxService } from './inbox.service';
import { BotUpdate } from '../../database/entities/bot-update.entity';
import { BotUpdateStatus } from '../../database/enums';

const mkUpdate = (over: Partial<BotUpdate> = {}): BotUpdate =>
  ({
    update_id: '100',
    payload: {},
    status: BotUpdateStatus.RECEIVED,
    attempts: 0,
    last_error: null,
    received_at: new Date(),
    locked_at: null,
    processed_at: null,
    ...over,
  }) as BotUpdate;

describe('InboxService', () => {
  let service: InboxService;
  let repo: { query: jest.Mock; update: jest.Mock; find: jest.Mock; createQueryBuilder: jest.Mock };

  beforeEach(() => {
    repo = { query: jest.fn(), update: jest.fn(), find: jest.fn(), createQueryBuilder: jest.fn() };
    service = new InboxService(repo as unknown as Repository<BotUpdate>);
  });

  describe('ingest', () => {
    it('returns the stored row for a new update', async () => {
      const row = mkUpdate({ update_id: '100' });
      repo.query.mockResolvedValueOnce([row]);

      const res = await service.ingest('100', { update_id: 100 });
      expect(repo.query).toHaveBeenCalledTimes(1);
      expect(repo.query.mock.calls[0][1]).toEqual(['100', JSON.stringify({ update_id: 100 })]);
      expect(res?.update_id).toBe('100');
    });

    it('returns null for a duplicate update (ON CONFLICT DO NOTHING)', async () => {
      repo.query.mockResolvedValueOnce([]);
      const res = await service.ingest('100', {});
      expect(res).toBeNull();
    });
  });

  describe('claim', () => {
    it('atomically claims a RECEIVED update', async () => {
      const row = mkUpdate({ update_id: '100', status: BotUpdateStatus.PROCESSING, attempts: 1 });
      repo.query.mockResolvedValueOnce([row]);

      const res = await service.claim('100');
      expect(res?.status).toBe(BotUpdateStatus.PROCESSING);
      expect(res?.attempts).toBe(1);
    });

    it('returns null when another worker already owns the update', async () => {
      repo.query.mockResolvedValueOnce([]);
      expect(await service.claim('100')).toBeNull();
    });
  });

  it('markDone stamps processed_at', async () => {
    await service.markDone('100');
    expect(repo.update).toHaveBeenCalledWith(
      { update_id: '100' },
      expect.objectContaining({ status: BotUpdateStatus.DONE, processed_at: expect.any(Date) }),
    );
  });

  it('markFailed stores the error and processed_at', async () => {
    await service.markFailed('100', 'boom');
    expect(repo.update).toHaveBeenCalledWith(
      { update_id: '100' },
      expect.objectContaining({ status: BotUpdateStatus.FAILED, last_error: 'boom' }),
    );
  });

  it('requeueStale re-enqueues fresh rows and fails exhausted ones', async () => {
    const qb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 2 }),
    };
    repo.createQueryBuilder.mockReturnValue(qb);

    const n = await service.requeueStale(120_000, 3);

    expect(n).toBe(4);
    expect(qb.execute).toHaveBeenCalledTimes(2);
    expect(qb.where).toHaveBeenCalledWith(
      "status = 'PROCESSING' AND locked_at < :cutoff",
      { cutoff: expect.any(Date) },
    );
  });

  it('ingest handles the nested UPDATE/RETURNING row shape transparently', async () => {
    const row = mkUpdate({ update_id: '300', status: BotUpdateStatus.PROCESSING });
    repo.query.mockResolvedValueOnce([[row]]); // nested shape TypeORM returns
    const res = await service.ingest('300', {});
    expect(res?.update_id).toBe('300');
  });
});
