/**
 * Email capture consent version. Bump when consent text wording changes
 * to enable re-prompting users who consented to an older version.
 */
export const EMAIL_CONSENT_VERSION = '1.0';

/** Data shape passed from EmailCaptureStep through to the persistence layer. */
export interface EmailConsentData {
  email: string;
  consentGivenAt: string;
  consentVersion: string;
  marketingConsent: boolean;
}
