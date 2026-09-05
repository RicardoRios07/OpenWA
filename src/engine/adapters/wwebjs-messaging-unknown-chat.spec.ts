import type { Client } from 'whatsapp-web.js';
import { WwebjsMessaging } from './wwebjs-messaging';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';
import { MessageNotFoundError } from '../../common/errors/message-not-found.error';

/**
 * getChatById RESOLVES undefined for a chat this account cannot see (whatsapp-web.js does not throw).
 * reactToMessage/getMessageReactions/deleteMessage then dereferenced it (`chat.fetchMessages`) with no
 * guard, so an unknown chatId produced a TypeError that withPage rethrew as an opaque 500, while the
 * sibling editMessage returned the MessageNotFoundError (404) it deliberately throws for the same input.
 * getChatHistory has no message to 404 on, so a chat with no accessible history yields an empty page.
 */
const logger = createLogger('wwebjs-messaging-unknown-chat.spec');
const CHAT = '628999@c.us';
const MESSAGE_ID = 'true_628999@c.us_ABC';

function makeMessaging(): WwebjsMessaging {
  const client = { getChatById: jest.fn().mockResolvedValue(undefined) };
  const host = {
    ensureReady: jest.fn(),
    getClient: () => client as unknown as Client,
    isPageTransportError: () => false,
    reportIfPageTransportError: jest.fn(),
    logger,
  } as unknown as WwebjsEngineHost;
  return new WwebjsMessaging(host);
}

describe('an unknown chat resolves to 404 (or an empty history), not a 500', () => {
  it('reactToMessage throws MessageNotFoundError', async () => {
    await expect(makeMessaging().reactToMessage(CHAT, MESSAGE_ID, '👍')).rejects.toBeInstanceOf(MessageNotFoundError);
  });
  it('getMessageReactions throws MessageNotFoundError', async () => {
    await expect(makeMessaging().getMessageReactions(CHAT, MESSAGE_ID)).rejects.toBeInstanceOf(MessageNotFoundError);
  });
  it('deleteMessage throws MessageNotFoundError', async () => {
    await expect(makeMessaging().deleteMessage(CHAT, MESSAGE_ID)).rejects.toBeInstanceOf(MessageNotFoundError);
  });
  it('getChatHistory returns an empty page rather than throwing', async () => {
    await expect(makeMessaging().getChatHistory(CHAT, 10)).resolves.toEqual([]);
  });
});
