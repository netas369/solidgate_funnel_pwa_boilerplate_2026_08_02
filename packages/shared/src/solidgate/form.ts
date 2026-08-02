// Solidgate Payment Form merchantData builder  -  Web Crypto only
//
// The form takes no API round-trip: the server encrypts the paymentIntent JSON
// locally and hands { merchant, signature, paymentIntent } to the browser SDK.
// Spec (verified against @solidgate/node-sdk v1.4.1 formMerchantData and
// https://docs.solidgate.com/payments/integrate/payment-form/create-your-payment-form/):
//   - AES-256-CBC, key = first 32 ASCII chars of the secret key
//   - random 16-byte IV, output = base64(IV + ciphertext) with '+'->'-', '/'->'_'
//     ('=' padding KEPT  -  this is not strict base64url)
//   - signature = standard Solidgate HMAC over the ENCRYPTED string
//
// Reimplemented here (rather than using @solidgate/node-sdk) because the sdk's
// HTTP layer depends on node-fetch v2, which breaks under Turbopack bundling,
// and its crypto is CJS/crypto-js  -  this version runs in Node, Deno, and Edge.

import { signSolidgatePayload } from './signature';

const enc = new TextEncoder();

export interface SolidgateMerchantData {
  merchant: string;
  signature: string;
  paymentIntent: string;
}

/** Payment intent fields per docs; server-authoritative, never client-built. */
export type SolidgatePaymentIntent = Record<string, unknown> & {
  order_id: string;
  order_description: string;
  amount: number;
  currency: string;
};

function bytesToSolidgateBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_');
}

export async function encryptPaymentIntent(
  secretKey: string,
  paymentIntent: SolidgatePaymentIntent,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secretKey.substring(0, 32)),
    { name: 'AES-CBC' },
    false,
    ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv },
    key,
    enc.encode(JSON.stringify(paymentIntent)),
  );
  const out = new Uint8Array(iv.length + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), iv.length);
  return bytesToSolidgateBase64(out);
}

/**
 * Build the merchantData object consumed by @solidgate/react-sdk's <Payment>
 * (and the raw client SDK). Which environment (sandbox vs live) the form talks
 * to is decided solely by which channel's keys sign this payload.
 */
export async function buildFormMerchantData(
  publicKey: string,
  secretKey: string,
  paymentIntent: SolidgatePaymentIntent,
): Promise<SolidgateMerchantData> {
  const encrypted = await encryptPaymentIntent(secretKey, paymentIntent);
  return {
    merchant: publicKey,
    signature: await signSolidgatePayload(publicKey, secretKey, encrypted),
    paymentIntent: encrypted,
  };
}
