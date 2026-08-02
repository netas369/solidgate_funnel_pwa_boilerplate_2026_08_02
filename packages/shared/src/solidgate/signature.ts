// Solidgate request/webhook signature  -  Web Crypto only (Node + Deno + Edge compatible)
//
// Scheme (verified against @solidgate/node-sdk v1.4.1 source and
// https://docs.solidgate.com/payments/integrate/access-to-api/):
//   signature = base64( hexDigest( HMAC-SHA512(secretKey, publicKey + body + publicKey) ) )
// Note the unusual double encoding: the HEX STRING (not raw bytes) is base64d.
// For body-less GET requests the signed string is publicKey + publicKey.
//
// The same scheme covers both directions:
//  - outbound API calls, signed with the api_pk_/api_sk_ pair
//  - inbound webhooks, verified with the separate wh_pk_/wh_sk_ pair against
//    the RAW request body exactly as received (no re-serialization).

const enc = new TextEncoder();

function bytesToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function asciiToBase64(ascii: string): string {
  // hex digest is pure ASCII, so btoa is safe (no >0xFF code points)
  return btoa(ascii);
}

export async function signSolidgatePayload(
  publicKey: string,
  secretKey: string,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secretKey),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(publicKey + body + publicKey));
  return asciiToBase64(bytesToHex(mac));
}

/**
 * Timing-safe verification of an inbound Solidgate webhook signature.
 * Pass the RAW request body string and the `signature` header value, with the
 * WEBHOOK key pair (wh_pk_/wh_sk_), whose public key arrives in the
 * `merchant` header.
 */
export async function verifySolidgateSignature(
  publicKey: string,
  secretKey: string,
  rawBody: string,
  signature: string,
): Promise<boolean> {
  const expected = await signSolidgatePayload(publicKey, secretKey, rawBody);
  if (signature.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < signature.length; i++) {
    diff |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
