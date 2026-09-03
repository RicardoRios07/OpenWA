import { type Client } from 'whatsapp-web.js';
import { Contact } from '../interfaces/whatsapp-engine.interface';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { userPart } from '../identity/wa-id';
import { readWid, type SerializedWid } from '../types/whatsapp-web-js.types';
import { type WwebjsEngineHost, withPage } from './wwebjs-host';

/** The raw whatsapp-web.js contact element type, kept local so the wwebjs `Contact` type never leaks. */
type RawWwebjsContact = Awaited<ReturnType<Client['getContacts']>>[number];

/**
 * Contact operations extracted from WhatsAppWebJsAdapter. The adapter keeps the public methods as
 * thin forwarders and injects the shared host surface (./wwebjs-host) via closures, so the delegate
 * never touches lifecycle state directly.
 */
export class WwebjsContacts {
  constructor(private readonly host: WwebjsEngineHost) {}

  /** Post-ensureReady client handle. */
  private client(): Client {
    return this.host.getClient();
  }

  /**
   * Map a raw whatsapp-web.js contact to the library-agnostic {@link Contact}. The id is read
   * through {@link readWid} so both the `_serialized` and post-rename `$1` shapes resolve; a
   * contact with no readable id returns null so callers can skip it instead of dereferencing
   * unguarded (the shape that lets a single bad entry reject the whole request).
   */
  private toContact(c: RawWwebjsContact): Contact | null {
    const id = readWid(c.id);
    if (!id) return null;
    return {
      id,
      name: c.name || undefined,
      pushName: c.pushname || undefined,
      number: c.number,
      isMyContact: c.isMyContact,
      isBlocked: c.isBlocked,
    };
  }

  async getContacts(): Promise<Contact[]> {
    this.host.ensureReady();

    let raw: RawWwebjsContact[];
    try {
      raw = await this.client().getContacts();
    } catch (error) {
      // A dead page surfaces here as a raw Puppeteer error; convert it to the documented transport
      // failure the way wwebjs-chats.ts does, so a transport death answers 503 instead of a bare 500.
      if (this.host.isPageTransportError(error)) {
        this.host.reportIfPageTransportError(error, 'getContacts');
        throw new EngineTransportError('Transport died while reading contacts');
      }
      throw error;
    }

    // Read every id through readWid (so the `_serialized`->`$1` rename lands here too) and skip
    // entries with no readable id, counted and logged like the chats path, rather than dropping
    // the whole address book silently.
    const contacts: Contact[] = [];
    let skipped = 0;
    for (const c of raw) {
      const mapped = this.toContact(c);
      if (!mapped) {
        skipped++;
        continue;
      }
      contacts.push(mapped);
    }
    if (skipped > 0) {
      this.host.logger.warn(`Skipped ${skipped} contact(s) without a serialized id`);
    }
    return contacts;
  }

  async getContactById(contactId: string): Promise<Contact | null> {
    this.host.ensureReady();
    try {
      const contact = await this.client().getContactById(contactId);
      return this.toContact(contact);
    } catch (error) {
      // Unlike the avatar lookup, a throw here can legitimately mean the contact is absent:
      // `window.WWebJS.getContact` has no try/catch and reads `contact.isBusiness` straight off
      // `Contact.find`, so an unknown id throws a TypeError on null. Null (→ 404) stays the answer
      // for that. A dead page is not a missing contact, though, and this was the one lookup that
      // never separated the two.
      if (this.host.isPageTransportError(error)) {
        this.host.reportIfPageTransportError(error, 'getContactById');
        throw new EngineTransportError(`Transport died while reading contact ${contactId}`);
      }
      this.host.logger.warn(`Failed to get contact: ${contactId}`, { error: String(error) });
      return null;
    }
  }

  async getNumberId(number: string): Promise<string | null> {
    this.host.ensureReady();
    const numberId = await withPage(this.host, 'getNumberId', () => this.client().getNumberId(number));
    // Read both property names: a WA Web build that renamed `_serialized` would otherwise make
    // every number look unregistered — and checkNumberExists below reports exactly that.
    return readWid(numberId) ?? null;
  }

  async checkNumberExists(number: string): Promise<boolean> {
    return (await this.getNumberId(number)) !== null;
  }

