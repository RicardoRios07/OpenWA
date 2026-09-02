import { InstanceThrottlerGuard } from './instance-throttler.guard';

describe('InstanceThrottlerGuard', () => {
  it('keys the bucket on (pluginId, instanceId) from the route params, not the client IP', async () => {
    const guard = Object.create(InstanceThrottlerGuard.prototype) as InstanceThrottlerGuard & {
      getTracker(req: unknown): Promise<string>;
    };
    const req = { params: { pluginId: 'chatwoot', instanceId: 'acct1' }, ip: '203.0.113.9' };
    await expect(guard.getTracker(req)).resolves.toBe('ingress:chatwoot:acct1');
  });

  it('falls back to the client IP when params are missing (defensive)', async () => {
    const guard = Object.create(InstanceThrottlerGuard.prototype) as InstanceThrottlerGuard & {
      getTracker(req: unknown): Promise<string>;
    };
    await expect(guard.getTracker({ params: {}, ip: '203.0.113.9' })).resolves.toContain('203.0.113.9');
  });

  it('falls back to the client IP when only one of pluginId/instanceId is present', async () => {
    const guard = Object.create(InstanceThrottlerGuard.prototype) as InstanceThrottlerGuard & {
      getTracker(req: unknown): Promise<string>;
    };
    const req = { params: { pluginId: 'chatwoot' }, ip: '203.0.113.9' };
    await expect(guard.getTracker(req)).resolves.toContain('203.0.113.9');
  });

  // A blank compose `${KEY:-}` forward must never become a limit of 0: the throttler would then
  // reject the first hit on every instance, silently 429ing all inbound webhooks.
  describe('tier resolution from the environment', () => {
    const KEYS = ['INGRESS_INSTANCE_LIMIT', 'INGRESS_INSTANCE_TTL', 'INGRESS_IP_LIMIT'] as const;
    const saved: Array<[string, string | undefined]> = [];
    beforeEach(() => {
      saved.length = 0;
      for (const k of KEYS) saved.push([k, process.env[k]]);
    });
    afterEach(() => {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    type Tier = { name: string; limit: number; ttl: number; getTracker?: (req: unknown) => Promise<string> };

    const resolveTiers = async (): Promise<Tier[]> => {
      const guard = Object.create(InstanceThrottlerGuard.prototype) as InstanceThrottlerGuard & {
        throttlers: Tier[];
        onModuleInit(): Promise<void>;
      };
      // Skip ThrottlerGuard's own onModuleInit (needs the injected storage/options).
      jest.spyOn(Object.getPrototypeOf(InstanceThrottlerGuard.prototype), 'onModuleInit').mockResolvedValue(undefined);
      await guard.onModuleInit();
      return guard.throttlers;
    };

    const sizes = (tiers: Tier[]): Array<{ name: string; limit: number; ttl: number }> =>
      tiers.map(({ name, limit, ttl }) => ({ name, limit, ttl }));

    it.each(['', '   '])('treats a blank value (%p) as unset instead of a limit of 0', async blank => {
      process.env.INGRESS_INSTANCE_LIMIT = blank;
      process.env.INGRESS_INSTANCE_TTL = blank;
      process.env.INGRESS_IP_LIMIT = blank;
      expect(sizes(await resolveTiers())).toEqual([
        { name: 'instance', limit: 120, ttl: 60000 },
        { name: 'ingress-ip', limit: 1200, ttl: 60000 },
      ]);
    });

    it('honors real values', async () => {
      process.env.INGRESS_INSTANCE_LIMIT = '5';
      process.env.INGRESS_INSTANCE_TTL = '1000';
      process.env.INGRESS_IP_LIMIT = '9';
      expect(sizes(await resolveTiers())).toEqual([
        { name: 'instance', limit: 5, ttl: 1000 },
        { name: 'ingress-ip', limit: 9, ttl: 1000 },
      ]);
    });

    /**
     * The point of the second tier: the per-instance bucket is keyed on caller-supplied path
     * segments, so varying them mints a fresh bucket per request. The IP tier must stay keyed on the
     * client even when those params ARE present, or the route has no bound an unauthenticated caller
     * cannot walk around.
     */
    it('keys the ip tier on the client even when instance params are present', async () => {
      const tiers = await resolveTiers();
      const ipTier = tiers.find(t => t.name === 'ingress-ip');
      expect(ipTier?.getTracker).toBeDefined();
      const req = { params: { pluginId: 'chatwoot', instanceId: 'acct1' }, ip: '203.0.113.9' };
      const tracked = await ipTier!.getTracker!(req);
      expect(tracked).toContain('203.0.113.9');
      expect(tracked).not.toContain('acct1');
    });

    it('leaves the instance tier keyed on the instance', async () => {
      const tiers = await resolveTiers();
      const instanceTier = tiers.find(t => t.name === 'instance');
      // No per-tier override: it inherits the class getTracker, proven by the first tests above.
      expect(instanceTier?.getTracker).toBeUndefined();
    });
  });
});
