import { OfferPage } from '@/features/offer/components/offer-page';

// Preview copy of /offer (trial-price picker). `preview` bypasses the quiz gate
// and all side-effects; "Continue" walks to /preview/offer/details.
export default function Page() {
  return <OfferPage variant="main" preview />;
}
