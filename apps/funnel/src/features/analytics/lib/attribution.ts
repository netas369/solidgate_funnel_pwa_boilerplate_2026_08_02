/**
 * Browser-side campaign attribution shared by PostHog, GTM and checkout.
 *
 * The first touch never changes during a funnel tab session. The last touch is
 * replaced only when a URL contains a campaign/click identifier, so normal
 * client-side navigation does not turn an internal page into the referrer.
 */

export const UTM_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
] as const;

export const CLICK_ID_KEYS = [
  'fbclid',
  'gclid',
  'gbraid',
  'wbraid',
  'ttclid',
  'msclkid',
] as const;

export type UtmKey = (typeof UTM_KEYS)[number];
export type ClickIdKey = (typeof CLICK_ID_KEYS)[number];

export type AttributionTouch = Partial<Record<UtmKey | ClickIdKey, string>> & {
  landing_url?: string;
  referrer?: string;
  captured_at?: string;
};

export interface AttributionSnapshot {
  first_touch: AttributionTouch;
  last_touch: AttributionTouch;
  fbc?: string;
  fbp?: string;
}

export const FUNNEL_SOURCES = [
  'quiz',
  'main',
  'advertorial',
  'special-offer',
  'special-offer-free',
] as const;
export type FunnelSource = (typeof FUNNEL_SOURCES)[number];

const ATTRIBUTION_STORAGE_KEY = 'funnel_attribution_v1';
const FUNNEL_SOURCE_STORAGE_KEY = 'funnel_entry_source_v1';
const LEGACY_UTM_STORAGE_KEY = 'funnel_utm';
const MAX_VALUE_LENGTH = 380;
const FBC_COOKIE = '_fbc';
const FBP_COOKIE = '_fbp';

const TOUCH_KEYS = [
  ...UTM_KEYS,
  ...CLICK_ID_KEYS,
  'landing_url',
  'referrer',
  'captured_at',
] as const;

function cleanValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_VALUE_LENGTH) : undefined;
}

function isFunnelSource(value: string | null): value is FunnelSource {
  return FUNNEL_SOURCES.includes(value as FunnelSource);
}

function sourceFromPath(pathname: string): FunnelSource | null {
  const path = pathname.toLowerCase();
  if (path.includes('special-offer-free')) return 'special-offer-free';
  if (path.includes('special-offer')) return 'special-offer';
  if (path.includes('advertorial')) return 'advertorial';
  // The standard main landing is `/` or a single locale segment such as `/lt`.
  if (/^\/(?:[a-z]{2}(?:-[a-z]{2})?)?\/?$/.test(path)) return 'main';
  return null;
}

export function resolveFunnelSource(input: {
  search: string;
  pathname: string;
  referrer?: string;
  origin: string;
}): FunnelSource {
  const params = new URLSearchParams(input.search);
  const explicit = params.get('funnel_source') ?? params.get('source');
  if (isFunnelSource(explicit)) return explicit;

  const currentPathSource = sourceFromPath(input.pathname);
  if (currentPathSource && currentPathSource !== 'main') return currentPathSource;
  if (input.referrer) {
    try {
      const referrer = new URL(input.referrer);
      if (referrer.origin === input.origin) return sourceFromPath(referrer.pathname) ?? 'quiz';
    } catch {
      // Fall through to the direct-quiz default.
    }
  }
  return 'quiz';
}

/**
 * Resolve and retain the first internal entry route for this browser tab.
 * Campaign providers remain in UTM fields; `source` describes which funnel
 * surface sent the visitor into the quiz.
 */
export function captureFunnelSource(): FunnelSource {
  if (typeof window === 'undefined') return 'quiz';
  try {
    const stored = window.sessionStorage.getItem(FUNNEL_SOURCE_STORAGE_KEY);
    if (isFunnelSource(stored)) return stored;

    const source = resolveFunnelSource({
      search: window.location.search,
      pathname: window.location.pathname,
      referrer: typeof document !== 'undefined' ? document.referrer : undefined,
      origin: window.location.origin,
    });
    window.sessionStorage.setItem(FUNNEL_SOURCE_STORAGE_KEY, source);
    return source;
  } catch {
    return 'quiz';
  }
}

function sanitizeTouch(input: unknown): AttributionTouch {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const record = input as Record<string, unknown>;
  const touch: AttributionTouch = {};
  for (const key of TOUCH_KEYS) {
    const value = cleanValue(record[key]);
    if (value) touch[key] = value;
  }
  return touch;
}

/** Validate an untrusted checkout payload before it is used as PSP metadata. */
export function sanitizeAttributionSnapshot(input: unknown): AttributionSnapshot | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const firstTouch = sanitizeTouch(record.first_touch);
  const lastTouch = sanitizeTouch(record.last_touch);
  if (Object.keys(firstTouch).length === 0 && Object.keys(lastTouch).length === 0) return null;
  const fbc = cleanValue(record.fbc);
  const fbp = cleanValue(record.fbp);
  return {
    first_touch: Object.keys(firstTouch).length > 0 ? firstTouch : lastTouch,
    last_touch: Object.keys(lastTouch).length > 0 ? lastTouch : firstTouch,
    ...(fbc ? { fbc } : {}),
    ...(fbp ? { fbp } : {}),
  };
}

function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie.split('; ').find((row) => row.startsWith(`${name}=`));
  if (!match) return undefined;
  try {
    return cleanValue(decodeURIComponent(match.slice(name.length + 1)));
  } catch {
    return cleanValue(match.slice(name.length + 1));
  }
}

