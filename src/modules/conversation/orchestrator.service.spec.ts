import { OrchestratorService } from './orchestrator.service';
import { InboxService } from '../inbox/inbox.service';
import { FlowRouterService } from './flow-router.service';
import { BotUpdate } from '../../database/entities/bot-update.entity';
import { BotUpdateStatus } from '../../database/enums';

const rawUpdate = (messageOver: Record<string, unknown> = {}): Record<string, unknown> => ({
  update_id: 100,
  message: {
    message_id: 1,
    text: 'سلام، مشکل دارم',
    chat: { id: 555, type: 'private' },
    from: { id: 111, is_bot: false, username: 'sara', first_name: 'سارا' },
    ...messageOver,
  },
});

/** claim() is the source of truth for the payload under test. */
const mkUpdate = (payload: Record<string, unknown>): BotUpdate =>
  ({
    update_id: '100',
    payload,
    status: BotUpdateStatus.PROCESSING,
    attempts: 1,
  }) as BotUpdate;

describe('OrchestratorService (pipeline invariants — routing lives in FlowRouter)', () => {
  let service: OrchestratorService;
  let inbox: {
    claim: jest.Mock;
    markDone: jest.Mock;
    recordError: jest.Mock;
    hasEarlierUnfinished: jest.Mock;
  };
  let flowRouter: { route: jest.Mock };

  /** Enqueue the given payload: claim returns it, so the test drives exactly this shape. */
  const process = (payload: Record<string, unknown>) => {
    inbox.claim.mockResolvedValueOnce(mkUpdate(payload));
    return service.enqueue(mkUpdate(payload));
  };

  beforeEach(() => {
    inbox = {
      claim: jest.fn(),
      markDone: jest.fn(),
      recordError: jest.fn(),
      hasEarlierUnfinished: jest.fn().mockResolvedValue(false),
    };
    flowRouter = { route: jest.fn().mockResolvedValue(undefined) };
    service = new OrchestratorService(
      inbox as unknown as InboxService,
      flowRouter as unknown as FlowRouterService,
    );
  });

  it('skips an update already claimed by another worker', async () => {
    inbox.claim.mockResolvedValueOnce(null);
    await service.enqueue(mkUpdate(rawUpdate()));
    expect(inbox.claim).toHaveBeenCalledWith('100');
    expect(inbox.markDone).not.toHaveBeenCalled();
    expect(flowRouter.route).not.toHaveBeenCalled();
  });

  it('claims and hands the CLAIMED row to the FlowRouter', async () => {
    await process(rawUpdate());
    expect(inbox.claim).toHaveBeenCalledWith('100');
    expect(flowRouter.route).toHaveBeenCalledWith(expect.objectContaining({ update_id: '100' }));
  });

  it('marks updates without message/callback payloads as done (edited/unsupported)', async () => {
    await process({ update_id: 100, edited_message: { text: 'x' } });
    expect(inbox.markDone).toHaveBeenCalledWith('100');
    expect(flowRouter.route).not.toHaveBeenCalled();
  });

  it('ignores non-private chats (groups/channels)', async () => {
    await process(rawUpdate({ chat: { id: -1, type: 'group' } }));
    expect(inbox.markDone).toHaveBeenCalledWith('100');
    expect(flowRouter.route).not.toHaveBeenCalled();
  });

  it('ignores bot senders', async () => {
    await process(rawUpdate({ from: { id: 999, is_bot: true } }));
    expect(inbox.markDone).toHaveBeenCalledWith('100');
    expect(flowRouter.route).not.toHaveBeenCalled();
  });

  it('routes CALLBACK queries through the same pipeline (chat key = embedded message)', async () => {
    const cbPayload = {
      update_id: 101,
      callback_query: {
        id: 'cb-1',
        from: { id: 111, is_bot: false },
        message: { message_id: 5, chat: { id: 555, type: 'private' } },
        data: 'myt:page:1',
      },
    };
    inbox.claim.mockResolvedValueOnce(mkUpdate(cbPayload));
    await service.enqueue(mkUpdate(cbPayload));

    expect(flowRouter.route).toHaveBeenCalledWith(expect.objectContaining({ update_id: '100' }));
    expect(inbox.markDone).not.toHaveBeenCalled(); // the router decides
  });

  describe('ORDERING GATE (review fix — order holds even after a failure)', () => {
    it('does NOT claim an update while an earlier update of the same chat is unfinished', async () => {
      inbox.hasEarlierUnfinished.mockResolvedValueOnce(true);
      await service.enqueue(mkUpdate(rawUpdate()));

      // the row stays RECEIVED — no attempt consumed, nothing processed;
      // the sweeper re-drives it once the blocker reaches DONE/FAILED.
      expect(inbox.claim).not.toHaveBeenCalled();
      expect(flowRouter.route).not.toHaveBeenCalled();
      expect(inbox.markDone).not.toHaveBeenCalled();
    });

    it('checks the gate with the chat id and the update id', async () => {
      inbox.hasEarlierUnfinished.mockResolvedValueOnce(true);
      await service.enqueue(mkUpdate(rawUpdate()));
      expect(inbox.hasEarlierUnfinished).toHaveBeenCalledWith('555', '100');
    });

    it('callback queries use their embedded chat for the gate too', async () => {
      const cbPayload = {
        update_id: 100,
        callback_query: {
          id: 'cb-1',
          from: { id: 111 },
          message: { message_id: 5, chat: { id: 777, type: 'private' } },
          data: 'myt:page:1',
        },
      };
      inbox.hasEarlierUnfinished.mockResolvedValueOnce(true);
      await service.enqueue(mkUpdate(cbPayload));
      expect(inbox.hasEarlierUnfinished).toHaveBeenCalledWith('777', '100');
    });

    it('unsupported shapes skip the gate entirely (they never produce chat content)', async () => {
      await process(rawUpdate({ chat: { id: -1, type: 'group' } }));
      expect(inbox.hasEarlierUnfinished).not.toHaveBeenCalled();
      expect(inbox.markDone).toHaveBeenCalledWith('100');
    });
  });

  it('records the failure reason on the inbox row when routing throws (sweeper retry)', async () => {
    flowRouter.route.mockRejectedValueOnce(new Error('provider exploded'));
    await process(rawUpdate()); // processSafely swallows the error
    expect(inbox.recordError).toHaveBeenCalledWith('100', 'provider exploded');
    expect(inbox.markDone).not.toHaveBeenCalled();
  });

  it('processes two updates of the same chat strictly in order (per-chat queue)', async () => {
    const order: string[] = [];
    flowRouter.route.mockImplementation(async (update: BotUpdate) => {
      order.push(`route:${(update.payload as { message: { text: string } }).message.text}`);
    });

    const first = process(rawUpdate({ message_id: 1, text: 'اول' }));
    const second = process(rawUpdate({ message_id: 2, text: 'دوم' }));
    await Promise.all([first, second]);

    expect(order).toEqual(['route:اول', 'route:دوم']);
  });

  it('parallel chats are NOT serialized against each other', async () => {
    inbox.claim.mockImplementation(async (id: string) => mkUpdate(rawUpdate()));
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    flowRouter.route.mockImplementationOnce(() => gate);
    const first = service.enqueue(mkUpdate(rawUpdate({ chat: { id: 1, type: 'private' } })));
    const second = service.enqueue(mkUpdate(rawUpdate({ chat: { id: 2, type: 'private' } })));

    // the second chat must not wait for the first chat's in-flight update
    await Promise.race([second, new Promise((r) => setTimeout(r, 20))]);
    release();
    await Promise.all([first, second]);
    expect(flowRouter.route).toHaveBeenCalledTimes(2);
  });
});
