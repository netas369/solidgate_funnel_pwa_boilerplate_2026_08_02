/**
 * Meta publishes distinct User-Agent product tokens for its crawlers. Match
 * only those tokens: Facebook/Instagram in-app browsers are real visitors and
 * commonly contain FBAN, FBAV, or Instagram instead.
 *
 * User-Agent classification is an analytics-quality filter, not an
 * authorization boundary. Quiz reads and writes still require their normal
 * signed-session or authenticated-owner credential.
 */
const META_CRAWLER_USER_AGENT_TOKENS = [
  'facebookexternalhit',
  'meta-webindexer',
  'meta-externalads',
  'meta-externalagent',
  'meta-externalfetcher',
  // Legacy Meta crawler token still present in older link-preview traffic.
  'facebot',
] as const;

export function isKnownMetaCrawler(userAgent: string | null): boolean {
  if (!userAgent) return false;
  const normalized = userAgent.toLowerCase();
  return META_CRAWLER_USER_AGENT_TOKENS.some((token) => normalized.includes(token));
}
