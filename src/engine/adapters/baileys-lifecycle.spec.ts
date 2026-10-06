jest.mock('qrcode', () => ({ toDataURL: jest.fn() }));
jest.mock('@whiskeysockets/baileys', () => ({ __esModule: true, initAuthCreds: jest.fn() }));
jest.mock('./baileys-auth-store', () => ({
  useAtomicMultiFileAuthState: jest.fn().mockRejectedValue(new Error('stop after auth load')),
}));

import * as qrcode from 'qrcode';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import * as BaileysLib from '@whiskeysockets/baileys';
import { useAtomicMultiFileAuthState } from './baileys-auth-store';
import { BaileysLifecycle, type BaileysLifecycleHost } from './baileys-lifecycle';

describe('BaileysLifecycle.connect', () => {
  it('loads the auth state through the atomic store with the session auth dir, library and logger', async () => {
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const noCallback = (): undefined => undefined;
    const host = {
      authPath: '/data/baileys/session-sess-1',
      logger,
      config: { sessionId: 'sess-1' },
      getOnStateChanged: noCallback,
      getOnError: noCallback,
    } as unknown as BaileysLifecycleHost;

    await expect(new BaileysLifecycle(host).initialize()).rejects.toThrow('stop after auth load');

    expect(useAtomicMultiFileAuthState).toHaveBeenCalledTimes(1);
    const [folder, lib, authLogger] = jest.mocked(useAtomicMultiFileAuthState).mock.calls[0];
    expect(folder).toBe(host.authPath);
    expect(lib.initAuthCreds).toBe(BaileysLib.initAuthCreds);
    expect(authLogger).toBe(logger);
  });
});

describe('BaileysLifecycle unlink cleanup', () => {
  function lifecycle() {
    const noCallback = (): undefined => undefined;
    const fenceStoredWrites = jest.fn();
    const messageStore = { clearSession: jest.fn().mockResolvedValue(undefined) };
    const host = {
      authPath: '/nonexistent/openwa-lifecycle-spec/session-sess-1',
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      config: { sessionId: 'sess-1', dbSessionId: 'db-1', messageStore },
      liveCalls: new Map(),
      fenceStoredWrites,
      getOnStateChanged: noCallback,
      getOnDisconnected: noCallback,
      getOnError: noCallback,
      getOnCredentialTeardownStarted: noCallback,
    } as unknown as BaileysLifecycleHost;
    const sock = {
      user: { id: '628999:1@s.whatsapp.net' },
      query: jest.fn().mockResolvedValue({ tag: 'iq' }),
      generateMessageTag: () => 'tag-1',
      end: jest.fn(),
    };
    const engine = new BaileysLifecycle(host);
    engine.sock = sock as unknown as BaileysLifecycle['sock'];
    return { engine, fenceStoredWrites, clearSession: messageStore.clearSession };
  }

  // A message still being processed must not recreate a row of the unlinked account after its store
  // is wiped, so the store writes are fenced first.
  it('fences stored writes before wiping the message store on an API logout', async () => {
    const { engine, fenceStoredWrites, clearSession } = lifecycle();
    await engine.logout();
    expect(clearSession).toHaveBeenCalledWith('db-1');
    expect(fenceStoredWrites).toHaveBeenCalledTimes(1);
    expect(fenceStoredWrites.mock.invocationCallOrder[0]).toBeLessThan(clearSession.mock.invocationCallOrder[0]);
  });

  it('fences stored writes before wiping the message store on a WhatsApp-side logout', async () => {
    const { engine, fenceStoredWrites, clearSession } = lifecycle();
    await (engine as unknown as { handleRemoteLoggedOut(): Promise<void> }).handleRemoteLoggedOut();
    expect(clearSession).toHaveBeenCalledWith('db-1');
    expect(fenceStoredWrites).toHaveBeenCalledTimes(1);
    expect(fenceStoredWrites.mock.invocationCallOrder[0]).toBeLessThan(clearSession.mock.invocationCallOrder[0]);
  });
});

describe('BaileysLifecycle QR refresh', () => {
  // Exercise the promise overload used by the adapter, rather than qrcode's
  // callback overload (whose return type is void).
  const renderQr = jest.mocked(qrcode.toDataURL as (qr: string) => Promise<string>);
  type Renderer = {
    handleQrCode: (qr: string) => Promise<void>;
    qrCode: string | null;
    sock: unknown;
    status: EngineStatus;
  };
  function fixture() {
    const onQRCode = jest.fn(),
      noCallback = () => undefined;
    const host = {
      authPath: '/fixture',
      config: { sessionId: 'fixture' },
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      getOnQRCode: () => onQRCode,
      getOnStateChanged: noCallback,
      getOnError: noCallback,
    } as unknown as BaileysLifecycleHost;
    const lifecycle = new BaileysLifecycle(host);
    const renderer = lifecycle as unknown as Renderer;
    renderer.sock = { ws: { isOpen: true } };
    renderer.status = EngineStatus.QR_READY;
    renderer.qrCode = 'retired-image';
    return { renderer, onQRCode };
  }
  it('clears a retired image immediately and ignores a slow older render', async () => {
    const { renderer, onQRCode } = fixture();
    let finishOld!: (image: string) => void, finishNew!: (image: string) => void;
    renderQr
      .mockImplementationOnce(
        () =>
          new Promise<string>(resolve => {
            finishOld = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<string>(resolve => {
            finishNew = resolve;
          }),
      );
    const old = renderer.handleQrCode('retired-secret');
    expect(renderer.qrCode).toBeNull();
    const fresh = renderer.handleQrCode('current-secret');
    expect(renderer.qrCode).toBeNull();
    finishNew('current-image');
    await fresh;
    finishOld('retired-image');
    await old;
    expect(renderer.qrCode).toBe('current-image');
    expect(onQRCode).toHaveBeenCalledTimes(1);
    expect(onQRCode).toHaveBeenCalledWith('current-image');
  });
  it.each([EngineStatus.AUTHENTICATING, EngineStatus.READY])(
    'does not publish a pending render after linking enters %s',
    async status => {
      const { renderer, onQRCode } = fixture();
      let finish!: (image: string) => void;
      renderQr.mockImplementationOnce(
        () =>
          new Promise<string>(resolve => {
            finish = resolve;
          }),
      );
      const pending = renderer.handleQrCode('pending');
      renderer.status = status;
      finish('expired-image');
      await pending;
      expect(renderer.qrCode).toBeNull();
      expect(onQRCode).not.toHaveBeenCalled();
    },
  );
  it('discards a pending render after the socket acquires a pairing-code identity', async () => {
    const { renderer, onQRCode } = fixture();
    let finish!: (image: string) => void;
    renderQr.mockImplementationOnce(
      () =>
        new Promise<string>(resolve => {
          finish = resolve;
        }),
    );
    const pending = renderer.handleQrCode('pending');
    (renderer.sock as { user?: { id: string } }).user = { id: 'fixture@s.whatsapp.net' };
    finish('expired-image');
    await pending;
    expect(renderer.qrCode).toBeNull();
    expect(onQRCode).not.toHaveBeenCalled();
  });
});
