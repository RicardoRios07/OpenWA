import { BaileysEvents, type BaileysEventsHost } from './baileys-events';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import { createLogger } from '../../common/services/logger.service';
import type { WAMessage, WASocket } from '@whiskeysockets/baileys';

/**
 * An inbound download stops for one of two reasons, and the omitted marker has to say which size it
 * knows. Past MEDIA_DOWNLOAD_MAX_BYTES the stream has proven the payload is larger than the cap, so
 * the bytes received are a lower bound; the sender's declared size already passed the pre-gate and is
 * smaller by construction. Past MEDIA_DOWNLOAD_TIMEOUT_MS nothing is proven, so the declared size is
 * the only number, as on a download failure and on whatsapp-web.js. Reporting the cap for both, as
 * before, made a 12-byte overflow and a stalled 4096-byte image look identical.
 */

type Stream = AsyncIterable<Buffer> & { destroy: jest.Mock };

const downloadMediaMessage = jest.fn();

function imageMessage(id: string, fileLength: number): WAMessage {
  return {
    key: { id, remoteJid: '15550001111@s.whatsapp.net', fromMe: false },
    messageTimestamp: 1_700_000_000,
    message: { imageMessage: { mimetype: 'image/png', fileLength } },
  };
}

function build(): { events: BaileysEvents; warns: string[] } {
  const warns: string[] = [];
  const events = new BaileysEvents({
    getSocket: () => ({ updateMediaMessage: jest.fn() }) as unknown as WASocket,
    getSocketOrNull: () => null,
    logger: { ...createLogger('BaileysMediaAbortSpec'), warn: (m: string) => warns.push(m) },
    loadLib: () => Promise.resolve({ normalizeMessageContent: (c: unknown) => c, downloadMediaMessage }),
    toNeutralJid: (jid: string) => jid,
    normalizedSelfJid: () => '6280000000000@s.whatsapp.net',
    connectedAt: 0,
    inboundLimiter: new ConcurrencyLimiter(1),
    recordKeyLidMappings: () => undefined,
    recordMessage: () => undefined,
    recordMessageEdit: () => undefined,
    putStoredMessage: () => undefined,
    getOnMessage: () => undefined,
    getOnMessageCreate: () => undefined,
    getOnMessageRevoked: () => undefined,
    getOnMessageEdited: () => undefined,
    getOnMessageReaction: () => undefined,
    getOnMessageAck: () => undefined,
    getOnGroupEvent: () => undefined,
    getOnCall: () => undefined,
    getOnPresenceUpdate: () => undefined,
    getOnCallOutcome: () => undefined,
  } as unknown as BaileysEventsHost);
  return { events, warns };
}

describe('BaileysEvents aborted media download size', () => {
  const saved = {
    MEDIA_DOWNLOAD_ENABLED: process.env.MEDIA_DOWNLOAD_ENABLED,
    MEDIA_DOWNLOAD_MAX_BYTES: process.env.MEDIA_DOWNLOAD_MAX_BYTES,
    MEDIA_DOWNLOAD_TIMEOUT_MS: process.env.MEDIA_DOWNLOAD_TIMEOUT_MS,
  };

  beforeEach(() => {
    downloadMediaMessage.mockReset();
    // An ambient 'false' takes the skip exit, whose marker carries the declared size and would let
    // the timeout case pass without downloading anything.
    process.env.MEDIA_DOWNLOAD_ENABLED = 'true';
  });

  afterEach(() => {
    jest.useRealTimers();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('reports the bytes received when the stream passes MEDIA_DOWNLOAD_MAX_BYTES', async () => {
    process.env.MEDIA_DOWNLOAD_MAX_BYTES = '10';
    const stream: Stream = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async *[Symbol.asyncIterator]() {
        yield Buffer.alloc(6);
        yield Buffer.alloc(6);
        yield Buffer.alloc(6);
      },
      destroy: jest.fn(),
    };
    downloadMediaMessage.mockResolvedValue(stream);
    const { events, warns } = build();

    // Declares 5 bytes, under the cap, so the pre-gate lets it through; the second chunk trips the cap.
    const incoming = await events.mapMessage(imageMessage('LIAR', 5), 'imageMessage');

    expect(incoming.media).toEqual({ mimetype: 'image/png', filename: undefined, omitted: true, sizeBytes: 12 });
    expect(stream.destroy).toHaveBeenCalled();
    expect(warns).toEqual([expect.stringContaining('MEDIA_DOWNLOAD_MAX_BYTES')]);
    expect(warns[0]).not.toContain('MEDIA_DOWNLOAD_TIMEOUT_MS');
  });

  it('reports the declared size when the download passes MEDIA_DOWNLOAD_TIMEOUT_MS', async () => {
    jest.useFakeTimers();
    process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '50';
    const stream: Stream = {
      async *[Symbol.asyncIterator]() {
        yield Buffer.alloc(16);
        await new Promise<never>(() => undefined);
      },
      destroy: jest.fn(),
    };
    downloadMediaMessage.mockResolvedValue(stream);
    const { events, warns } = build();

    const pending = events.mapMessage(imageMessage('SLOW', 4096), 'imageMessage');
    await jest.advanceTimersByTimeAsync(50);
    const incoming = await pending;

    expect(incoming.media).toEqual({ mimetype: 'image/png', filename: undefined, omitted: true, sizeBytes: 4096 });
    expect(stream.destroy).toHaveBeenCalled();
    expect(warns).toEqual([expect.stringContaining('MEDIA_DOWNLOAD_TIMEOUT_MS')]);
    expect(warns[0]).not.toContain('MEDIA_DOWNLOAD_MAX_BYTES');
  });
});
