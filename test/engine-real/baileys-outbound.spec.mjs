import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as lib from '@whiskeysockets/baileys';
import { LIDMappingStore } from '@whiskeysockets/baileys/lib/Signal/lid-mapping.js';

const require = createRequire(import.meta.url);
const { BaileysMessaging } = require('../../dist/engine/adapters/baileys-messaging.js');
const { BaileysSessionStore } = require('../../dist/engine/adapters/baileys-session-store.js');
const { EngineNotSentError } = require('../../dist/common/errors/engine-not-sent.error.js');
const PN = '6281111111111@s.whatsapp.net';
const LID = '123456789012345@lid';
const noop = () => undefined;

function build(t, { lid = null, budget = 1000 } = {}) {
  const getLIDForPN = t.mock.fn(() => Promise.resolve(lid));
  const sock = {
    signalRepository: { lidMapping: { getLIDForPN, getPNForLID: () => Promise.resolve(PN) } },
    onWhatsApp: t.mock.fn(jid => Promise.resolve([{ jid, exists: true }])),
    sendMessage: t.mock.fn(jid => Promise.resolve({ key: { id: 'M1', remoteJid: jid }, messageTimestamp: 1 })),
    sendPresenceUpdate: t.mock.fn(() => Promise.resolve()),
    presenceSubscribe: t.mock.fn(() => Promise.resolve()),
  };
  let live = sock;
  const recordLidMapping = t.mock.fn();
  const messaging = new BaileysMessaging(
    {
      ensureReady: noop,
      getSocket: () => live,
      getSocketOrNull: () => live,
      logger: { warn: noop },
      toEngineJid: jid => BaileysSessionStore.prototype.toEngineJid(jid),
      toNeutralJid: jid => jid.replace('@s.whatsapp.net', '@c.us'),
      getEphemeralExpiration: noop,
      getStoredMessage: () => Promise.resolve({ key: { id: 'Q1', remoteJid: PN }, message: { conversation: 'Q' } }),
      wasDeletedForEveryone: () => false,
      pendingEditOf: noop,
      toUnixSeconds: ts => ts,
      sessionProxyUrl: noop,
      loadLib: () => Promise.resolve(lib),
      putStoredMessage: noop,
      recordMessage: noop,
      rememberOwnSend: noop,
      recordLidMapping,
      getOnMessageCreate: noop,
    },
    budget,
  );
  return {
    messaging,
    sock,
    recordLidMapping,
    stop: () => {
      live = null;
    },
  };
}

test('an unmapped neutral phone destination uses the Baileys domain', async t => {
  const { messaging, sock } = build(t);
  await messaging.sendTextMessage(PN.replace('@s.whatsapp.net', '@c.us'), 'hello');
  assert.equal(sock.sendMessage.mock.calls[0].arguments[0], PN);
  assert.equal(sock.onWhatsApp.mock.callCount(), 1);
});

test('cold sends resolve through the real Baileys LID store', async t => {
  for (const pairs of [[], [{ pn: PN, lid: LID }]]) {
    const data = {};
    const lookup = t.mock.fn(() => Promise.resolve(pairs));
    const mapping = new LIDMappingStore(
      {
        get: (_type, ids) => Promise.resolve(Object.fromEntries(ids.map(id => [id, data[id]]))),
        set: update => {
          Object.assign(data, update['lid-mapping']);
          return Promise.resolve();
        },
        transaction: work => work(),
      },
      { trace: noop, debug: noop, warn: noop },
      lookup,
    );
    t.after(() => mapping.close());
    const { messaging, sock } = build(t);
    sock.signalRepository.lidMapping = mapping;
    await messaging.sendTextMessage(PN.replace('@s.whatsapp.net', '@c.us'), 'hello');
    assert.deepEqual(lookup.mock.calls[0].arguments[0], [PN]);
    assert.equal(sock.sendMessage.mock.calls[0].arguments[0], pairs.length ? LID : PN);
    assert.equal(sock.onWhatsApp.mock.callCount(), pairs.length ? 0 : 1);
  }
});

test('text, poll and reply sends share canonical recipient preparation', async t => {
  for (const send of [
    m => m.sendTextMessage(PN.replace('@s.whatsapp.net', '@c.us'), 'hello'),
    m => m.sendPollMessage(PN.replace('@s.whatsapp.net', '@c.us'), { name: 'Q', options: ['A', 'B'] }),
    m => m.replyToMessage(PN.replace('@s.whatsapp.net', '@c.us'), 'Q1', 'reply'),
  ]) {
    const { messaging, sock } = build(t);
    await send(messaging);
    assert.equal(sock.sendMessage.mock.calls[0].arguments[0], PN);
    assert.equal(sock.onWhatsApp.mock.callCount(), 1);
  }
});

test('hosted phone and LID destinations normalize to the account', async t => {
  const { messaging, sock } = build(t);
  await messaging.sendTextMessage(PN.replace('@s.whatsapp.net', ':3@hosted'), 'hello');
  await messaging.sendTextMessage(LID.replace('@lid', ':7@hosted.lid'), 'hello');
  assert.deepEqual(
    sock.sendMessage.mock.calls.map(call => call.arguments[0]),
    [PN, LID],
  );
});

