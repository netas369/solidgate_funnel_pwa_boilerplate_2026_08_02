import { OfferDetailsPage } from '@/features/offer/components/offer-details-page';

/**
 * /offer/details  -  the sales body, the selected tier and the checkout modal.
 * Reached from /offer (the price picker) via `?tier=trial1|trial2|trial3|trial4`.
 */
export default function Page() {
  return <OfferDetailsPage variant="main" />;
}
