// Dynamic billing descriptor (Solidgate).
//
// The channel's BASE descriptor is static, set by Solidgate/the acquirer
// (proposed with the AM: `APP/:`). Per payment we append
// `dynamic_descriptor.suffix`; the cardholder's statement shows base+suffix,
// e.g. `APP/:*ACME`. This avoids mailing a new descriptor for every offer
// descriptor list to the provider every couple of weeks — the suffix is ours
// to set in code.
//
// Hard constraints (SchemaCardsDynamicDescriptor in the OpenAPI spec):
// 1–10 chars, ASCII printable minus `^` (pattern ^[\x20-\x5D\x5F-\x7E]+$).
// Cards + PayPal only; other APMs ignore it.
//
// ONLY cardholder-present requests take the field: the hosted form's
// paymentIntent, /charge, wallets, /resign. POST /recurring REJECTS it
// outright (2.01 "Invalid request body", sandbox-verified 2026-07-13, and the
// spec's three Recurring schemas all lack it) — so one-click OTO charges and
// Solidgate-initiated rebills show the channel's base descriptor (whether
// they inherit the initial charge's suffix is an open AM question,
// docs/solidgate/am-email.md Q9).
//
// These strings are CARDHOLDER-facing: their whole job is to make the
// statement line recognizable so the buyer doesn't dispute it. The main
// subscription carries the brand itself.

import { SOLIDGATE_PRODUCT_CODES } from './catalog';

/**
 * Offering code → statement suffix (≤10 ASCII chars, no `^`).
 * TODO(new product): these are placeholders — make each one something a buyer
 * recognises on a bank statement, or they will dispute the charge.
 */
export const SOLIDGATE_DESCRIPTOR_SUFFIXES: Record<string, string> = {
  [SOLIDGATE_PRODUCT_CODES.main]: 'ACME',
  [SOLIDGATE_PRODUCT_CODES.lifetime]: 'LIFETIME',
  [SOLIDGATE_PRODUCT_CODES.addon]: 'ADDON',
  [SOLIDGATE_PRODUCT_CODES.bundleAll]: 'BUNDLE',
  [SOLIDGATE_PRODUCT_CODES.bundle1]: 'BUNDLE1',
  [SOLIDGATE_PRODUCT_CODES.bundle2]: 'BUNDLE2',
  [SOLIDGATE_PRODUCT_CODES.bundle3]: 'BUNDLE3',
  [SOLIDGATE_PRODUCT_CODES.pdf4]: 'PDF4',
  [SOLIDGATE_PRODUCT_CODES.pdf5]: 'PDF5',
  [SOLIDGATE_PRODUCT_CODES.pdf6]: 'PDF6',
  [SOLIDGATE_PRODUCT_CODES.pdf7]: 'PDF7',
};

/**
 * The `dynamic_descriptor` object for a CARDHOLDER-PRESENT payment request
 * (form paymentIntent, /charge — NEVER /recurring, which rejects the field),
 * or undefined for codes with no mapping.
 */
export function solidgateDynamicDescriptor(
  productCode: string,
): { suffix: string } | undefined {
  const suffix = SOLIDGATE_DESCRIPTOR_SUFFIXES[productCode];
  return suffix ? { suffix } : undefined;
}
