import type { Client } from 'whatsapp-web.js';
import { WwebjsGroups } from './wwebjs-groups';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

/**
 * Both group reads reported a dead page and then rethrew the raw Puppeteer error, so the caller got
 * HTTP 500 while both routes document 503 (session.controller.ts:446 for the list,
 * group.controller.ts:304 for the membership queue). The list route's own wording says the status
 * exists so a caller is never handed an empty list for a query that never ran; on whatsapp-web.js it
 * could not be produced at all, while Baileys has answered it since baileys-group-list.spec.ts:28.
 */
const logger = createLogger('wwebjs-group-transport-death.spec');

describe('group reads distinguish a dead page from an ordinary failure', () => {
  const transportError = new Error('Protocol error (Runtime.callFunctionOn): Target closed');

  function makeGroups(op: string, reject: unknown): { groups: WwebjsGroups; reportIfPageTransportError: jest.Mock } {
    const client = {
      info: {},
      // requireGroupChat runs before the guarded read, so it must resolve a real group.
      getChatById: jest.fn().mockResolvedValue({ isGroup: true }),
      getChats: op === 'getGroups' ? jest.fn().mockRejectedValue(reject) : jest.fn().mockResolvedValue([]),
      getGroupMembershipRequests:
        op === 'getGroupMembershipRequests' ? jest.fn().mockRejectedValue(reject) : jest.fn().mockResolvedValue([]),
    };
    const reportIfPageTransportError = jest.fn();
    const host = {
      ensureReady: jest.fn(),
      getClient: () => client as unknown as Client,
      isPageTransportError: (error: unknown) => error === transportError,
      reportIfPageTransportError,
      logger,
    } as unknown as WwebjsEngineHost;
    return { groups: new WwebjsGroups(host), reportIfPageTransportError };
  }

  const call = (groups: WwebjsGroups, op: string): Promise<unknown> =>
    ({
      getGroups: () => groups.getGroups(),
      getGroupMembershipRequests: () => groups.getGroupMembershipRequests('628123@g.us'),
    })[op]!();

  const OPS = ['getGroups', 'getGroupMembershipRequests'];

  it.each(OPS)('%s answers a dead page with the 503 its route documents', async op => {
    const { groups, reportIfPageTransportError } = makeGroups(op, transportError);

    await expect(call(groups, op)).rejects.toThrow(EngineTransportError);
    expect(reportIfPageTransportError).toHaveBeenCalledWith(transportError, op);
  });

  // Negative twin: an ordinary page-side failure must still surface untouched, so the fix cannot
  // simply relabel every failure as a retryable 503.
  it.each(OPS)('%s still propagates an ordinary failure unchanged', async op => {
    const refusal = new Error('Evaluation failed: group not found');
    const { groups, reportIfPageTransportError } = makeGroups(op, refusal);

    await expect(call(groups, op)).rejects.toBe(refusal);
    expect(reportIfPageTransportError).not.toHaveBeenCalled();
  });
});
