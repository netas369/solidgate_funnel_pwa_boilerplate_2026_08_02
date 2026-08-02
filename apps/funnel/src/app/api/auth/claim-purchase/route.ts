import { handleClaimPurchase } from "@repo/shared/auth/claim-purchase";

export const runtime = 'nodejs';

export async function POST() {
  return handleClaimPurchase();
}
