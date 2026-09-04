import { Repository } from 'typeorm';
import { ChatStateStoreService } from './baileys-chat-state-store.service';
import { ChatState } from './baileys-chat-state.entity';

const KEY = (s: string, c: string): string => `${s}\u0000${c}`;

function makeRepo(initial: Partial<ChatState>[] = []) {
  const rows = new Map<string, ChatState>();
  for (const r of initial) {
    rows.set(KEY(r.sessionId!, r.chatId!), {
      muteEndTime: null,
      archived: false,
      pinned: false,
      updatedAt: new Date(),
      ...r,
    } as ChatState);
  }
  const repo = {
    rows,
    find: jest.fn(() => Promise.resolve([...rows.values()])),
    findOne: jest.fn(({ where }: { where: { sessionId: string; chatId: string } }) =>
      Promise.resolve(rows.get(KEY(where.sessionId, where.chatId))),
    ),
    upsert: jest.fn((v: ChatState) => {
      rows.set(KEY(v.sessionId, v.chatId), { ...v });
      return Promise.resolve(undefined);
    }),
  };
  return repo;
}

const svcWith = (repo: ReturnType<typeof makeRepo>) =>
  new ChatStateStoreService(repo as unknown as Repository<ChatState>);

const tick = () => new Promise(resolve => setImmediate(resolve));

describe('ChatStateStoreService', () => {
  const ENV = 'BAILEYS_CHAT_STATE_CACHE_MAX';
  const orig = process.env[ENV];
  afterEach(() => {
    if (orig === undefined) delete process.env[ENV];
    else process.env[ENV] = orig;
  });

  it('reloads the table into the cache on boot', async () => {
    const svc = svcWith(makeRepo([{ sessionId: 's', chatId: 'c', muteEndTime: 123, archived: true, pinned: false }]));
    await svc.reload();
    expect(svc.get('s', 'c')).toEqual({ muteEndTime: 123, archived: true, pinned: false });
  });

  it('returns undefined for an unknown chat', () => {
    expect(svcWith(makeRepo()).get('s', 'nope')).toBeUndefined();
  });

  it('merges a partial patch: mute then archive both survive', async () => {
    const svc = svcWith(makeRepo());
    await svc.remember('s', 'c', { muteEndTime: 999 });
    await svc.remember('s', 'c', { archived: true });
    expect(svc.get('s', 'c')).toEqual({ muteEndTime: 999, archived: true, pinned: false });
  });

  it('skips a no-op identical write', async () => {
    const repo = makeRepo();
    const svc = svcWith(repo);
    await svc.remember('s', 'c', { archived: true });
    await svc.remember('s', 'c', { archived: true });
    expect(repo.upsert).toHaveBeenCalledTimes(1);
  });

  it('evicts the least-recently-used entry over the cap', async () => {
    process.env[ENV] = '2';
    const svc = svcWith(makeRepo());
    await svc.remember('s', 'a', { archived: true });
    await svc.remember('s', 'b', { archived: true });
    await svc.remember('s', 'c', { archived: true }); // evicts 'a'
    expect(svc.get('s', 'a')).toBeUndefined();
    expect(svc.get('s', 'b')).toBeDefined();
    expect(svc.get('s', 'c')).toBeDefined();
  });

  it('warms a cache miss from the table so the next read hits', async () => {
    const svc = svcWith(makeRepo([{ sessionId: 's', chatId: 'c', muteEndTime: 5, archived: false, pinned: true }]));
    // No reload: the cache is empty, so the first read misses and schedules a background lookup.
    expect(svc.get('s', 'c')).toBeUndefined();
    await tick();
    expect(svc.get('s', 'c')).toEqual({ muteEndTime: 5, archived: false, pinned: true });
  });

  it('swallows a repo error on reload and remember (table may not exist yet)', async () => {
    const repo = {
      find: jest.fn(() => Promise.reject(new Error('no such table'))),
      findOne: jest.fn(),
      upsert: jest.fn(() => Promise.reject(new Error('no such table'))),
    };
    const svc = new ChatStateStoreService(repo as unknown as Repository<ChatState>);
    await expect(svc.reload()).resolves.toBeUndefined();
    await expect(svc.remember('s', 'c', { archived: true })).resolves.toBeUndefined();
    // the in-memory mirror still updated even though the write failed
    expect(svc.get('s', 'c')).toEqual({ muteEndTime: null, archived: true, pinned: false });
  });
});
