'use client';

import type { ProductId } from '@repo/shared/price-map';
import { OTO_PRODUCT_IDS } from '../config/oto-config';

// Derived from OTO_CONFIG so the allowlist can never drift from the pages.
// A product id missing here does NOT error: rememberAcceptedOtoRecoveryOrder()
// returns false, which downgrades a 202-accepted charge to plain 'pending' and
// drops it from the OTO8 exit sweep — the buyer advances believing they bought
// something nobody is reconciling. Keep it generated, never hand-written.
const ACCEPTED_OTO_PRODUCTS = new Set<ProductId>(OTO_PRODUCT_IDS);

const SESSION_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ACCEPTED_ORDERS = 8;
const MAX_ACCEPTED_ORDER_AGE_MS = 24 * 60 * 60 * 1000;
const FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

export const ACCEPTED_OTO_RECOVERY_EVENT = 'solidgate:accepted-oto-recovery';

export type AcceptedOtoRecoveryOrder = {
  sessionId: string;
  orderId: string;
  productSlug: ProductId;
  createdAt: number;
};

const memoryQueues = new Map<string, AcceptedOtoRecoveryOrder[]>();
const storageOutOfSyncSessions = new Set<string>();

export function acceptedOtoRecoveryKey(sessionId: string): string {
  return `solidgate-oto-accepted:${sessionId}`;
}

function validBinding(value: unknown, expectedSessionId: string): AcceptedOtoRecoveryOrder | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<AcceptedOtoRecoveryOrder>;
  if (
    candidate.sessionId !== expectedSessionId
    || !SESSION_UUID_PATTERN.test(expectedSessionId)
    || typeof candidate.productSlug !== 'string'
    || !ACCEPTED_OTO_PRODUCTS.has(candidate.productSlug as ProductId)
    || typeof candidate.orderId !== 'string'
    || typeof candidate.createdAt !== 'number'
    || !Number.isFinite(candidate.createdAt)
  ) return null;

  const prefix = `${expectedSessionId}:${candidate.productSlug}:`;
  if (!candidate.orderId.startsWith(prefix)) return null;
  const attempt = candidate.orderId.slice(prefix.length);
  if (!/^[1-9][0-9]{0,8}$/.test(attempt)) return null;
  const age = Date.now() - candidate.createdAt;
  if (age > MAX_ACCEPTED_ORDER_AGE_MS || age < -FUTURE_CLOCK_SKEW_MS) return null;

  return {
    sessionId: expectedSessionId,
    orderId: candidate.orderId,
    productSlug: candidate.productSlug as ProductId,
    createdAt: candidate.createdAt,
  };
}

function writeQueue(sessionId: string, queue: AcceptedOtoRecoveryOrder[]): void {
  const sorted = [...queue]
    .sort((left, right) => left.createdAt - right.createdAt || left.orderId.localeCompare(right.orderId))
    .slice(0, MAX_ACCEPTED_ORDERS);
  memoryQueues.set(sessionId, sorted);
  if (typeof window === 'undefined') return;
  try {
    if (sorted.length > 0) {
      window.localStorage.setItem(acceptedOtoRecoveryKey(sessionId), JSON.stringify(sorted));
    } else {
      window.localStorage.removeItem(acceptedOtoRecoveryKey(sessionId));
    }
    storageOutOfSyncSessions.delete(sessionId);
  } catch {
    // Safari private mode and hardened browsers can deny storage. The in-memory
    // queue still protects same-page navigation for the lifetime of this tab.
    // Ignore the readable-but-stale storage copy until a later write succeeds,
    // otherwise it could erase a newly remembered order or resurrect one that
    // this tab already forgot.
    storageOutOfSyncSessions.add(sessionId);
  }
}

function notifyQueueChanged(sessionId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(ACCEPTED_OTO_RECOVERY_EVENT, {
    detail: { sessionId },
  }));
}

export function readAcceptedOtoRecoveryOrders(
  sessionId: string,
): AcceptedOtoRecoveryOrder[] {
  if (!SESSION_UUID_PATTERN.test(sessionId)) return [];
  const rawQueues: unknown[] = [];
  if (typeof window !== 'undefined' && !storageOutOfSyncSessions.has(sessionId)) {
    try {
      const stored = window.localStorage.getItem(acceptedOtoRecoveryKey(sessionId));
      if (stored) rawQueues.push(JSON.parse(stored) as unknown);
    } catch {
      // Keep the in-memory fallback.
    }
  }
  // Storage is merged first and current-tab memory second, so a valid in-memory
  // binding wins any same-order collision without losing cross-tab additions.
  rawQueues.push(memoryQueues.get(sessionId) ?? []);
  const queue = rawQueues.flatMap((raw) => Array.isArray(raw)
    ? raw.flatMap((entry) => {
      const valid = validBinding(entry, sessionId);
      return valid ? [valid] : [];
    })
    : []);
  const unique = [...new Map(queue.map((entry) => [entry.orderId, entry])).values()]
    .sort((left, right) => left.createdAt - right.createdAt || left.orderId.localeCompare(right.orderId));
  writeQueue(sessionId, unique);
  return unique;
}

