'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from '@repo/i18n/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { resolveProductPrice, type Locale } from '@repo/shared/price-map';
import { useQuizStore } from '@/stores/quiz-store';
import { useFunnelStore } from '@/stores/funnel-store';
import { useQuizHydration } from '@/features/quiz/hooks/use-quiz-hydration';
import { useAnalytics } from '@/features/analytics/hooks/use-analytics';
import { checkoutProductContext } from '@/features/analytics/lib/checkout-context';
import { purchaseEventValue } from '@/features/analytics/lib/purchase-value';
import { useScrollToTop } from '@/lib/hooks/use-scroll-to-top';
import { OFFER_PRICING_TIERS, type OfferPickerId } from '../config/offer-data';
import { OfferTrialPricePicker } from './offer-sections';
import { LandingNav } from '@/app/[locale]/_components/landing/LandingNav';
import { OfferCheckoutModal } from './offer-checkout-modal';
import { SpecialOfferEmailGate } from './special-offer-email-gate';
import '@/app/[locale]/_components/landing/landing.css';

// Variant discriminator controlling OfferPage behaviour.
// 'main'         - default; the regular /offer flow (quiz gate + price picker).
// 'special-1eur' - /special-offer; short-circuits the quiz redirect and renders
//                  the email gate as a hard-block over inert page chrome.
// 'special-free' - /special-offer-free; same gating, but passes
//                  source='special-offer-free' so the session is attributed
//                  (and marketing-list handling differs) per variant.
export type OfferVariant = 'main' | 'special-1eur' | 'special-free';

export interface OfferPageProps {
  variant?: OfferVariant;
  // Preview mode: render the page UI without any quiz/purchase gating,
  // redirects, analytics or payment side-effects. Used by the /preview/*
  // review routes so the page can be inspected without a quiz or a card.
  preview?: boolean;
}

