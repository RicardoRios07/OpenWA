import { Repository } from 'typeorm';
import { WebhookDeliveryFailure } from '../entities/webhook-delivery-failure.entity';
import { recordWebhookDeliveryFailure, statusCodeFromError } from './record-delivery-failure';

describe('statusCodeFromError', () => {
  it('parses the status from an "HTTP <code>: ..." message', () => {
    expect(statusCodeFromError('HTTP 503: Service Unavailable')).toBe(503);
    expect(statusCodeFromError('HTTP 404: Not Found')).toBe(404);
  });

  it('returns null for a non-HTTP error (network / timeout / SSRF)', () => {
    expect(statusCodeFromError('The operation was aborted due to timeout')).toBeNull();
    expect(statusCodeFromError('fetch failed')).toBeNull();
  });
});

describe('recordWebhookDeliveryFailure', () => {
  const input = {
    webhookId: 'wh-1',
    sessionId: 's1',
    event: 'message.received',
    url: 'https://r.example/h',
    idempotencyKey: 'k',
    deliveryId: 'd',
    attempts: 3,
    lastStatusCode: 503,
    lastError: 'HTTP 503: x',
  };

  const repoWith = (insert: jest.Mock, existing = 0): Repository<WebhookDeliveryFailure> =>
    ({ insert, count: jest.fn().mockResolvedValue(existing) }) as unknown as Repository<WebhookDeliveryFailure>;

  it('inserts the failure record, defaulting a missing lastStatusCode to null', async () => {
    const insert = jest.fn().mockResolvedValue({});
    const logger = { error: jest.fn() };

    await expect(
      recordWebhookDeliveryFailure(repoWith(insert), logger, { ...input, lastStatusCode: undefined }),
    ).resolves.toBe(true);

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ webhookId: 'wh-1', lastStatusCode: null }));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('skips a delivery it has already recorded, so one lost event is one row', async () => {
    // The reconciler replays a stranded delivery once per sweep until its budget is spent, and each
    // failed replay lands here with the SAME idempotency key.
    const insert = jest.fn().mockResolvedValue({});
    const logger = { error: jest.fn() };

    await expect(recordWebhookDeliveryFailure(repoWith(insert, 1), logger, input)).resolves.toBe(false);

    expect(insert).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('still records a failure that carries no idempotency key', async () => {
    // Control: without a key there is no identity to dedupe on, so the guard must not swallow the
    // row. Otherwise "skips a duplicate" would be satisfied by a helper that stopped inserting.
    const insert = jest.fn().mockResolvedValue({});
    const logger = { error: jest.fn() };

    await expect(
      recordWebhookDeliveryFailure(repoWith(insert, 1), logger, { ...input, idempotencyKey: undefined }),
    ).resolves.toBe(true);

    expect(insert).toHaveBeenCalled();
  });

  it('swallows a repository error so a logging hiccup cannot re-poison the delivery', async () => {
    const insert = jest.fn().mockRejectedValue(new Error('db down'));
    const logger = { error: jest.fn() };

    // Reported as recorded even though the row was lost: the delivery really did fail, and the
    // caller's failure metric must count it rather than hide it behind a database problem.
    await expect(recordWebhookDeliveryFailure(repoWith(insert), logger, input)).resolves.toBe(true);
    expect(logger.error).toHaveBeenCalled();
  });
});