  async resolveContactPhone(contactId: string): Promise<string | null> {
    this.host.ensureReady();
    // Queried one id at a time: the batch form is prone to "Evaluation failed" and rate-limiting
    // (whatsapp-web.js #3857/#3969). `pn` is the phone JID (`<digits>@c.us`) when the account knows
    // the mapping. An empty/absent pn RESOLVES to null (a definitive "no mapping" answer); a thrown
    // error PROPAGATES - the lid resolver must not mistake a transient failure (dead page,
    // evaluation error, rate limit) for "this contact has no phone" and clobber a valid stored
    // mapping with it. The HTTP route that promises null-on-failure swallows at its boundary
    // (contact.service.resolveContactPhone).
    const [result] = await this.client().getContactLidAndPhone([contactId]);
    const pn = result?.pn;
    return pn ? pn.replace(/@c\.us$/i, '').replace(/\D/g, '') || null : null;
  }

  async upsertContact(contactId: string, firstName: string, lastName = ''): Promise<void> {
    this.host.ensureReady();
    // wwjs addresses the addressbook entry by PHONE NUMBER, not JID (Client.js:3266). lastName is
    // positional and required there, so an absent one is passed as an empty string rather than
    // undefined, which would land in the page-side payload as the literal string "undefined".
    // syncToAddressbook is left at its default (false): writing to the device addressbook is a
    // heavier, separately-consented action than saving the WhatsApp contact.
    await withPage(this.host, 'upsertContact', () =>
      this.client().saveOrEditAddressbookContact(userPart(contactId), firstName, lastName),
    );
    this.host.logger.log(`Saved addressbook contact ${contactId}`);
  }

  async deleteContact(contactId: string): Promise<void> {
    this.host.ensureReady();
    await withPage(this.host, 'deleteContact', () => this.client().deleteAddressbookContact(userPart(contactId)));
    this.host.logger.log(`Deleted addressbook contact ${contactId}`);
  }

  async blockContact(contactId: string): Promise<void> {
    this.host.ensureReady();
    await withPage(this.host, 'blockContact', async () => {
      const contact = await this.client().getContactById(contactId);
      await contact.block();
    });
    this.host.logger.log(`Blocked contact ${contactId}`);
  }

  /**
   * The read half of block/unblockContact. Ids only — the neutral common subset with Baileys,
   * whose blocklist query answers bare jids. An entry whose wid is unreadable (#747 rename
   * hazard) is dropped rather than reported as the literal "undefined".
   */
  async getBlockedContacts(): Promise<string[]> {
    this.host.ensureReady();
    const contacts = await withPage(this.host, 'getBlockedContacts', () => this.client().getBlockedContacts());
    return contacts.map(c => readWid(c.id as unknown as SerializedWid)).filter((id): id is string => Boolean(id));
  }

  async unblockContact(contactId: string): Promise<void> {
    this.host.ensureReady();
    await withPage(this.host, 'unblockContact', async () => {
      const contact = await this.client().getContactById(contactId);
      await contact.unblock();
    });
    this.host.logger.log(`Unblocked contact ${contactId}`);
  }

  async getProfilePicture(contactId: string): Promise<string | null> {
    this.host.ensureReady();
    try {
      const url = await this.client().getProfilePicUrl(contactId);
      return url || null;
    } catch (error) {
      // Nothing reaching here is a statement about the avatar, so nothing reaching here may become
      // null. Returning null would answer 200 with {"url": null} — byte-identical to the verdict
      // above — and a caller that caches "no avatar" would record absence for a lookup that never
      // produced one. The page throws for two distinct reasons and we cannot tell them apart from
      // the message: `getChat` failing to resolve the contact at all, or the profile-pic bridge
      // failing. 404 would assert the first; 503 says only that we could not reach an answer, which
      // is all we know.
      //
      // NOTE the Baileys adapter does the OPPOSITE on this same interface method, and correctly:
      // there a no-picture verdict *is* delivered as a throw, so it swallows to null and uses its
      // own deadline to separate a verdict from a non-answer. Do not harmonise the two into a shared
      // helper — the engines disagree about what a throw means.
      this.host.reportIfPageTransportError(error, 'getProfilePicture');
      this.host.logger.warn(`Failed to get profile picture for ${contactId}: ${String(error)}`);
      throw new EngineTransportError(`Could not read the profile picture for ${contactId}: ${String(error)}`);
    }
  }
}
