// Solidgate webhook signature verification (Deno + vitest, Web Crypto only).
//
// Mirrors packages/shared/src/solidgate/signature.ts, which the Next.js side
// uses — kept as a local module because Edge Functions bundle their own tree.
//
// signature = base64( hexDigest( HMAC-SHA512(secret, publicKey + rawBody + publicKey) ) )
//
// Two rules that make or break this:
//   1. Webhooks are signed with the WEBHOOK key pair (wh_pk_/wh_sk_), NOT the
//      API keys. The public key arrives in the `merchant` header.
//   2. The MAC covers the RAW body exactly as received. Parsing and
//      re-serialising the JSON first will silently change bytes and every
//      signature will fail.

const enc = new TextEncoder();

function bytesToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
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
  return btoa(bytesToHex(mac));
}

/** Timing-safe. Returns false on any mismatch rather than throwing. */
export async function verifySolidgateWebhook(params: {
  publicKey: string;
  secretKey: string;
  rawBody: string;
  signature: string;
}): Promise<boolean> {
  const { publicKey, secretKey, rawBody, signature } = params;
  if (!publicKey || !secretKey || !signature) return false;

  const expected = await signSolidgatePayload(publicKey, secretKey, rawBody);
  if (signature.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < signature.length; i++) {
    diff |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
