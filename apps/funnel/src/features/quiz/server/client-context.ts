import { isIP } from 'node:net';
import type { Json } from '@repo/shared/types/database';

export type QuizDeviceType = 'desktop' | 'mobile' | 'tablet' | 'unknown';

function cleanHeader(value: string | null, maxLength = 255): string | null {
  if (!value) return null;
  const cleaned = value.trim().replace(/^"|"$/g, '');
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function decodedHeader(value: string | null, maxLength = 255): string | null {
  const cleaned = cleanHeader(value, maxLength);
  if (!cleaned) return null;
  try {
    return decodeURIComponent(cleaned).slice(0, maxLength);
  } catch {
    return cleaned;
  }
}

export function classifyDeviceType(
  userAgent: string,
  mobileHint?: string | null,
): QuizDeviceType {
  // iPadOS can identify as Macintosh, but still exposes Mobile in its UA.
  if (
    /ipad|tablet|playbook|silk|kindle/i.test(userAgent) ||
    (/android/i.test(userAgent) && !/mobile/i.test(userAgent)) ||
    (/macintosh/i.test(userAgent) && /mobile/i.test(userAgent))
  ) {
    return 'tablet';
  }
  if (mobileHint?.trim() === '?1' || /mobile|iphone|ipod|android/i.test(userAgent)) {
    return 'mobile';
  }
  return userAgent ? 'desktop' : 'unknown';
}

export function detectBrowser(userAgent: string): string {
  if (/edg\//i.test(userAgent)) return 'Edge';
  if (/opr\//i.test(userAgent)) return 'Opera';
  if (/samsungbrowser\//i.test(userAgent)) return 'Samsung Internet';
  if (/chrome\/|crios\//i.test(userAgent)) return 'Chrome';
  if (/firefox\/|fxios\//i.test(userAgent)) return 'Firefox';
  if (/safari\//i.test(userAgent)) return 'Safari';
  return 'unknown';
}

export function extractPublicClientIp(headers: Headers): string | null {
  const candidates = [
    headers.get('x-vercel-forwarded-for'),
    headers.get('x-forwarded-for')?.split(',')[0] ?? null,
    headers.get('cf-connecting-ip'),
    headers.get('x-real-ip'),
  ];
  for (const candidate of candidates) {
    const value = cleanHeader(candidate, 64);
    if (value && isIP(value)) return value;
  }
  return null;
}

function countryCode(headers: Headers): string | null {
  const value = cleanHeader(
    headers.get('x-vercel-ip-country') ?? headers.get('cf-ipcountry'),
    8,
  )?.toUpperCase();
  return value && /^[A-Z]{2}$/.test(value) && value !== 'XX' ? value : null;
}

/**
 * Server-observed request context saved with the quiz session. The IP is the
 * public request IP visible to the deployment platform, not a device LAN IP;
 * VPNs, carrier NAT and proxies can affect it.
 */
export function buildQuizClientContext(request: Request): Json {
  const userAgent = cleanHeader(request.headers.get('user-agent'), 1024) ?? '';
  const language = cleanHeader(request.headers.get('accept-language'))?.split(',')[0] ?? null;

  return {
    device_type: classifyDeviceType(userAgent, request.headers.get('sec-ch-ua-mobile')),
    browser: detectBrowser(userAgent),
    platform: cleanHeader(request.headers.get('sec-ch-ua-platform')),
    browser_language: language,
    country: countryCode(request.headers),
    region: cleanHeader(request.headers.get('x-vercel-ip-country-region')),
    city: decodedHeader(request.headers.get('x-vercel-ip-city')),
    timezone: cleanHeader(request.headers.get('x-vercel-ip-timezone')),
    ip_address: extractPublicClientIp(request.headers),
    user_agent: userAgent || null,
  };
}
