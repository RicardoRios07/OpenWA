import { Injectable } from '@nestjs/common';
import { ProxyAwareThrottlerGuard } from '../../common/security/proxy-aware-throttler.guard';
import { resolveNonNegativeIntEnv } from '../../config/configuration';

/**
 * Rate-limit bucket keyed on the ingress route's (pluginId, instanceId) instead of the client IP.
 *
 * Providers (Chatwoot, Meta, etc.) deliver every tenant's webhooks from the SAME egress IP, so the
 * global `ProxyAwareThrottlerGuard` — keyed on IP — lumps all instances into one bucket: a noisy
 * tenant on one instance would rate-limit every other instance sharing that provider's IP. Keying on
 * the instance instead sheds a single misbehaving `(pluginId, instanceId)` at the edge before it fills
 * the shared ingress queue, without punishing its neighbors.
 *
 * Applied alongside (not instead of) the global IP guard — see ingress.controller.ts. It deliberately
 * does NOT use `@Throttle()` to size its limit: `@Throttle` metadata is reflected on the route/handler
 * and is read by EVERY `ThrottlerGuard` instance that walks a tier of that name — including the global
 * per-IP guard, which shares the exact same `short`/`medium`/`long` tier list from the one process-wide
 * `ThrottlerModule.forRootAsync` config. Overriding one of those tiers here would silently retarget the
 * global guard's tolerance for this route too (proven by an earlier version of this guard's e2e test:
 * a second, unrelated instance got 429'd purely for sharing the test client's IP with a throttled one).
 * Instead, `onModuleInit` below replaces `this.throttlers` with its own self-contained tiers that only
 * this guard instance evaluates, so their limits are fully independent of the global guard's tiers.
 *
 * It carries TWO tiers on the same window: `instance`, keyed on the route params, and `ingress-ip`,
 * keyed on the client. The instance key is caller-supplied, so the ip tier is the only bound a caller
 * cannot walk around by varying the path. See `onModuleInit` for the sizing.
 */
@Injectable()
export class InstanceThrottlerGuard extends ProxyAwareThrottlerGuard {
  async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    // `??` only defaults on undefined, so a blank compose `${KEY:-}` forward used to reach
    // `Number('')` === 0 — a limit of 0 rejects the very first hit, silently 429ing EVERY inbound
    // webhook. Boot validation cannot catch it either (env.validation treats a blank value as
    // unset). resolveNonNegativeIntEnv treats blank as unset and only accepts plain decimals; an
    // explicit 0 is still rejected at boot by the positive-int check on INGRESS_INSTANCE_LIMIT.
    const ttl = resolveNonNegativeIntEnv(process.env.INGRESS_INSTANCE_TTL, 60000);
    this.throttlers = [
      {
        name: 'instance',
        limit: resolveNonNegativeIntEnv(process.env.INGRESS_INSTANCE_LIMIT, 120),
        ttl,
      },
      {
        // Second bucket, same window, keyed on the CLIENT rather than the route params. The instance
        // bucket alone cannot bound this route: its key comes from `:pluginId/:instanceId`, which the
        // caller supplies, so varying them mints a fresh bucket per request. An unauthenticated
        // caller (the route is `@Public`) therefore walks around the limit entirely, and grows the
        // throttler's key space while doing it. Sized well ABOVE the per-instance limit so it never
        // becomes the binding constraint for a legitimate provider fanning many tenants through one
        // egress IP (the case the instance bucket exists for): 10x the instance default. Raise it
        // with `INGRESS_IP_LIMIT` when one IP legitimately drives more than that.
        name: 'ingress-ip',
        limit: resolveNonNegativeIntEnv(process.env.INGRESS_IP_LIMIT, 1200),
        ttl,
        getTracker: req => this.trackClientIp(req),
      },
    ];
  }

  /**
   * The inherited proxy-aware, IP-keyed tracker, reachable from the tier list above (an arrow
   * function there cannot say `super`). `getTracker` below is overridden for the instance tier, so
   * the ip tier has to reach past that override deliberately.
   */
  private trackClientIp(req: Record<string, unknown>): Promise<string> {
    return super.getTracker(req);
  }

  /**
   * This guard does NOT honour a bare `@SkipThrottle()`. The ingress controller carries one so the
   * GLOBAL per-IP guard skips the route: its medium tier (default 100/min) sits BELOW this guard's
   * per-instance default (120/min), so a provider delivering every tenant's webhooks from one
   * shared egress IP - the exact scenario this guard exists for - was 429'd at the IP tier before
   * the instance bound ever fired, and sustained traffic hit the 1000/h long tier at ~16/min. This
   * guard carries the route's own better-keyed limits instead, and both of its tiers stay
   * unconditional: skipping them would leave a `@Public` route with no rate bound at all.
   */
  protected shouldSkip(): Promise<boolean> {
    return Promise.resolve(false);
  }

  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const params = (req.params ?? {}) as { pluginId?: string; instanceId?: string };
    if (params.pluginId && params.instanceId) {
      return `ingress:${params.pluginId}:${params.instanceId}`;
    }
    // Defensive fallback: params should always be present on the ingress route, but if this guard
    // is ever reused elsewhere (or Nest fails to populate params), don't silently share one bucket.
    return super.getTracker(req);
  }
}
