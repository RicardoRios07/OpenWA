import { type Call } from 'whatsapp-web.js';
import { type EngineEventCallbacks, type IncomingCallEvent } from '../interfaces/whatsapp-engine.interface';
import { type createLogger } from '../../common/services/logger.service';
import { CallNotFoundError } from '../../common/errors/call-not-found.error';

/**
 * Incoming-call handling extracted from WhatsAppWebJsAdapter: the `call` client event, the live-call
 * cache a later rejectCall() acts on, and that rejection. The adapter keeps the public methods as
 * thin forwarders and injects the host surface via closures, so the delegate never touches lifecycle
 * state directly.
 */
export interface WwebjsCallsHost {
  readonly logger: ReturnType<typeof createLogger>;
  /** Whether teardown has begun — a call landing during or after it is dropped, never cached. */
  isTearingDown(): boolean;
  /** Live callbacks bag — read per event, since initialize() installs it after delegates are built. */
  getCallbacks(): EngineEventCallbacks;
}

export class WwebjsCalls {
  /** How long a received call's handle stays rejectable. Calls ring for roughly a minute, so
   *  two minutes covers the ringing window with margin without pinning dead calls for long. */
  private static readonly LIVE_CALL_TTL_MS = 2 * 60_000;

  /** Live incoming calls by call id. The wwebjs `Call` object is only usable while the call is
   *  live, so it must be cached at event time for a later rejectCall() to act on. Public so the
   *  adapter's `liveCalls` alias keeps working (an unmodified spec reads `adapter.liveCalls`
   *  through a cast) and lifecycle teardown can clear it when the client goes away. */
  readonly liveCalls = new Map<string, { call: Call; expiresAt: number }>();

  constructor(private readonly host: WwebjsCallsHost) {}

  /**
   * Map a whatsapp-web.js `Call` (client `call` event) to the neutral IncomingCallEvent and cache
   * the live Call so rejectCall() can act on it later — the Call object is only usable while the
   * call is live. Own-account calls (fromMe) are skipped: they are outgoing, not incoming. wwebjs
   * ids are already neutral (@c.us), so no jid translation is needed. The try/catch mirrors
   * message_edit: a malformed call is logged and dropped, never thrown back into the emitter.
   */
  handleIncomingCall(call: Call): void {
    try {
      // Symmetry with the other client-event handlers (qr/authenticated): a call landing during or
      // after teardown is dropped. A malformed call without the id/from rejectCall() later depends
      // on is dropped too — never cached, never emitted.
      if (this.host.isTearingDown() || !call?.id || !call.from) {
        return;
      }
      if (call.fromMe) {
        return;
      }
      // whatsapp-web.js fires this handler from a patched `internalCallMap.set()`, which runs on
      // every write to that map — including updates to a call already ringing — so the same call id
      // can arrive more than once. Cache first and emit only for an id not already live, otherwise
      // one call surfaces as several `call.received` events.
      if (!this.cacheLiveCall(call.id, call)) {
        return;
      }
      const payload: IncomingCallEvent = {
        callId: call.id,
        from: call.from ?? '',
        isVideo: call.isVideo === true,
        isGroup: call.isGroup === true,
        timestamp:
          typeof call.timestamp === 'number' && call.timestamp > 0
            ? Math.floor(call.timestamp)
            : Math.floor(Date.now() / 1000),
      };
      this.host.getCallbacks().onCall?.(payload);
    } catch (error) {
      this.host.logger.error('Error processing call event', String(error));
    }
  }

  /**
   * Cache a live call for a later rejectCall(). Lazy expiry: inserting a new call drops
   * already-expired entries, so a session that receives calls but never rejects them can't grow
   * the map without bound; an entry that never sees another call is tiny and is dropped on
   * teardown or at the next call. No per-entry timer to clean up.
   *
   * Returns true when `callId` was not already ringing, which is what makes `call.received` fire
   * once per call rather than once per upstream map write. A repeat write still refreshes the
   * entry, so a long-ringing call stays rejectable for a full TTL from the most recent signal.
   */
  private cacheLiveCall(callId: string, call: Call): boolean {
    const now = Date.now();
    for (const [id, entry] of this.liveCalls) {
      if (entry.expiresAt <= now) {
        this.liveCalls.delete(id);
      }
    }
    const isNewCall = !this.liveCalls.has(callId);
    this.liveCalls.set(callId, { call, expiresAt: now + WwebjsCalls.LIVE_CALL_TTL_MS });
    return isNewCall;
  }

  /**
   * Reject a currently-ringing call. The entry is evicted on ANY attempt (a rejected/ended call
   * will not become rejectable again); an unknown id or an expired entry maps to CallNotFoundError
   * (HTTP 404). A failure of the library's reject() itself propagates as-is.
   */
  async rejectCall(callId: string): Promise<void> {
    const entry = this.liveCalls.get(callId);
    this.liveCalls.delete(callId);
    if (!entry || entry.expiresAt <= Date.now()) {
      throw new CallNotFoundError(callId);
    }
    await entry.call.reject();
  }

  /** Drop every cached call handle — called when the client goes away, so a later rejectCall()
   *  reports not-found instead of acting on a destroyed page. */
  clearLiveCalls(): void {
    this.liveCalls.clear();
  }
}
