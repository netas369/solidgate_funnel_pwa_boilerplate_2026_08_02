import { OfferDetailsPage } from '@/features/offer/components/offer-details-page';

// Preview copy of /special-offer (paid intro variant). `preview` also bypasses
// the email gate so the page chrome is visible without submitting an email.
export default function Page() {
  return <OfferDetailsPage variant="special-1eur" preview />;
}
