/**
 * ─── TODO(new product): THIS IS NOT LEGAL ADVICE ────────────────────────────
 *
 * Every value rendered by the (legal) routes is placeholder text shipped with
 * the boilerplate. Before you take a single payment you MUST replace, at
 * minimum, all of the following in `packages/i18n/messages/en/legal.json`:
 *
 *   documents.contactData.companyName / .address / .email / .privacyEmail
 *   documents.privacyPolicyData.controllerIdentity.*
 *   documents.moneyBackData.*        - the refund window and its exclusions
 *   documents.subscriptionData.*     - renewal interval and cancellation route
 *   documents.privacyPolicyData.thirdParties[] - the processors YOU actually use
 *
 * The shipped third-party inventory (payment provider, analytics, email, CDN,
 * database) describes THIS boilerplate's stack. It is a starting point, not an
 * audit of your deployment. The refund window stated here must match the one
 * stated on the offer page and the money-back seal.
 *
 * Have all of it reviewed by a qualified lawyer for your jurisdiction and your
 * product. This file only defines the SHAPE of the documents.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { getMessages } from "@repo/i18n/messages";

export interface LegalSection {
  id: string;
  title: string;
  content: string[];
  list?: string[];
  postList?: string[];
}

export interface DataInventoryRow {
  category: string;
  fields: string;
  purpose: string;
  legalBasis: string;
  retention: string;
}

export interface ThirdPartyRow {
  name: string;
  role: string;
  dataShared: string;
  location: string;
  transferMechanism: string;
}

export interface CookieRow {
  name: string;
  provider: string;
  purpose: string;
  type: string;
  essential: boolean;
  duration: string;
}

export interface PrivacyPolicyData {
  lastUpdated: string;
  controllerIdentity: { name: string; address: string; email: string };
  dataInventory: DataInventoryRow[];
  thirdParties: ThirdPartyRow[];
  sections: LegalSection[];
}

export interface TermsData {
  lastUpdated: string;
  sections: LegalSection[];
}

export interface SubscriptionData {
  lastUpdated: string;
  sections: LegalSection[];
}

export interface MoneyBackData {
  lastUpdated: string;
  sections: LegalSection[];
}

export interface CookiePolicyData {
  lastUpdated: string;
  cookies: CookieRow[];
  sections: LegalSection[];
}

export interface ContactData {
  companyName: string;
  address: string;
  email: string;
  privacyEmail: string;
  supervisoryAuthority: { name: string; website: string };
}

export interface LegalDocuments {
  privacyPolicyData: PrivacyPolicyData;
  termsData: TermsData;
  subscriptionData: SubscriptionData;
  moneyBackData: MoneyBackData;
  cookiePolicyData: CookiePolicyData;
  contactData: ContactData;
}

interface LegalMessagesNamespace {
  documents?: LegalDocuments;
}

export async function getLegalDocuments(locale: string): Promise<LegalDocuments> {
  const messages = await getMessages(locale, ["legal"]);
  const legal = messages.legal as LegalMessagesNamespace | undefined;

  if (!legal?.documents) {
    throw new Error(`Missing legal.documents for locale "${locale}"`);
  }

  return legal.documents;
}