test('known and explicit device LIDs address the account and skip phone checks', async t => {
  const { messaging, sock, recordLidMapping } = build(t, { lid: LID.replace('@', ':3@') });
  await messaging.sendTextMessage(PN, 'hello');
  await messaging.sendTextMessage(LID.replace('@', ':7@'), 'hello');
  assert.deepEqual(
    sock.sendMessage.mock.calls.map(call => call.arguments[0]),
    [LID, LID],
  );
  assert.equal(recordLidMapping.mock.calls[0].arguments[0], LID);
  assert.equal(sock.onWhatsApp.mock.callCount(), 0);
});

test('presence normalizes a phone without querying its registration', async t => {
  const { messaging, sock } = build(t);
  await messaging.sendChatState(PN.replace('@s.whatsapp.net', '@c.us'), 'typing');
  await messaging.subscribeToPresence(PN);
  assert.equal(sock.sendPresenceUpdate.mock.calls[0].arguments[1], PN);
  assert.equal(sock.onWhatsApp.mock.callCount(), 0);
});

test('groups, broadcasts and channels bypass phone checks', async t => {
  const { messaging, sock } = build(t);
  for (const jid of ['123@g.us', 'status@broadcast', '123@broadcast', '123@newsletter']) {
    await messaging.sendTextMessage(jid, 'hello');
    assert.equal(sock.sendMessage.mock.calls.at(-1).arguments[0], jid);
  }
  assert.equal(sock.onWhatsApp.mock.callCount(), 0);
});

test('an unregistered phone is refused before sending', async t => {
  const { messaging, sock } = build(t);
  sock.onWhatsApp.mock.mockImplementation(() => Promise.resolve([]));
  await assert.rejects(messaging.sendTextMessage(PN, 'hello'), error => error.getStatus() === 400);
  assert.equal(sock.sendMessage.mock.callCount(), 0);
});

test('an unanswered or rejected phone query is a transport failure before sending', async t => {
  for (const outcome of [() => Promise.resolve(undefined), () => Promise.reject(new Error('disconnected'))]) {
    const { messaging, sock } = build(t);
    sock.onWhatsApp.mock.mockImplementation(outcome);
    await assert.rejects(messaging.sendTextMessage(PN, 'hello'), error => error instanceof EngineNotSentError);
    assert.equal(sock.sendMessage.mock.callCount(), 0);
  }
});

test('a stalled phone query stops at the OpenWA deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { messaging, sock } = build(t, { budget: 20 });
  sock.onWhatsApp.mock.mockImplementation(() => new Promise(noop));
  const sent = messaging.sendTextMessage(PN, 'hello');
  await new Promise(setImmediate);
  t.mock.timers.tick(21);
  await assert.rejects(sent, error => error instanceof EngineNotSentError);
  assert.equal(sock.sendMessage.mock.callCount(), 0);
});

test('a stalled LID lookup cannot hold or send the request indefinitely', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { messaging, sock } = build(t, { budget: 20 });
  sock.signalRepository.lidMapping.getLIDForPN.mock.mockImplementation(() => new Promise(noop));
  const sent = messaging.sendTextMessage(PN, 'hello');
  await new Promise(setImmediate);
  t.mock.timers.tick(21);
  await assert.rejects(sent, error => error instanceof EngineNotSentError);
  assert.equal(sock.sendMessage.mock.callCount(), 0);
});

test('a socket stopped during phone lookup cannot send', async t => {
  const { messaging, sock, stop } = build(t);
  sock.onWhatsApp.mock.mockImplementation(jid => {
    stop();
    return Promise.resolve([{ jid, exists: true }]);
  });
  await assert.rejects(messaging.sendTextMessage(PN, 'hello'), error => error.getStatus() === 409);
  assert.equal(sock.sendMessage.mock.callCount(), 0);
});

test('a socket stopped during LID resolution cannot send or record its mapping', async t => {
  for (const outcome of [() => Promise.resolve(LID), () => Promise.reject(new Error('disconnected'))]) {
    const { messaging, sock, recordLidMapping, stop } = build(t);
    sock.signalRepository.lidMapping.getLIDForPN.mock.mockImplementation(() => {
      stop();
      return outcome();
    });
    await assert.rejects(messaging.sendTextMessage(PN, 'hello'), error => error.getStatus() === 409);
    assert.equal(sock.sendMessage.mock.callCount(), 0);
    assert.equal(recordLidMapping.mock.callCount(), 0);
  }
});

test('a failed LID query still uses a canonical phone destination', async t => {
  const { messaging, sock } = build(t);
  sock.signalRepository.lidMapping.getLIDForPN.mock.mockImplementation(() => Promise.reject(new Error('no mapping')));
  await messaging.sendTextMessage(PN.replace('@s.whatsapp.net', '@c.us'), 'hello');
  assert.equal(sock.sendMessage.mock.calls[0].arguments[0], PN);
});
