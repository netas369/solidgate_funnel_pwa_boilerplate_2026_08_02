/** Stable, non-reversible lookup key for the one-intro-offer ledger. */
export async function introOfferEmailHash(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(normalized),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export type IntroOfferClaimResult = 'claimed' | 'retry' | 'already_used' | 'in_progress';

/**
 * How a consumption resolved. None of these is a failure — every one means the
 * PSP took money, so every one must grant.
 *
 *   consumed   the expected path: this claim, this subscription.
 *   reassigned the claim had been re-keyed to another session/tier and the
 *              displaced intent settled instead. Still exactly ONE
 *              subscription. Nothing to refund.
 *   superseded a SECOND subscription was charged to the same buyer. Access is
 *              granted anyway, and the extra subscription id is recorded in
 *              solidgate_intro_claims.superseded_subscription_ids — surfaced by
 *              the solidgate_intro_claims_needing_refund view. Needs a human.
 *
 * Keeping `reassigned` distinct from `superseded` matters: they used to share a
 * return value, so a harmless re-key was logged as "needs refund" and would
 * have fed a cancellation queue that should never have seen it.
 */
export type IntroOfferConsumeResult = 'consumed' | 'reassigned' | 'superseded';

/** Every consume outcome means the buyer paid and must be given access. */
export function introOfferConsumeGranted(result: IntroOfferConsumeResult): boolean {
  return result === 'consumed' || result === 'reassigned' || result === 'superseded';
}

/** Only a genuine second subscription costs the buyer money twice. */
export function introOfferConsumeNeedsRefund(result: IntroOfferConsumeResult): boolean {
  return result === 'superseded';
}