/** Keep campaign parameters but discard unrelated/sensitive query fields. */
function canonicalLandingUrl(location: Location): string {
  const url = new URL(location.href);
  const filtered = new URLSearchParams();
  for (const key of [...UTM_KEYS, ...CLICK_ID_KEYS]) {
    const value = url.searchParams.get(key);
    if (value) filtered.set(key, value);
  }
  url.search = filtered.toString();
  url.hash = '';
  return url.toString().slice(0, MAX_VALUE_LENGTH);
}

function canonicalReferrer(value: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    return cleanValue(url.toString());
  } catch {
    return cleanValue(value);
  }
}

function currentTouch(): AttributionTouch {
  const params = new URLSearchParams(window.location.search);
  const touch: AttributionTouch = {
    landing_url: canonicalLandingUrl(window.location),
    captured_at: new Date().toISOString(),
  };
  const referrer = canonicalReferrer(document.referrer);
  if (referrer) touch.referrer = referrer;
  for (const key of [...UTM_KEYS, ...CLICK_ID_KEYS]) {
    const value = cleanValue(params.get(key));
    if (value) touch[key] = value;
  }
  return touch;
}

function hasCampaignSignal(touch: AttributionTouch): boolean {
  return [...UTM_KEYS, ...CLICK_ID_KEYS].some((key) => Boolean(touch[key]));
}

function readStoredSnapshot(): AttributionSnapshot | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(ATTRIBUTION_STORAGE_KEY);
    return raw ? sanitizeAttributionSnapshot(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function withMetaCookies(snapshot: AttributionSnapshot): AttributionSnapshot {
  const fbc = readCookie(FBC_COOKIE) ?? snapshot.fbc;
  const fbp = readCookie(FBP_COOKIE) ?? snapshot.fbp;
  return {
    ...snapshot,
    ...(fbc ? { fbc } : {}),
    ...(fbp ? { fbp } : {}),
  };
}

/** Capture the current landing/campaign touch and return the full snapshot. */
export function captureAttributionParams(): AttributionSnapshot | null {
  if (typeof window === 'undefined') return null;
  const touch = currentTouch();
  const stored = readStoredSnapshot();
  const snapshot = withMetaCookies({
    first_touch: stored?.first_touch ?? touch,
    last_touch: !stored || hasCampaignSignal(touch) ? touch : stored.last_touch,
    ...(stored?.fbc ? { fbc: stored.fbc } : {}),
    ...(stored?.fbp ? { fbp: stored.fbp } : {}),
  });

  try {
    window.sessionStorage.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify(snapshot));
    // Keep the old first-touch UTM mirror while legacy consumers are phased out.
    const firstUtm = selectFirstTouchUtm(snapshot);
    if (Object.keys(firstUtm).length > 0) {
      window.sessionStorage.setItem(LEGACY_UTM_STORAGE_KEY, JSON.stringify(firstUtm));
    }
  } catch {
    // Private mode/quota failures must never interrupt the funnel.
  }
  return snapshot;
}

/** Read attribution for checkout; lazily captures if the provider did not run. */
export function readStoredAttribution(): AttributionSnapshot | null {
  if (typeof window === 'undefined') return null;
  const stored = readStoredSnapshot();
  if (!stored) return captureAttributionParams();
  return withMetaCookies(stored);
}

export function selectFirstTouchUtm(
  snapshot: AttributionSnapshot | null,
): Partial<Record<UtmKey, string>> {
  const utm: Partial<Record<UtmKey, string>> = {};
  if (!snapshot) return utm;
  for (const key of UTM_KEYS) {
    const value = snapshot.first_touch[key];
    if (value) utm[key] = value;
  }
  return utm;
}

/** Flattened event properties understood by PostHog, GTM and the data team. */
export function attributionEventProperties(
  snapshot: AttributionSnapshot | null = readStoredAttribution(),
): Record<string, string> {
  if (!snapshot) return {};
  const properties: Record<string, string> = {};
  for (const key of UTM_KEYS) {
    const first = snapshot.first_touch[key];
    const last = snapshot.last_touch[key];
    // Backwards-compatible bare UTM fields retain the original first-touch rule.
    if (first) properties[key] = first;
    if (first) properties[`first_touch_${key}`] = first;
    if (last) properties[`last_touch_${key}`] = last;
  }
  for (const key of CLICK_ID_KEYS) {
    const first = snapshot.first_touch[key];
    const last = snapshot.last_touch[key];
    if (last ?? first) properties[key] = (last ?? first)!;
    if (first) properties[`first_touch_${key}`] = first;
    if (last) properties[`last_touch_${key}`] = last;
  }
  const landingUrl = snapshot.first_touch.landing_url;
  const referrer = snapshot.first_touch.referrer;
  if (landingUrl) properties.landing_url = landingUrl;
  if (referrer) properties.referrer = referrer;
  if (landingUrl) properties.first_touch_landing_url = landingUrl;
  if (referrer) properties.first_touch_referrer = referrer;
  if (snapshot.last_touch.landing_url) {
    properties.last_touch_landing_url = snapshot.last_touch.landing_url;
  }
  if (snapshot.last_touch.referrer) properties.last_touch_referrer = snapshot.last_touch.referrer;
  if (snapshot.first_touch.captured_at) properties.first_touch_at = snapshot.first_touch.captured_at;
  if (snapshot.last_touch.captured_at) properties.last_touch_at = snapshot.last_touch.captured_at;
  if (snapshot.fbc) properties.fbc = snapshot.fbc;
  if (snapshot.fbp) properties.fbp = snapshot.fbp;
  return properties;
}
