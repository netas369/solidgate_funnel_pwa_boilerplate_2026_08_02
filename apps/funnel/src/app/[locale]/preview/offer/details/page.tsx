import { OfferDetailsPage } from '@/features/offer/components/offer-details-page';

// Preview copy of /offer/details (sales body + checkout). `preview` bypasses
// the quiz gate and every side-effect; the CTA walks to /preview/oto/1 instead
// of opening the payment form.
export default function Page() {
  return <OfferDetailsPage variant="main" preview />;
}
