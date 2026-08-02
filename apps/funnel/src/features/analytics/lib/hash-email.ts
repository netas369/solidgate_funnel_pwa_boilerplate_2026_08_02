/**
 * SHA-256 hash of normalized email for GTM dataLayer (D-10).
 * Trims whitespace, lowercases, then hashes.
 * Never sends raw PII to dataLayer.
 */
export async function hashEmail(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
