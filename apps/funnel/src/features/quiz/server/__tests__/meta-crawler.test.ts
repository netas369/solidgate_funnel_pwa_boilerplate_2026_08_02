import { describe, expect, it } from 'vitest';
import { isKnownMetaCrawler } from '../meta-crawler';

describe('isKnownMetaCrawler', () => {
  it.each([
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'meta-webindexer/1.1',
    'meta-externalads/1.1',
    'meta-externalagent/1.1',
    'meta-externalfetcher/1.1',
    'Facebot',
  ])('recognizes Meta crawler UA %s', (userAgent) => {
    expect(isKnownMetaCrawler(userAgent)).toBe(true);
  });

  it.each([
    'Mozilla/5.0 (Linux; Android 14) Mobile Safari/537.36 [FBAN/FB4A;FBAV/500.0.0.0]',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Instagram 350.0.0.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit Mobile Safari',
    null,
  ])('does not classify a real or unknown browser UA %s as a crawler', (userAgent) => {
    expect(isKnownMetaCrawler(userAgent)).toBe(false);
  });
});
