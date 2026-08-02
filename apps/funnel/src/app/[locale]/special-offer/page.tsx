import { OfferDetailsPage } from '@/features/offer/components/offer-details-page';

/**
 * Preconnect to the Solidgate white-label domain so the DNS + TLS handshake
 * completes while the buyer reads the page. By the time they open checkout the
 * browser already has warm connections for the hosted form's SDK and iframe.
 * Real, measured win — keep it.
 */
function SolidgatePreconnectHints() {
  return <link rel="preconnect" href="https://cdn.charge-auth.com" />;
}

/**
 * Standalone /[locale]/special-offer landing page (paid intro variant).
 *
 * Reuses OfferDetailsPage with variant='special-1eur'. The variant:
 *   - short-circuits the quiz-completion redirect (direct entrants from an
 *     abandonment email have no quiz session)
 *   - renders SpecialOfferEmailGate as a hard-block over inert page chrome
 *   - selects the single `special_1eur` tier
 *
 * The full OTO chain (/oto/1 → /oto/8) runs unchanged after the purchase.
 *
 * Deliberately NOT in the isFunnelRoute list in `src/proxy.ts`: this page is
 * stateless, so an authenticated paying visitor is not bounced to /dashboard.
 */
export default function SpecialOfferPage() {
  return (
    <>
      <SolidgatePreconnectHints />
      <OfferDetailsPage variant="special-1eur" />
    </>
  );
}
