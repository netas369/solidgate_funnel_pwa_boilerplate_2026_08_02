export const ACQUISITION_UTM_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
] as const;

export type AcquisitionUtmKey = (typeof ACQUISITION_UTM_KEYS)[number];
export type AcquisitionUtm = Partial<Record<AcquisitionUtmKey, string>>;

const MAX_UTM_LENGTH = 380;

/** Keep only the five canonical first-touch UTM fields accepted by Solidgate. */
export function normalizeAcquisitionUtm(value: unknown): AcquisitionUtm {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const result: AcquisitionUtm = {};
  for (const key of ACQUISITION_UTM_KEYS) {
    const raw = input[key];
    if (typeof raw !== "string") continue;
    const normalized = raw.trim().slice(0, MAX_UTM_LENGTH);
    if (normalized) result[key] = normalized;
  }
  return result;
}

/** PostHog keeps both the established bare keys and explicit first-touch keys. */
export function acquisitionEventProperties(value: unknown): Record<string, string> {
  const acquisition = normalizeAcquisitionUtm(value);
  const properties: Record<string, string> = {};
  for (const key of ACQUISITION_UTM_KEYS) {
    const utm = acquisition[key];
    if (!utm) continue;
    properties[key] = utm;
    properties[`first_touch_${key}`] = utm;
  }
  return properties;
}
