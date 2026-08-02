'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from '@repo/i18n/navigation';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { type Locale, type ProductId } from '@repo/shared/price-map';
import { parseSolidgateOrderId } from '@repo/shared/solidgate/order-id';
import { useQuizStore } from '@/stores/quiz-store';
import { useFunnelStore } from '@/stores/funnel-store';
import { useQuizHydration } from '@/features/quiz/hooks/use-quiz-hydration';
import { useAnalytics } from '@/features/analytics/hooks/use-analytics';
import { attributionEventProperties } from '@/features/analytics/lib/attribution';
import {
  checkoutProductContext,
  lifecycleEventId,
  purchaseEventId,
} from '@/features/analytics/lib/checkout-context';
import { purchaseEventValue } from '@/features/analytics/lib/purchase-value';
import {
  confirmSettledGrant,
  GRANT_POLL_BUDGET_MS,
  type SolidgateCheckoutSuccessContext,
} from '@/components/checkout/solidgate-checkout';
import { useScrollToTop } from '@/lib/hooks/use-scroll-to-top';
import { saveMainPaymentRecovery } from '@/features/oto/lib/main-payment-recovery';
import { SOLIDGATE_SEED_COMMAND } from '@/features/checkout/lib/catalog-seed';
import { OFFER_PRICING_TIERS } from '../config/offer-data';
import { OfferSalesBody } from './offer-sales-body';
import { OfferCheckoutModal } from './offer-checkout-modal';
import { SpecialOfferEmailGate } from './special-offer-email-gate';
import '@/app/[locale]/_components/landing/landing.css';

export type OfferVariant = 'main' | 'special-1eur' | 'special-free';

export interface OfferDetailsPageProps {
  variant?: OfferVariant;
  // Preview mode: render the page UI without any quiz/purchase gating,
  // redirects, analytics or payment side-effects. Used by the /preview/*
  // review routes. Defaults false so production behaviour is unchanged.
  preview?: boolean;
}

export const RETURN_GRANT_RETRY_DELAY_MS = 15_000;
export const RETURN_GRANT_MAX_ATTEMPTS = 2;
// Two bounded confirmation cycles with one quiet retry gap. Once exhausted,
// the page keeps the exact sg_order and pending UI for a manual refresh; it
// never opens N+1 or spins another provider-status loop in the background.
export const RETURN_GRANT_MAX_AUTO_WAIT_MS =
  RETURN_GRANT_MAX_ATTEMPTS * GRANT_POLL_BUDGET_MS + RETURN_GRANT_RETRY_DELAY_MS;

// Map picker IDs (set by the /offer trial-price picker) → tier IDs in
// OFFER_PRICING_TIERS, so the right tier is preselected on /offer/details.
const PICKER_TO_TIER: Record<string, string> = {
  trial1:  'tier1',
  trial2:  'tier2',
  trial3: 'tier3',
  trial4: 'tier4',
};

