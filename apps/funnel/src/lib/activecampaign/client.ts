/**
 * ActiveCampaign API v3 client module (Phase 1037).
 *
 * Email-capture sync is fire-and-forget. Buyer sync attempts every independent
 * list/tag step, then throws an aggregate error so the durable fulfillment
 * outbox can retry any partial failure.
 *
 * Auth: Api-Token header (NOT Authorization: Bearer).
 * Timeout: 15s per request. Retries up to 2× on timeout/network/5xx errors.
 */

import {
  getAcLocalePrefix,
  getEmailListName,
  getSubscriberListName,
  getBuyerTagName,
  getCustomerTagName,
} from './constants';

// --- Resolve caches (module-level, cleared via _resetCache for testing) ------

const listIdCache = new Map<string, number>();
const tagIdCache = new Map<string, number>();

/** Test-only: clear module-level resolve caches. */
export function _resetCache(): void {
  listIdCache.clear();
  tagIdCache.clear();
}

// --- Internal fetch helper ---------------------------------------------------

const AC_TIMEOUT_MS = 15_000;
const AC_MAX_RETRIES = 2;
const AC_RETRY_DELAY_MS = 1_000;

function isRetryable(err: unknown): boolean {
  if (err instanceof Error) {
    // Timeout or network errors
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
    if ('code' in err && (err as { code: unknown }).code === 'UND_ERR_CONNECT_TIMEOUT') return true;
    if (err.message.includes('fetch failed')) return true;
  }
  return false;
}

async function acFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const baseUrl = process.env.ACTIVECAMPAIGN_API_URL?.replace(/\/+$/, '') ?? '';
  const apiKey = process.env.ACTIVECAMPAIGN_API_KEY ?? '';

  const url = `${baseUrl}/api/3${path}`;
  const headers = {
    'Api-Token': apiKey,
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };

  let lastError: unknown;
  for (let attempt = 0; attempt <= AC_MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, AC_RETRY_DELAY_MS * attempt));
      }
      const response = await fetch(url, {
        ...options,
        headers,
        signal: AbortSignal.timeout(AC_TIMEOUT_MS),
      });

      if (!response.ok) {
        const body = await response.text();
        // Retry on 5xx server errors
        if (response.status >= 500 && attempt < AC_MAX_RETRIES) {
          lastError = new Error(`ActiveCampaign API error ${response.status}: ${body}`);
          console.warn(`[activecampaign] acFetch ${path} attempt ${attempt + 1} got ${response.status}, retrying...`);
          continue;
        }
        throw new Error(
          `ActiveCampaign API error ${response.status}: ${body}`,
        );
      }

      return response;
    } catch (err) {
      lastError = err;
      if (attempt < AC_MAX_RETRIES && isRetryable(err)) {
        console.warn(`[activecampaign] acFetch ${path} attempt ${attempt + 1} failed (${(err as Error).name}), retrying...`);
        continue;
      }
      throw err;
    }
  }

  throw lastError;
}

// --- Low-level API wrappers --------------------------------------------------

/**
 * Create or update a contact by email. Returns numeric contact ID.
 */
export async function syncContact(email: string): Promise<number> {
  const response = await acFetch('/contact/sync', {
    method: 'POST',
    body: JSON.stringify({ contact: { email } }),
  });
  const data = await response.json();
  return Number(data.contact.id);
}

/**
 * Subscribe a contact to a list (status: 1).
 */
export async function addContactToList(
  contactId: number,
  listId: number,
): Promise<void> {
  await acFetch('/contactLists', {
    method: 'POST',
    body: JSON.stringify({
      contactList: { list: listId, contact: contactId, status: 1 },
    }),
  });
}

/**
 * Unsubscribe a contact from a list (status: 2).
 * Used for the "move" operation: unsubscribe from email list after subscribing
 * to subscriber list (per Pitfall 5 / Open Question 2).
 */
export async function removeContactFromList(
  contactId: number,
  listId: number,
): Promise<void> {
  await acFetch('/contactLists', {
    method: 'POST',
    body: JSON.stringify({
      contactList: { list: listId, contact: contactId, status: 2 },
    }),
  });
}

/**
 * Add a tag to a contact. Uses string values for contact and tag fields
 * (per Pitfall 3 -- AC API v3 requires string IDs for contactTags).
 */
export async function addTagToContact(
  contactId: number,
  tagId: number,
): Promise<void> {
  await acFetch('/contactTags', {
    method: 'POST',
    body: JSON.stringify({
      contactTag: { contact: String(contactId), tag: String(tagId) },
    }),
  });
}

// --- Resolve helpers (with caching) ------------------------------------------

/**
 * Resolve an AC list name to its numeric ID via the Lists API.
 * Performs exact match filtering. Cached after first resolution.
 *
 * AC's filters[name] is a partial (substring) match, so searching for
 * "EN_BRAND_000000_SUB" also returns "EN_BRAND_000000_SUB_EMAIL". We must match
 * the exact name (same as resolveTagId) — otherwise, when one list name is a
 * prefix of another, lists[0] can resolve to the wrong list.
 */
