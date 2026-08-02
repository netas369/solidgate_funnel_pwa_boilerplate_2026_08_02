// Solidgate order_id grammar (decision D6, provisional  -  docs/solidgate/migration-plan.md)
//
// Solidgate has no idempotency keys and no PaymentIntent object: the merchant-
// generated order_id is simultaneously
//   1. the idempotency key (duplicate order_ids are rejected),
//   2. the order<->session binding (replaces payment_intent_sessions' role), and
//   3. the analytics join key.
//
// Grammar:  {sessionId}:{offeringSlug}:{attempt}
//   - sessionId: funnel session UUID (or `u-{userId}` for PWA member-area
//     purchases with no funnel session)
//   - offeringSlug: internal slug (trial1, oto1_lifetime, ...)  -  slugs never
//     contain ':'
//   - attempt: 1-based counter; a declined attempt consumes its order_id, so
//     retries increment
// Limit: Solidgate caps order_id at 255 chars; we stay far below.

export interface ParsedSolidgateOrderId {
  sessionId: string;
  offeringSlug: string;
  attempt: number;
}

export const SOLIDGATE_ORDER_ID_MAX = 255;

export function buildSolidgateOrderId(
  sessionId: string,
  offeringSlug: string,
  attempt = 1,
): string {
  if (sessionId.includes(':') || offeringSlug.includes(':')) {
    throw new Error('sessionId/offeringSlug must not contain ":"');
  }
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`attempt must be a positive integer, got ${attempt}`);
  }
  const orderId = `${sessionId}:${offeringSlug}:${attempt}`;
  if (orderId.length > SOLIDGATE_ORDER_ID_MAX) {
    throw new Error(`order_id exceeds ${SOLIDGATE_ORDER_ID_MAX} chars: ${orderId.length}`);
  }
  return orderId;
}

/** Returns null for foreign/legacy order ids (webhooks must tolerate both). */
export function parseSolidgateOrderId(orderId: string): ParsedSolidgateOrderId | null {
  const parts = orderId.split(':');
  if (parts.length !== 3) return null;
  const [sessionId, offeringSlug, attemptRaw] = parts;
  const attempt = Number(attemptRaw);
  if (!sessionId || !offeringSlug || !Number.isInteger(attempt) || attempt < 1) return null;
  return { sessionId, offeringSlug, attempt };
}