export function OfferPage({ variant = 'main', preview = false }: OfferPageProps = {}) {
  // Shared special-variant behaviour: email-gate hard-block, no quiz redirect.
  const isSpecial = variant === 'special-1eur' || variant === 'special-free';
  // Narrows to the free-trial variant — mounts the gate with
  // source='special-offer-free' and labels analytics separately.
  const isSpecialFree = variant === 'special-free';
  const t = useTranslations('offer');
  const router = useRouter();
  const hydrated = useQuizHydration();
  const isComplete = useQuizStore((s) => s.isComplete);
  const sessionId = useQuizStore((s) => s.sessionId);
  const primaryGoal = useQuizStore((s) => s.answers['primaryGoal']) as string | undefined;
  const setStage = useFunnelStore((s) => s.setStage);
  const { track } = useAnalytics();
  const locale = useLocale() as Locale;

  // Tier selection is two independent pieces:
  //   - selectedTierId: which option is highlighted. Each special variant
  //     preselects its single tier so Continue works on first render.
  //   - checkoutOpen: whether the checkout modal is mounted. Always starts
  //     false — no PaymentIntent is created on /offer mount; the order is only
  //     opened once the modal actually opens.
  const [selectedTierId, setSelectedTierId] = useState<string | null>(
    variant === 'special-1eur' ? 'special-1eur'
      : variant === 'special-free' ? 'special-free'
      : 'trial4',
  );
  const [checkoutOpen, setCheckoutOpen] = useState<boolean>(false);

  // Prevents duplicate Meta Purchase events if the checkout's onSuccess fires
  // more than once for a single charge (observed: 2 Purchases in Ads Manager).
  // Idempotent for the lifetime of this component instance.
  const paySuccessFiredRef = useRef(false);

  // The email gate is the hard-block cover for the special variants. Defaults
  // true on 'main' (no gate) and false otherwise, so the page stays inert
  // until a valid email is submitted.
  const [emailGatePassed, setEmailGatePassed] = useState<boolean>(!isSpecial || preview);

  // The email gate mints a fresh sessionId and persists it via
  // /api/session/persist. Stashed locally rather than pushed into useQuizStore
  // because the quiz flow has side-effects the special entry must not trigger.
  const [specialSessionId, setSpecialSessionId] = useState<string | null>(null);

  // Scroll-to-top on the special variants runs only once the gate passes —
  // never scroll the chrome behind the modal on first paint.
  useScrollToTop(
    hydrated && (isSpecial ? emailGatePassed && !!specialSessionId : isComplete && !!sessionId),
  );

  const selectedTier = selectedTierId
    ? OFFER_PRICING_TIERS.find((t) => t.id === selectedTierId) ?? null
    : null;

  // Short-circuit the quiz-completion redirect on the special variants: direct
  // entrants (e.g. from an abandonment email) have no completed quiz — they
  // create a fresh session through the email gate instead.
  useEffect(() => {
    if (preview) return;
    if (isSpecial) return;
    if (!hydrated) return;
    if (!isComplete || !sessionId) {
      router.replace('/quiz');
    }
  }, [preview, isSpecial, hydrated, isComplete, sessionId, router]);

  // Mount effects: funnel stage, analytics and the result_segment write.
  // On the special variants these fire once the gate passes. resultSegment is
  // not persisted there — the user never took the quiz, so primaryGoal is
  // always undefined.
  useEffect(() => {
    if (preview) return;
    if (!hydrated) return;
    if (isSpecial) {
      if (!emailGatePassed || !specialSessionId) return;
      setStage('offer');
      // Distinct product label per variant, for clean A/B analytics.
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
      }).catch((err) => {
        console.error('[offer] result_segment persist failed:', err);
      });
    }
  }, [isSpecial, isSpecialFree, emailGatePassed, specialSessionId, hydrated, isComplete, sessionId, primaryGoal, setStage, track]);

  // The sessionId used for checkout:
  //   main    - the persisted quiz sessionId from useQuizStore
  //   special - the gate-minted sessionId (null until the gate passes)
  const effectiveSessionId = isSpecial ? specialSessionId : sessionId;

  // Pay success handler — analytics, funnel advance, navigate. The Solidgate
  // checkout grants server-side before onSuccess fires; the webhook backstops.
  const handlePaySuccess = async () => {
    // Defensive: handlePaySuccess can only fire once the checkout is mounted,
    // which requires a selected tier. Bail if somehow invoked without one.
    if (!selectedTier) return;
    if (paySuccessFiredRef.current) return;
    paySuccessFiredRef.current = true;
    const activeSessionId = isSpecial ? specialSessionId : sessionId;
    const productLabel = isSpecialFree
      ? 'special-free'
      : isSpecial
        ? 'special-1eur'
        : 'main';
    track('oto_accepted', { session_id: activeSessionId ?? undefined, product: productLabel });
    const tierPrice = resolveProductPrice(selectedTier.productId, locale);
    track('checkout_completed', {
      session_id: activeSessionId ?? undefined,
      amount_cents: tierPrice.amountCents,
      product: selectedTier.productId,
      product_category: productLabel,
      value: purchaseEventValue(tierPrice.amountCents, tierPrice.currency),
      currency: tierPrice.currency.toUpperCase(),
    });

    // On the special path the user never completed the quiz, so useQuizStore
    // has isComplete=false + sessionId=null. Promote the gate-minted sessionId
    // into the store and set authorizedViaPurchase=true so the downstream OTO
    // guards accept them. grantPurchaseAuthorization does both atomically, so
    // the guards never observe a half-authorised state on the next mount.
    // getState() rather than a hook-subscribed action: this is a callback and
    // must not resubscribe the component.
    if (isSpecial && specialSessionId) {
      useQuizStore.getState().grantPurchaseAuthorization(specialSessionId);
    }

    setStage('checkout');
    router.push('/oto/1');
  };

  // Render gates differ by variant.
  //   main    - wait for hydration + quiz completion + sessionId.
  //   special - render as soon as hydrated so the email gate is visible; the
  //             chrome behind it stays inert until the gate passes.
  if (!hydrated) return null;
  if (!preview && !isSpecial) {
    if (!isComplete || !sessionId) return null;
  }

  return (
    <div className="lmRoot relative min-h-screen" style={{ background: 'var(--paper)' }}>
      <LandingNav minimal />
      {/* Hard-block email gate. It is a fixed-position overlay, and the page
          chrome below is wrapped in an inert container so keyboard focus and
          pointer events cannot reach it while the gate is visible. */}
      {isSpecial && !emailGatePassed && (
        <SpecialOfferEmailGate
          source={isSpecialFree ? 'special-offer-free' : 'special-offer'}
          onSubmit={(newSessionId) => {
            setSpecialSessionId(newSessionId);
            setEmailGatePassed(true);
          }}
        />
      )}

      {/* React 19 supports `inert` as a boolean prop — negate the gate state so
          the chrome becomes interactive after submit. */}
      <div inert={isSpecial && !emailGatePassed} aria-hidden={isSpecial && !emailGatePassed}>
        {/* /offer renders only the price picker; the sales body, the tier
            detail and the checkout modal all live on /offer/details. */}
        <div id="lm-price-picker">
          <OfferTrialPricePicker
            selectedId={(selectedTierId as OfferPickerId) ?? 'trial4'}
            onSelect={(id) => {
              setSelectedTierId(id);
              if (!preview) {
                const selected = OFFER_PRICING_TIERS.find((tier) => tier.id === id);
                track('tier_selected', {
                  session_id: effectiveSessionId ?? undefined,
                  ...(selected
                    ? (checkoutProductContext(selected.productId, locale) ?? {
                        product: selected.productId,
                      })
                    : { product: id }),
                });
              }
            }}
            onContinue={() => {
              if (preview) {
                router.push(`/preview/offer/details?tier=${encodeURIComponent(selectedTierId ?? 'trial4')}`);
                return;
              }
              track('offer_cta_clicked', { tier: selectedTierId });
              router.push(`/offer/details?tier=${encodeURIComponent(selectedTierId ?? 'trial4')}`);
            }}
          />
        </div>
      </div>
    </div>
  );
}
