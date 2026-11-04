import { ForbiddenException } from '@nestjs/common';
import { IngestService } from '../telegram/ingest.service';
import { TELEGRAM_WEBHOOK_SECRET, TelegramWebhookController } from '../telegram/telegram-webhook.controller';

describe('TelegramWebhookController', () => {
  const secret = 'top-secret-token';
  let ingest: { handleIncoming: jest.Mock };
  let controller: TelegramWebhookController;

  beforeEach(() => {
    ingest = { handleIncoming: jest.fn().mockResolvedValue({ stored: true }) };
    controller = new TelegramWebhookController(ingest as unknown as IngestService, secret);
  });

  it('rejects requests without the secret header (403)', async () => {
    await expect(controller.handle(undefined, { update_id: 1 })).rejects.toThrow(ForbiddenException);
    expect(ingest.handleIncoming).not.toHaveBeenCalled();
  });

  it('rejects a wrong secret (403) without leaking whether it was close', async () => {
    await expect(controller.handle('wrong', { update_id: 1 })).rejects.toThrow(ForbiddenException);
    expect(ingest.handleIncoming).not.toHaveBeenCalled();
  });

  it('accepts the correct secret, stores the update and answers 200 instantly', async () => {
    const update = { update_id: 9001, message: { message_id: 1, chat: { id: 5, type: 'private' }, from: { id: 5 }, text: 'سلام' } };
    const res = await controller.handle(secret, update);
    expect(res).toEqual({ ok: true });
    expect(ingest.handleIncoming).toHaveBeenCalledWith(update);
  });
});
