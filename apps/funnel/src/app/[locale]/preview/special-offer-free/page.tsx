import { OfferDetailsPage } from '@/features/offer/components/offer-details-page';

// Preview copy of /special-offer-free (free trial). `preview` also bypasses the
// email gate so the page chrome is visible without submitting an email.
export default function Page() {
  return <OfferDetailsPage variant="special-free" preview />;
}
