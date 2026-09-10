import { describe, expect, it } from 'vitest';
import {
  buildQuizClientContext,
  classifyDeviceType,
  detectBrowser,
  extractPublicClientIp,
} from '../client-context';

describe('quiz client context', () => {
  it('classifies mobile, tablet and desktop user agents', () => {
    expect(classifyDeviceType('Mozilla/5.0 (iPhone) Mobile Safari')).toBe('mobile');
    expect(classifyDeviceType('Mozilla/5.0 (Linux; Android 14; Pixel Tablet) Safari')).toBe(
      'tablet',
    );
    expect(classifyDeviceType('Mozilla/5.0 (Macintosh) Chrome/140.0')).toBe('desktop');
    expect(classifyDeviceType('', '?1')).toBe('mobile');
  });

  it('recognizes common browsers without classifying Edge as Chrome', () => {
    expect(detectBrowser('Chrome/140.0 Safari/537.36 Edg/140.0')).toBe('Edge');
    expect(detectBrowser('Version/18.0 Mobile Safari/604.1')).toBe('Safari');
    expect(detectBrowser('SamsungBrowser/28.0 Chrome/130.0')).toBe('Samsung Internet');
  });

  it('uses the first valid public request IP header and rejects malformed values', () => {
    expect(
      extractPublicClientIp(
        new Headers({ 'x-forwarded-for': '203.0.113.12, 10.0.0.1' }),
      ),
    ).toBe('203.0.113.12');
    expect(extractPublicClientIp(new Headers({ 'x-forwarded-for': 'not-an-ip' }))).toBeNull();
  });

  it('builds deployment-observed device and geolocation context', () => {
    const context = buildQuizClientContext(
      new Request('https://funnel.example/quiz', {
        headers: {
          'user-agent': 'Mozilla/5.0 (iPhone) Mobile Safari/604.1',
          'accept-language': 'lt-LT,lt;q=0.9,en;q=0.8',
          'sec-ch-ua-platform': '"iOS"',
          'x-forwarded-for': '203.0.113.12',
          'x-vercel-ip-country': 'lt',
          'x-vercel-ip-country-region': 'VL',
          'x-vercel-ip-city': 'Vilnius',
          'x-vercel-ip-timezone': 'Europe/Vilnius',
        },
      }),
    );

    expect(context).toMatchObject({
      device_type: 'mobile',
      browser: 'Safari',
      platform: 'iOS',
      browser_language: 'lt-LT',
      country: 'LT',
      region: 'VL',
      city: 'Vilnius',
      timezone: 'Europe/Vilnius',
      ip_address: '203.0.113.12',
    });
  });
});
