import { createHash } from 'node:crypto';

/**
 * Server-side Meta Conversions API client.
 *
 * Why: browser pixel events lose 30–50% of attribution to iOS 14+ ATT,
 * Safari ITP, ad blockers, and intermittent fbevents.js load failures.
 * Mirroring critical events (Lead, Purchase) server-side recovers most of
 * that loss. Meta dedupes the server event against the client event by
 * matching (event_name, event_id).
 *
 * Reference: https://developers.facebook.com/docs/marketing-api/conversions-api/get-started
 */

const GRAPH_API_VERSION = 'v22.0';

type MetaUserData = {
  /** SHA-256 hashed email (lowercased + trimmed). */
  em?: string;
  /** SHA-256 hashed phone (E.164, no leading +). */
  ph?: string;
  /** SHA-256 hashed first name (lowercased). */
  fn?: string;
  /** _fbp cookie value, unhashed. */
  fbp?: string;
  /** _fbc cookie value, unhashed (fb.{idx}.{ts}.{fbclid}). */
  fbc?: string;
  /** Client IP, unhashed. */
  client_ip_address?: string;
  /** User-Agent header, unhashed. */
  client_user_agent?: string;
  /** SHA-256 of a stable first-party visitor/session identifier. */
  external_id?: string;
};

export type MetaCustomData = {
  /** Numeric value of the conversion (Purchase requires this). */
  value?: number;
  /** ISO-4217 currency code (Purchase requires this). */
  currency?: string;
  /** Product identifier (e.g. "main", "oto1-lifetime"). */
  content_ids?: string[];
  /** Product type. Common: "product", "product_group". */
  content_type?: string;
  content_name?: string;
  contents?: Array<{ id: string; quantity: number; item_price?: number }>;
  num_items?: number;
  order_id?: string;
  /** Safe funnel context; never include answers or result segments. */
  quiz_variant?: string;
  funnel_variant?: string;
  locale?: string;
  step_number?: number;
  content_category?: string;
};

export type SendMetaCapiEventInput = {
  /** Standard event name: PageView, Lead, AddToCart, InitiateCheckout, Purchase, etc. */
  eventName: string;
  /** UUID matching the browser fbq call's eventID for deduplication. */
  eventId: string;
  /** Page URL the event happened on. */
  eventSourceUrl?: string;
  /** Unix seconds. Defaults to now if omitted. */
  eventTimeSec?: number;
  userData: MetaUserData;
  customData?: MetaCustomData;
};

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** SHA-256 a normalized email (lowercased + trimmed). */
export function hashMetaEmail(email: string): string {
  return sha256Hex(email.trim().toLowerCase());
}

/** Hash a stable first-party identifier before using it for Meta matching. */
export function hashMetaExternalId(id: string): string {
  return sha256Hex(id.trim());
}

/**
 * POST one event to Meta's CAPI. Returns true on success, false otherwise
 * (logs the failure — callers should not block on this). Never throws so
 * the failure of a side-channel analytics call cannot break the main flow.
 */
export async function sendMetaCapiEvent(input: SendMetaCapiEventInput): Promise<boolean> {
  const pixelId = process.env.META_PIXEL_ID ?? process.env.NEXT_PUBLIC_META_PIXEL_ID;
  const accessToken = process.env.META_CAPI_ACCESS_TOKEN;
  if (!pixelId || !accessToken) {
    // Silently skip if CAPI is not configured. This is the bootstrap state
    // before the access token is provisioned in Vercel envs.
    return false;
  }

  const eventTime = input.eventTimeSec ?? Math.floor(Date.now() / 1000);
  const testEventCode = process.env.META_CAPI_TEST_EVENT_CODE;

  const body = {
    data: [
      {
        event_name: input.eventName,
        event_time: eventTime,
        event_id: input.eventId,
        action_source: 'website',
        event_source_url: input.eventSourceUrl,
        user_data: input.userData,
        custom_data: input.customData,
      },
    ],
    ...(testEventCode ? { test_event_code: testEventCode } : {}),
  };

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${pixelId}/events?access_token=${encodeURIComponent(accessToken)}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.warn(
        `[meta-capi] ${input.eventName} POST failed status=${res.status} body=${errBody.slice(0, 500)}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[meta-capi] network error:', err);
    return false;
  }
}