export function rememberAcceptedOtoRecoveryOrder(params: {
  sessionId: string;
  orderId: string;
  productSlug: string;
}): boolean {
  const candidate = validBinding({
    ...params,
    createdAt: Date.now(),
  }, params.sessionId);
  if (!candidate) return false;
  const queue = readAcceptedOtoRecoveryOrders(params.sessionId);
  const existing = queue.find((entry) => entry.orderId === candidate.orderId);
  writeQueue(params.sessionId, [
    ...queue.filter((entry) => entry.orderId !== candidate.orderId),
    existing ?? candidate,
  ]);
  if (!existing) notifyQueueChanged(params.sessionId);
  return true;
}

export function forgetAcceptedOtoRecoveryOrder(
  sessionId: string,
  orderId: string,
): boolean {
  const queue = readAcceptedOtoRecoveryOrders(sessionId);
  const remaining = queue.filter((entry) => entry.orderId !== orderId);
  if (remaining.length === queue.length) return false;
  writeQueue(sessionId, remaining);
  notifyQueueChanged(sessionId);
  return true;
}

// ── Declined-purchase notices ───────────────────────────────────────────────
//
// An accepted (202 processing) charge advances the buyer immediately; when the
// provider later declines it, the recovery sweep retires the order. Retiring
// it SILENTLY meant the buyer walked on believing they bought the product
// (live repro: an accepted OTO2 subscription later declined 5.04 in
// production — the buyer advanced through the chain and found the add-on
// locked, with no explanation anywhere). These notices are best-effort UX
// state, not payment truth: the sweep records them, the banner shows them on
// whatever OTO page the buyer is on, dismissal clears them.

export const ACCEPTED_OTO_DECLINED_EVENT = 'solidgate:accepted-oto-declined';
const MAX_DECLINED_NOTICE_AGE_MS = MAX_ACCEPTED_ORDER_AGE_MS;

export type DeclinedAcceptedOtoOrder = {
  sessionId: string;
  orderId: string;
  productSlug: ProductId;
  declinedAt: number;
};

export function declinedAcceptedOtoKey(sessionId: string): string {
  return `solidgate-oto-declined:${sessionId}`;
}

function notifyDeclinedChanged(sessionId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(ACCEPTED_OTO_DECLINED_EVENT, {
    detail: { sessionId },
  }));
}

function writeDeclined(sessionId: string, entries: DeclinedAcceptedOtoOrder[]): void {
  if (typeof window === 'undefined') return;
  try {
    if (entries.length > 0) {
      window.localStorage.setItem(declinedAcceptedOtoKey(sessionId), JSON.stringify(entries));
    } else {
      window.localStorage.removeItem(declinedAcceptedOtoKey(sessionId));
    }
  } catch {
    // Storage can be denied; the notice is best-effort only.
  }
}

export function readDeclinedAcceptedOtoOrders(sessionId: string): DeclinedAcceptedOtoOrder[] {
  if (typeof window === 'undefined' || !SESSION_UUID_PATTERN.test(sessionId)) return [];
  let raw: unknown = [];
  try {
    const stored = window.localStorage.getItem(declinedAcceptedOtoKey(sessionId));
    if (stored) raw = JSON.parse(stored) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const now = Date.now();
  const valid = raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const candidate = entry as Partial<DeclinedAcceptedOtoOrder>;
    const binding = validBinding(
      { ...candidate, createdAt: candidate.declinedAt },
      sessionId,
    );
    if (
      !binding
      || typeof candidate.declinedAt !== 'number'
      || now - candidate.declinedAt > MAX_DECLINED_NOTICE_AGE_MS
    ) return [];
    return [{
      sessionId: binding.sessionId,
      orderId: binding.orderId,
      productSlug: binding.productSlug,
      declinedAt: candidate.declinedAt,
    }];
  });
  const unique = [...new Map(valid.map((entry) => [entry.orderId, entry])).values()]
    .sort((left, right) => left.declinedAt - right.declinedAt || left.orderId.localeCompare(right.orderId));
  return unique;
}

export function recordDeclinedAcceptedOtoOrder(params: {
  sessionId: string;
  orderId: string;
  productSlug: string;
}): boolean {
  const candidate = validBinding(
    { ...params, createdAt: Date.now() },
    params.sessionId,
  );
  if (!candidate) return false;
  const existing = readDeclinedAcceptedOtoOrders(params.sessionId);
  if (existing.some((entry) => entry.orderId === candidate.orderId)) return true;
  writeDeclined(params.sessionId, [
    ...existing,
    {
      sessionId: candidate.sessionId,
      orderId: candidate.orderId,
      productSlug: candidate.productSlug,
      declinedAt: Date.now(),
    },
  ]);
  notifyDeclinedChanged(params.sessionId);
  return true;
}

export function dismissDeclinedAcceptedOtoOrders(sessionId: string): void {
  writeDeclined(sessionId, []);
  notifyDeclinedChanged(sessionId);
}

export function clearAcceptedOtoRecoveryMemoryForTests(): void {
  memoryQueues.clear();
  storageOutOfSyncSessions.clear();
}
