import { OfferDetailsPage } from '@/features/offer/components/offer-details-page';

/**
 * Preconnect to the Solidgate white-label domain — see /special-offer.
 */
function SolidgatePreconnectHints() {
  return <link rel="preconnect" href="https://cdn.charge-auth.com" />;
}

/**
 * Standalone /[locale]/special-offer-free landing page (free-trial variant).
 *
 * Reuses OfferDetailsPage with variant='special-free'. Same gating as
 * /special-offer, but the email gate is mounted with
 * source='special-offer-free' so sessions are attributed per variant, and the
 * selected tier is `special_free`.
 *
 * The OTO chain runs unchanged afterwards: the card is vaulted during the
 * trial authorization, so the one-click charges still work.
 *
 * Deliberately NOT in the isFunnelRoute list in `src/proxy.ts` — same
 * stateless-page reasoning as /special-offer.
 */
export default function SpecialOfferFreePage() {
  return (
    <>
      <SolidgatePreconnectHints />
      <OfferDetailsPage variant="special-free" />
    </>
  );
}
