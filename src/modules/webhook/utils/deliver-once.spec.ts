import { postWebhookPayload } from './deliver-once';

/**
 * Direct coverage for the shared delivery core both paths (direct and queued processor) now route
 * through. Previously each path carried its own line-for-line copy of the POST + classification,
 * which is the duplication an outbox would have tripled.
 */
describe('postWebhookPayload', () => {
  const makeFetch = (status = 200): { mock: jest.Mock } => ({
    mock: jest.fn().mockResolvedValue({ ok: status < 400, status, statusText: 'OK' }),
  });

  it('POSTs the exact body bytes with the given headers and timeout, through the SSRF guard', async () => {
    const { mock } = makeFetch();
    await postWebhookPayload('https://receiver.example/hook', '{"a":1}', { 'X-Test': '1' }, 5000, mock as never);

    const calls = mock.mock.calls as unknown as unknown[][];
    const [url, opts, classifier, guard] = calls[0] as [
      string,
      { method: string; body: string; headers: Record<string, string>; signal: AbortSignal },
      unknown,
      { guard: boolean },
    ];
    expect(url).toBe('https://receiver.example/hook');
    expect(opts.method).toBe('POST');
    expect(opts.body).toBe('{"a":1}');
    expect(opts.headers).toEqual({ 'X-Test': '1' });
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(classifier).toBeInstanceOf(Function);
    expect(guard.guard).toBe(true); // SSRF guard defaults ON; the opt-out env flips it
  });

  it('resolves with the status on a 2xx answer', async () => {
    const { mock } = makeFetch(204);
    await expect(postWebhookPayload('https://r/hook', '{}', {}, 5000, mock as never)).resolves.toEqual({
      status: 204,
      statusText: 'OK',
    });
  });

  it('throws HTTP <status>: <statusText> on a non-2xx answer (the error shape both paths classify on)', async () => {
    const { mock } = makeFetch(502);
    mock.mockResolvedValue({ ok: false, status: 502, statusText: 'Bad Gateway' });
    await expect(postWebhookPayload('https://r/hook', '{}', {}, 5000, mock as never)).rejects.toThrow(
      'HTTP 502: Bad Gateway',
    );
  });
});
