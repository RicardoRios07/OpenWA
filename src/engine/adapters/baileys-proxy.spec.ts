import * as http from 'http';
import * as net from 'net';
import type { AddressInfo } from 'net';
import { Dispatcher1Wrapper } from 'undici';
import { createProxyDispatcher } from './baileys-lifecycle';

/**
 * Baileys fetches media and the WhatsApp Web version with global fetch, which takes only an undici
 * dispatcher that speaks the handler API of the undici bundled in Node, never a Node http Agent. The
 * last case runs a real fetch through a local proxy, so an incompatible dispatcher fails here.
 */

const listen = async <T extends net.Server>(server: T): Promise<T> => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
};
const portOf = (server: net.Server): number => (server.address() as AddressInfo).port;
const close = (server: net.Server): Promise<void> => new Promise(resolve => server.close(() => resolve()));

describe('createProxyDispatcher', () => {
  it('wraps a dispatcher for http, https and socks5 proxies', () => {
    for (const url of ['http://u:p@proxy.example:8080', 'https://proxy.example:443', 'socks5://proxy.example:1080']) {
      expect(createProxyDispatcher(url)).toBeInstanceOf(Dispatcher1Wrapper);
    }
  });

  it('returns null for socks4, which fetch cannot use', () => {
    expect(createProxyDispatcher('socks4://proxy.example:1080')).toBeNull();
  });

  it('throws on an unsupported scheme', () => {
    expect(() => createProxyDispatcher('ftp://proxy.example:21')).toThrow(/unsupported proxy/i);
  });

  it('routes a global fetch through the proxy', async () => {
    const seen: string[] = [];
    const proxy = await listen(
      http.createServer((req, res) => {
        seen.push(`${req.method} ${req.url}`);
        res.end('via proxy');
      }),
    );
    try {
      const response = await fetch('http://media.example.invalid/file', {
        dispatcher: createProxyDispatcher(`http://127.0.0.1:${portOf(proxy)}`),
      } as RequestInit);
      expect(await response.text()).toBe('via proxy');
      expect(seen).toEqual(['GET http://media.example.invalid/file']);
    } finally {
      proxy.closeAllConnections();
      await close(proxy);
    }
  });

  it('sends percent-encoded socks5 credentials decoded', async () => {
    // Minimal SOCKS5 server: ask for username/password auth (RFC 1929), record it, then refuse.
    const seen: string[] = [];
    const sockets = new Set<net.Socket>();
    const proxy = await listen(
      net.createServer(socket => {
        sockets.add(socket);
        socket.once('data', () => {
          socket.write(Buffer.from([0x05, 0x02]));
          socket.once('data', auth => {
            const userLen = auth[1];
            const user = auth.subarray(2, 2 + userLen).toString();
            const passLen = auth[2 + userLen];
            const pass = auth.subarray(3 + userLen, 3 + userLen + passLen).toString();
            seen.push(`${user}:${pass}`);
            socket.end(Buffer.from([0x01, 0x01]));
          });
        });
      }),
    );
    try {
      await expect(
        fetch('http://media.example.invalid/file', {
          dispatcher: createProxyDispatcher(`socks5://us%40er:p%40ss%3A1@127.0.0.1:${portOf(proxy)}`),
        } as RequestInit),
      ).rejects.toThrow();
      expect(seen).toEqual(['us@er:p@ss:1']);
    } finally {
      sockets.forEach(socket => socket.destroy());
      await close(proxy);
    }
  });
});
