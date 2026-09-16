// Solidgate integration primitives. Web Crypto + native fetch only — runs in
// Node route handlers, Deno Edge Functions, and Edge runtime alike.

export { signSolidgatePayload, verifySolidgateSignature } from './signature';
export {
  buildFormMerchantData,
  encryptPaymentIntent,
  type SolidgateMerchantData,
  type SolidgatePaymentIntent,
} from './form';
export {
  SolidgateClient,
  SolidgateApiError,
  getSolidgateKeys,
  SOLIDGATE_HOSTS,
  type SolidgateHost,
  type SolidgateKeys,
} from './client';
export {
  buildSolidgateOrderId,
  parseSolidgateOrderId,
  SOLIDGATE_ORDER_ID_MAX,
  type ParsedSolidgateOrderId,
} from './order-id';
export {
  chargeSavedCard,
  classifySolidgatePayment,
  resolveSolidgateVerifyUrl,
  solidgateCapturedAmount,
  subscribeSavedCard,
  type SolidgateCaptureState,
  type SolidgateChargeResult,
  type SolidgateOrderPaymentState,
  type SolidgatePaymentDecision,
  type SolidgateRecurringPaymentType,
  type SolidgateTransactionPaymentState,
  type SolidgateVerifyUrlResolution,
} from './oto';
export {
  SOLIDGATE_DECLINE_REASONS,
  solidgateDeclineReason,
  solidgateDeclineReasonFromStatusError,
  type SolidgateDeclineReason,
} from './decline-reason';
export {
  SOLIDGATE_ORIGINAL_PAYMENT_METHODS,
  parseSolidgateOriginalPaymentMethod,
  paymentTypeForOriginalPaymentMethod,
  type SolidgateOriginalPaymentMethod,
  type SolidgateReusablePaymentType,
} from './payment-method';
export {
  getAccountVault,
  upsertAccountVault,
  promoteSessionVaultToAccount,
  type SolidgateAccountVault,
} from './account-vault';
export {
  currentPaymentEnvironment,
  paymentEnvironmentForVercel,
  type PaymentEnvironment,
} from '../payment-environment';
export {
  SOLIDGATE_CONFIRM_GRANTABLE_ORDER_STATUSES,
  solidgateGrantBlockReason,
  type SolidgateGrantBlockReason,
  type SolidgateGrantEntitlementState,
  type SolidgateGrantOrderState,
} from './grant-replay';
export {
  introOfferEmailHash,
  introOfferConsumeGranted,
  introOfferConsumeNeedsRefund,
  type IntroOfferClaimResult,
  type IntroOfferConsumeResult,
} from './intro-offer';

export { persistSolidgatePartialCapture } from './partial-capture';