export async function resolveListId(listName: string): Promise<number> {
  const cached = listIdCache.get(listName);
  if (cached !== undefined) return cached;

  const response = await acFetch(
    `/lists?filters%5Bname%5D=${encodeURIComponent(listName)}`,
  );
  const data = await response.json();
  const returnedLists = data.lists?.map((l: { name: string; id: string }) => l.name) ?? [];
  console.log(`[activecampaign] resolveListId: searching "${listName}", AC returned: ${JSON.stringify(returnedLists)}`);
  const list = data.lists?.find(
    (l: { name: string; id: string }) => l.name === listName,
  );
  if (!list) {
    throw new Error(`resolveListId: no list found matching "${listName}" (AC returned: ${JSON.stringify(returnedLists)})`);
  }
  const id = Number(list.id);
  listIdCache.set(listName, id);
  return id;
}

/**
 * Resolve an AC tag name to its numeric ID via the Tags API.
 * Performs exact match filtering. Cached after first resolution.
 */
export async function resolveTagId(tagName: string): Promise<number> {
  const cached = tagIdCache.get(tagName);
  if (cached !== undefined) return cached;

  const response = await acFetch(
    `/tags?search=${encodeURIComponent(tagName)}`,
  );
  const data = await response.json();
  const returnedTags = data.tags?.map((t: { tag: string; id: string }) => t.tag) ?? [];
  console.log(`[activecampaign] resolveTagId: searching "${tagName}", AC returned: ${JSON.stringify(returnedTags)}`);
  const tag = data.tags?.find(
    (t: { tag: string; id: string }) => t.tag === tagName,
  );
  if (!tag) {
    throw new Error(`resolveTagId: no tag found matching "${tagName}" (AC returned: ${JSON.stringify(returnedTags)})`);
  }
  const id = Number(tag.id);
  tagIdCache.set(tagName, id);
  return id;
}

// --- High-level orchestrators (fire-and-forget) ------------------------------

/**
 * AC-01: Add contact to locale-specific email capture list.
 * Called on email capture step. Fire-and-forget -- never throws.
 */
export async function addContactToEmailList(
  email: string,
  locale: string,
): Promise<void> {
  try {
    const prefix = getAcLocalePrefix(locale);
    const contactId = await syncContact(email);
    const listName = getEmailListName(prefix);
    const listId = await resolveListId(listName);
    await addContactToList(contactId, listId);
  } catch (err) {
    console.error('[activecampaign] addContactToEmailList failed:', err);
  }
}

/**
 * AC-02/03/04: Tag buyer on initial plan purchase.
 * - Add to subscriber list
 * - Remove from email list (the "move")
 * - Add buyer tag
 * - Add customer tag
 *
 * Each step is attempted independently: a failure in one (e.g. removing a
 * contact that was never on the email list) does not block subsequent steps.
 * Any failures are aggregated and thrown after all steps so callers can retry.
 */
export async function tagBuyer(
  email: string,
  locale: string,
): Promise<void> {
  const prefix = getAcLocalePrefix(locale);
  console.log(`[activecampaign] tagBuyer: prefix=${prefix}, email=${email}`);

  const contactId = await syncContact(email);
  console.log(`[activecampaign] tagBuyer: contactId=${contactId}`);

  const subscriberListName = getSubscriberListName(prefix);
  const emailListName = getEmailListName(prefix);
  const buyerTagName = getBuyerTagName(prefix);
  const customerTagName = getCustomerTagName(prefix);
  console.log(`[activecampaign] tagBuyer: resolving list="${subscriberListName}", emailList="${emailListName}", buyerTag="${buyerTagName}", customerTag="${customerTagName}"`);

  const failures: string[] = [];
  const runStep = async (label: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      console.log(`[activecampaign] tagBuyer: ${label} ok`);
    } catch (err) {
      console.error(
        `[activecampaign] tagBuyer: ${label} failed:`,
        err instanceof Error ? err.message : err,
      );
      failures.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  await runStep('subscribe to buyer list', async () => {
    const id = await resolveListId(subscriberListName);
    await addContactToList(contactId, id);
  });

  await runStep('unsubscribe from email list', async () => {
    const id = await resolveListId(emailListName);
    await removeContactFromList(contactId, id);
  });

  await runStep('add buyer tag', async () => {
    const id = await resolveTagId(buyerTagName);
    await addTagToContact(contactId, id);
  });

  await runStep('add customer tag', async () => {
    const id = await resolveTagId(customerTagName);
    await addTagToContact(contactId, id);
  });

  if (failures.length > 0) {
    throw new Error(`tagBuyer failed: ${failures.join('; ')}`);
  }
  console.log('[activecampaign] tagBuyer: done');
}