export function OfferDetailsPage({ variant = 'main', preview = false }: OfferDetailsPageProps = {}) {
  const isSpecial = variant === 'special-1eur' || variant === 'special-free';
  const isSpecialFree = variant === 'special-free';
  const router = useRouter();
  const hydrated = useQuizHydration();
  const isComplete = useQuizStore((s) => s.isComplete);
  const sessionId = useQuizStore((s) => s.sessionId);
  const primaryGoal = useQuizStore((s) => s.answers['primaryGoal']) as string | undefined;
  const setStage = useFunnelStore((s) => s.setStage);
  const { track } = useAnalytics();
  const locale = useLocale() as Locale;
  const tCheckout = useTranslations('offer.checkoutModal');

  // Read ?tier= via useSearchParams (reactive, SSR-safe). Default 'tier4'
  // pre-hydration; useEffect below promotes the URL value once we mount.
  const searchParams = useSearchParams();
  const tierParam = searchParams.get('tier');
  const defaultTierId =
    variant === 'special-1eur' ? 'tier_special_1eur'
      : variant === 'special-free' ? 'tier_special_free'
      : 'tier4';
  const [selectedTierId, setSelectedTierId] = useState<string | null>(
    tierParam && PICKER_TO_TIER[tierParam] ? PICKER_TO_TIER[tierParam] : defaultTierId,
  );

  useEffect(() => {
    if (tierParam && PICKER_TO_TIER[tierParam]) {
      setSelectedTierId(PICKER_TO_TIER[tierParam]);
    }
  }, [tierParam]);
  const [checkoutOpen, setCheckoutOpen] = useState<boolean>(false);
  const [isGrantingReturnAccess, setIsGrantingReturnAccess] = useState(false);
  // A 3DS issuer redirect landed here with ?sg_order but the grant could not be
  // confirmed (payment failed, or the param is garbage). Re-enables the normal
  // page behavior (quiz redirect on main, email gate on special).
  const [returnGrantFailed, setReturnGrantFailed] = useState(false);
  const [returnGrantPending, setReturnGrantPending] = useState(false);
  const [returnGrantRetry, setReturnGrantRetry] = useState(0);
  const sgOrderParam = searchParams.get('sg_order');
  const [emailGatePassed, setEmailGatePassed] = useState<boolean>(!isSpecial || preview);

  // Prevents duplicate Meta Purchase events if the checkout's onSuccess fires
  // more than once for a single charge.
  const paySuccessFiredRef = useRef(false);
  const payAcceptedFiredRef = useRef(false);
  const handledReturnOrderRef = useRef<string | null>(null);
  const returnGrantRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A return confirmation owns one request per order. State updates made by
  // that request must not abort it merely because hooks return new callback or
  // router objects on the rerender. Keep mutable collaborators current without
  // making them effect-lifecycle inputs.
  const returnSessionIdRef = useRef(sessionId);
  const returnRouterReplaceRef = useRef(router.replace);
  const returnTrackRef = useRef(track);
  const returnSetStageRef = useRef(setStage);
  returnSessionIdRef.current = sessionId;
  returnRouterReplaceRef.current = router.replace;
  returnTrackRef.current = track;
  returnSetStageRef.current = setStage;
  const [specialSessionId, setSpecialSessionId] = useState<string | null>(null);

  useScrollToTop(
    hydrated && (isSpecial ? emailGatePassed && !!specialSessionId : isComplete && !!sessionId),
  );

  const selectedTier = selectedTierId
    ? OFFER_PRICING_TIERS.find((t) => t.id === selectedTierId) ?? null
    : null;

  // Main /offer/details requires a completed quiz; redirect to /offer if missing.
  // A ?sg_order return from a 3DS issuer redirect is exempt while the grant is
  // being confirmed: the order id itself carries the session, so the quiz store
  // may legitimately be empty (a store lost across the issuer round-trip). If
  // that grant fails, the normal redirect resumes.
  useEffect(() => {
    if (preview) return;
    if (isSpecial) return;
    if (!hydrated) return;
    if (sgOrderParam && !returnGrantFailed) return;
    if (!isComplete || !sessionId) {
      router.replace('/offer');
    }
  }, [preview, isSpecial, hydrated, sgOrderParam, returnGrantFailed, isComplete, sessionId, router]);

  // Solidgate redirect return: an issuer that full-page-redirects for 3DS sends
  // the buyer to our success_url, which carries ?sg_order. The inline flow grants
  // from the SDK's success event instead, so this only fires on the redirect path.
  // The order id itself carries the session and tier ({sessionId}:{tier}:{n}),
  // so this path does not depend on the quiz store surviving the round-trip —
  // the special-offer variants have no quiz session at all — and it can report
  // the same oto_accepted/checkout_completed the inline success path does (the
  // server still verifies the order against Solidgate before granting).
  useEffect(() => {
    if (preview) return;
    if (!hydrated) return;
    const orderId = sgOrderParam;
    if (!orderId) return;
    if (handledReturnOrderRef.current === orderId) return;
    handledReturnOrderRef.current = orderId;
    const parsed = parseSolidgateOrderId(orderId);
    const grantSessionId = parsed?.sessionId ?? returnSessionIdRef.current;
    const redirectProductContext = parsed
      ? checkoutProductContext(parsed.offeringSlug as ProductId, locale)
      : null;
    if (!parsed || !grantSessionId || !redirectProductContext) {
      if (parsed && grantSessionId && !redirectProductContext) {
        // The order id is well-formed but there is no product context, which in
        // a fresh boilerplate means the PSP catalog was never seeded. Say so:
        // otherwise this looks like a random failed payment.
        console.error(
          '[offer-details] No checkout context for "%s". If catalog-ids.json is ' +
            'still empty, run `%s` and commit the result.',
          parsed.offeringSlug,
          SOLIDGATE_SEED_COMMAND,
        );
      }
      // Garbage/foreign sg_order: nothing to grant — resume normal page
      // behaviour instead of suppressing the quiz redirect / email gate forever.
      setReturnGrantFailed(true);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setReturnGrantPending(false);
    setReturnGrantFailed(false);
    setIsGrantingReturnAccess(true);
    confirmSettledGrant(
      orderId,
      grantSessionId,
      redirectProductContext.amount_cents,
      controller.signal,
      async (accepted) => {
        if (cancelled || payAcceptedFiredRef.current) return;
        payAcceptedFiredRef.current = true;
        saveMainPaymentRecovery({
          orderId,
          sessionId: grantSessionId,
          checkout: redirectProductContext,
        });
        const tier = parsed.offeringSlug as ProductId;
        const productLabel =
          tier === 'special_free'
            ? 'special-free'
            : tier === 'special_1eur'
              ? 'special-1eur'
              : 'main';
        const acceptedEventId = lifecycleEventId('oto_accepted', orderId);
        returnTrackRef.current('oto_accepted', {
          ...redirectProductContext,
          ...attributionEventProperties(),
          order_id: orderId,
          solidgate_order_id: orderId,
          transaction_id: orderId,
          subscription_id: accepted.subscriptionId,
          payment_status: accepted.status ?? 'auth_ok',
          settled: false,
          authorized_trial: false,
          session_id: grantSessionId,
          product_category: productLabel,
          event_id: acceptedEventId,
          $insert_id: acceptedEventId,
        });
        useQuizStore.getState().grantPurchaseAuthorization(grantSessionId);
        returnSetStageRef.current('checkout');
        returnRouterReplaceRef.current(accepted.resumeTo ?? '/oto/1');
        return true;
      },
    )
      .then(async (data) => {
        if (parsed && !paySuccessFiredRef.current) {
          try {
            const tier = parsed.offeringSlug as ProductId;
            const productContext = checkoutProductContext(tier, locale);
            if (!productContext) throw new Error('Missing checkout product context.');
            const captured =
              data.captured === true || data.settled === true || data.fullyCaptured === true;
            const authorizedTrial =
              productContext.amount_cents === 0 && data.authorizedTrial === true;
            if (data.ok !== true || (!captured && !authorizedTrial)) {
              throw new Error('Payment is not settled yet.');
            }
            paySuccessFiredRef.current = true;
            const shouldTrackAccepted = !payAcceptedFiredRef.current;
            payAcceptedFiredRef.current = true;
            const productLabel =
              tier === 'special_free' ? 'special-free' : tier === 'special_1eur' ? 'special-1eur' : 'main';
            const eventId = purchaseEventId(orderId);
            const acceptedEventId = lifecycleEventId('oto_accepted', orderId);
            const attribution = attributionEventProperties();
            const checkoutContext = {
              ...productContext,
              order_id: orderId,
              solidgate_order_id: orderId,
              transaction_id: orderId,
              subscription_id: data.subscriptionId,
              event_id: eventId,
              $insert_id: eventId,
              payment_status: data.status ?? 'unknown',
              settled: captured,
              authorized_trial: authorizedTrial,
              ...attribution,
            };
            if (shouldTrackAccepted) {
              returnTrackRef.current('oto_accepted', {
                ...checkoutContext,
                session_id: grantSessionId,
                product_category: productLabel,
                event_id: acceptedEventId,
                $insert_id: acceptedEventId,
              });
            }
            returnTrackRef.current('checkout_completed', {
              ...checkoutContext,
              session_id: grantSessionId,
              product_category: productLabel,
              value: purchaseEventValue(productContext.amount_cents, productContext.currency),
            });
          } catch (trackErr) {
            // Analytics must never block the grant or the redirect down the chain.
            console.error('[offer-details] sg_order tracking failed:', trackErr);
          }
        }
        // The OTO pages gate on the quiz store (sessionId + isComplete OR
        // authorizedViaPurchase). The store never saw this purchase — the
        // special variants have no quiz, and a 3DS round-trip can lose
        // localStorage — so authorize it here exactly like the inline path.
        useQuizStore.getState().grantPurchaseAuthorization(grantSessionId);
        returnSetStageRef.current('checkout');
        if (!cancelled) returnRouterReplaceRef.current(data.resumeTo ?? '/oto/1');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error('[offer-details] solidgate grant failed:', error instanceof Error ? error.message : error);
        if (error instanceof Error && error.message === 'payment_pending') {
          setReturnGrantPending(true);
          // One slow retry covers an issuer that settles just after the first
          // 120s poll. The second pending result is terminal for AUTO polling:
          // preserve the same sg_order + pending interstitial until the buyer
          // manually refreshes, with no checkout reopen and no N+1 identity.
          if (returnGrantRetry + 1 < RETURN_GRANT_MAX_ATTEMPTS) {
            returnGrantRetryTimerRef.current = setTimeout(() => {
              if (cancelled) return;
              handledReturnOrderRef.current = null;
              setReturnGrantRetry((attempt) => attempt + 1);
            }, RETURN_GRANT_RETRY_DELAY_MS);
          }
        } else {
          setReturnGrantFailed(true);
        }
      })
      .finally(() => { if (!cancelled) setIsGrantingReturnAccess(false); });
    return () => {
      cancelled = true;
      controller.abort();
      if (returnGrantRetryTimerRef.current) {
        clearTimeout(returnGrantRetryTimerRef.current);
        returnGrantRetryTimerRef.current = null;
      }
      // React strict mode intentionally cleans up and re-runs effects. Release
      // ownership so the replacement effect can resume the same order instead
      // of leaving the interstitial stuck behind a stale handled marker.
      if (handledReturnOrderRef.current === orderId) {
        handledReturnOrderRef.current = null;
      }
    };
  }, [preview, hydrated, sgOrderParam, locale, returnGrantRetry]);

  useEffect(() => {
    if (preview) return;
    if (!hydrated) return;
    if (isSpecial) {
      if (!emailGatePassed || !specialSessionId) return;
      setStage('offer');
      track('oto_viewed', {
        session_id: specialSessionId,
        product: isSpecialFree ? 'special-free' : 'special-1eur',
      });
      return;
    }
    if (!isComplete || !sessionId) return;
    setStage('offer');
    track('oto_viewed', { session_id: sessionId, product: 'main' });
    if (primaryGoal) {
      fetch('/api/session/persist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, resultSegment: primaryGoal }),
      }).catch((err) => console.error('[offer-details] persist failed:', err));
    }
  }, [preview, isSpecial, isSpecialFree, emailGatePassed, specialSessionId, hydrated, isComplete, sessionId, primaryGoal, setStage, track]);

  const effectiveSessionId = isSpecial ? specialSessionId : sessionId;

  const activeCheckoutContext = (ctx: SolidgateCheckoutSuccessContext) => {
    const activeSessionId = isSpecial ? specialSessionId : sessionId;
    const productLabel = isSpecialFree ? 'special-free' : isSpecial ? 'special-1eur' : 'main';
    const { attribution, ...checkoutContext } = ctx;
    return { activeSessionId, productLabel, attribution, checkoutContext };
  };

  const authorizeAndContinue = (
    activeSessionId: string | null,
    resumeTo?: string,
  ) => {
    if (activeSessionId) {
      useQuizStore.getState().grantPurchaseAuthorization(activeSessionId);
    }
    setStage('checkout');
    router.push(resumeTo ?? '/oto/1');
  };

  const handlePayAccepted = async (ctx: SolidgateCheckoutSuccessContext) => {
    if (!selectedTier) return;
    if (payAcceptedFiredRef.current) return;
    payAcceptedFiredRef.current = true;
    const { activeSessionId, productLabel, attribution, checkoutContext } = activeCheckoutContext(ctx);
    if (activeSessionId) {
      saveMainPaymentRecovery({
        orderId: ctx.orderId,
        sessionId: activeSessionId,
        checkout: ctx,
      });
    }
    const acceptedEventId = lifecycleEventId('oto_accepted', ctx.orderId);
    track('oto_accepted', {
      ...checkoutContext,
      ...attribution,
      session_id: activeSessionId ?? undefined,
      product_category: productLabel,
      eventId: acceptedEventId,
      event_id: acceptedEventId,
      $insert_id: acceptedEventId,
    });
    authorizeAndContinue(activeSessionId, ctx.resumeTo);
  };

  const handlePaySuccess = async (ctx: SolidgateCheckoutSuccessContext) => {
    if (!selectedTier) return;
    if (paySuccessFiredRef.current) return;
    paySuccessFiredRef.current = true;
    const shouldContinue = !payAcceptedFiredRef.current;
    const { activeSessionId, productLabel, attribution, checkoutContext } = activeCheckoutContext(ctx);
    if (!payAcceptedFiredRef.current) {
      payAcceptedFiredRef.current = true;
      const acceptedEventId = lifecycleEventId('oto_accepted', ctx.orderId);
      track('oto_accepted', {
        ...checkoutContext,
        ...attribution,
        session_id: activeSessionId ?? undefined,
        product_category: productLabel,
        eventId: acceptedEventId,
        event_id: acceptedEventId,
        $insert_id: acceptedEventId,
      });
    }
    track('checkout_completed', {
      ...checkoutContext,
      ...attribution,
      session_id: activeSessionId ?? undefined,
      product_category: productLabel,
      value: purchaseEventValue(ctx.amount_cents, ctx.currency),
    });
    if (shouldContinue) authorizeAndContinue(activeSessionId, ctx.resumeTo);
  };

  if (!hydrated) return null;
  if (!preview && !isSpecial) {
    if ((!isComplete || !sessionId) && (!sgOrderParam || returnGrantFailed)) return null;
  }

  if (sgOrderParam && !returnGrantFailed && (isGrantingReturnAccess || returnGrantPending)) {
    return (
      <ReturnVerificationStatus
        message={returnGrantPending
          ? tCheckout('paymentPending')
          : tCheckout('completingVerification')}
      />
    );
  }

  return (
    <div className="lmRoot relative min-h-screen" style={{ background: 'var(--paper)' }}>
      {isSpecial && !emailGatePassed && (!sgOrderParam || returnGrantFailed) && (
        <SpecialOfferEmailGate
          source={isSpecialFree ? 'special-offer-free' : 'special-offer'}
          onSubmit={(newSessionId) => {
            setSpecialSessionId(newSessionId);
            setEmailGatePassed(true);
          }}
        />
      )}

      <div inert={isSpecial && !emailGatePassed} aria-hidden={isSpecial && !emailGatePassed}>
        <OfferSalesBody
          productId={selectedTier?.productId ?? null}
          preview={preview}
          checkoutOpen={checkoutOpen}
          onUnlock={() => {
            if (preview) {
              router.push('/preview/oto/1');
              return;
            }
            track('offer_cta_clicked', { tier: selectedTierId });
            setCheckoutOpen(true);
          }}
        />

        <OfferCheckoutModal
          open={checkoutOpen}
          tier={selectedTier}
          sessionId={effectiveSessionId}
          onClose={() => setCheckoutOpen(false)}
          onSuccess={handlePaySuccess}
          onAccepted={handlePayAccepted}
        />
      </div>
    </div>
  );
}

function ReturnVerificationStatus({ message }: { message: string }) {
  return (
    <main
      className="lmRoot min-h-screen flex items-center justify-center px-6"
      style={{ background: 'var(--paper)', color: 'var(--ink)' }}
    >
      <div role="status" aria-live="polite" className="text-center" style={{ maxWidth: 520 }}>
        <div
          aria-hidden
          className="animate-spin"
          style={{
            width: 42,
            height: 42,
            margin: '0 auto 22px',
            border: '1px solid rgba(17,17,17,0.18)',
            borderTopColor: 'var(--ink)',
            borderRadius: '50%',
          }}
        />
        <p className="body-sans" style={{ fontSize: 15, lineHeight: 1.7 }}>{message}</p>
      </div>
    </main>
  );
}
