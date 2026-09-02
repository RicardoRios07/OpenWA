import { Repository } from 'typeorm';
import { withSafeFetch, redactSsrfError, isSsrfProtectionEnabled } from '../../../common/security/ssrf-guard';
import { type LoggerService } from '../../../common/services/logger.service';
import { WebhookDeliveryFailure } from '../entities/webhook-delivery-failure.entity';
import { recordWebhookDeliveryFailure, statusCodeFromError } from './record-delivery-failure';

/**
 * One SSRF-guarded POST + response classification: a non-ok status throws `HTTP <status>: <statusText>`,
 * ok returns the status. This is the byte-level delivery core BOTH paths previously duplicated line
 * for line; extracting it keeps the two sinks one contract: same fetch, same guard, same error
 * shape, same timeout knob.
 */
export async function postWebhookPayload(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
  fetch: typeof withSafeFetch = withSafeFetch,
): Promise<{ status: number; statusText: string }> {
  const { ok, status, statusText } = await fetch(
    url,
    {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    },
    response => ({ ok: response.ok, status: response.status, statusText: response.statusText }),
    { guard: isSsrfProtectionEnabled() },
  );
  if (!ok) throw new Error(`HTTP ${status}: ${statusText}`);
  return { status, statusText };
}

/**
 * Record a terminal webhook delivery failure (all retries exhausted) to the durable table. Shared
 * wrapper so both paths write the identical row shape. Best-effort: never throws back into the
 * delivery result (the caller's semantics depend on that). Returns false when an identical failure
 * was already recorded, so the caller can keep the failure metric in step with the table.
 */
export async function recordTerminalFailure(
  failureRepository: Repository<WebhookDeliveryFailure>,
  logger: LoggerService,
  input: Omit<Parameters<typeof recordWebhookDeliveryFailure>[2], 'lastStatusCode' | 'lastError'> & { error: unknown },
): Promise<boolean> {
  const { error, ...row } = input;
  const errMessage = redactSsrfError(error);
  return recordWebhookDeliveryFailure(failureRepository, logger, {
    ...row,
    lastStatusCode: statusCodeFromError(errMessage),
    lastError: errMessage,
  });
}
