'use client';

import { useCallback } from 'react';
import type { Json } from '@repo/shared/types/database';
import { useAnalyticsStore } from '@/stores/analytics-store';
import { trackFunnelEvent } from '@/features/quiz/lib/track-funnel-event';
import { capturePostHogEvent } from '../lib/posthog';
import { pushDataLayerEvent } from '../lib/gtm';
import { trackMetaEvent } from '../lib/meta-pixel';
import { generateMetaEventId } from '../lib/meta-event-id';

/**
 * Internal funnel event → Meta standard event.
 *
 * Only mapped events reach the Pixel; everything else stays in PostHog / GTM /
 * the funnel_events mirror. checkout_completed → Purchase fires only when
 * value + currency are present (the offer page supplies them; an upsell whose
 * intro is €0 does not).
 *
 * TODO(new product): the LEFT column is this funnel's own vocabulary — rename
 * it with your steps. The RIGHT column must stay a Meta standard event name.
 */
const META_EVENT_MAP: Record<string, string> = {
  lead_captured: 'Lead',
  tier_selected: 'AddToCart',
  checkout_opened: 'InitiateCheckout',
  checkout_completed: 'Purchase',
};

// ─── Two business decisions, surfaced as flags rather than buried in code ────

/**
 * When true, an upsell purchase (product_category === 'oto') is NOT reported to
 * Meta at all.
 *
 * Why it shipped true: ads optimize on the MAIN offer conversion. A buyer who
 * takes three upsells would otherwise count as four Purchases for one paid
 * funnel entry, inflating ROAS and poisoning attribution. PostHog, GTM and the
 * funnel_events mirror still receive every upsell event — only the Meta
 * emission is suppressed.
 *
 * TODO(new product): flip to false if you want upsell revenue in Meta.
 */
const SUPPRESS_OTO_PURCHASES_FROM_META = true;

/**
 * When true, a €0 checkout_completed that the SERVER confirmed opened a real
 * subscription (`authorized_trial`) reports StartTrial instead of Purchase, so
 * a free-intro tier is still a conversion signal rather than a silent gap.
 */
const REPORT_ZERO_VALUE_TRIALS_AS_START_TRIAL = true;

type TrackMetadata = Record<string, unknown> & {
  /** Optional plaintext email piped to CAPI for hashed server-side matching. Never sent to fbq or GTM directly. */
  capi_email?: string;
};

/**
 * Post-quiz events mirrored into the funnel_events DB table, keyed by the
 * only event types its CHECK constraint accepts. Per-OTO names
 * (oto1_viewed, ...) collapse onto the generic types; otoN_purchased maps to
 * oto_accepted, matching the main offer's accepted→completed pair. Quiz
 * events (quiz_started, step_completed, ...) are NOT mirrored here — the quiz
 * writes them via trackFunnelEvent directly.
 */
function dbFunnelEventType(event: string): string | null {
  if (event === 'checkout_completed') return 'checkout_completed';
  if (event === 'oto_viewed' || /^oto\d+_viewed$/.test(event)) return 'oto_viewed';
  if (event === 'oto_accepted' || /^oto\d+_purchased$/.test(event)) return 'oto_accepted';
  if (event === 'oto_declined' || /^oto\d+_declined$/.test(event)) return 'oto_declined';
  return null;
}

/**
 * Centralized analytics hook: ONE call site fans out to every sink.
 *
 *   1. the in-memory Zustand store (debug / session state)
 *   2. PostHog product analytics
 *   3. the GTM dataLayer (retargeting pixels)
 *   4. the funnel_events DB mirror (our own conversion data)
 *   5. the Meta Pixel (mapped subset only)
 *
 * Server-side Meta CAPI runs on a SEPARATE durable path — the fulfillment
 * outbox's send_meta_capi_purchase effect — so a purchase is reported even if
 * the browser never comes back. The browser→server CAPI mirror that used to
 * live here is disabled; /api/meta/capi and lib/meta-capi-client.ts are intact
 * so re-enabling it is a one-line change (see the note further down).
 */
export function useAnalytics() {
  const trackEvent = useAnalyticsStore((s) => s.trackEvent);

  const track = useCallback(
    (event: string, metadata?: TrackMetadata) => {
      // Strip CAPI-only fields before forwarding to channels that should
      // never receive raw PII (PostHog, GTM, Meta Pixel browser-side).
      // Preserve undefined-when-absent so downstream channels see the same
      // payload shape they did before CAPI was introduced.
      let sanitized: Record<string, unknown> | undefined;
      if (metadata) {
        // capi_email stays stripped even with the CAPI mirror removed — raw
        // PII must never leak into PostHog/GTM/fbq payloads.
        const { capi_email: _capiEmail, ...rest } = metadata;
        sanitized = rest;
      }

      // 1. In-memory buffer (existing analytics store)
      trackEvent(event, sanitized);
      // 2. PostHog product analytics
      capturePostHogEvent(event, sanitized);
      // 3. GTM dataLayer for retargeting pixels
      pushDataLayerEvent(event, sanitized);
      // 3b. funnel_events DB mirror, so quiz→purchase conversion and the OTO
      // funnel are computable from our own data, not only PostHog. Requires a
      // session_id (funnel_events.session_id is a NOT NULL FK to sessions).
      const dbEventType = dbFunnelEventType(event);
      const dbSessionId =
        typeof sanitized?.session_id === 'string' ? sanitized.session_id : undefined;
      if (dbEventType && dbSessionId) {
        const dbMetadata =
          dbEventType === event ? sanitized : { ...sanitized, source_event: event };
        trackFunnelEvent(dbSessionId, dbEventType, undefined, dbMetadata as Json);
      }
      // 4. Meta Pixel standard events (mapped subset only)
      const metaEvent = META_EVENT_MAP[event];
      if (metaEvent) {
        const value = typeof sanitized?.value === 'number' ? sanitized.value : undefined;
        const currency = typeof sanitized?.currency === 'string' ? sanitized.currency : undefined;
        const product =
          typeof sanitized?.product_id === 'string'
            ? sanitized.product_id
            : typeof sanitized?.product === 'string'
              ? sanitized.product
              : undefined;

        // A €0 checkout_completed that opened a REAL subscription (server
        // confirmed via `authorized_trial`) is a free-trial start, not a
        // Purchase. See REPORT_ZERO_VALUE_TRIALS_AS_START_TRIAL.
        const isFreeTrialStart =
          REPORT_ZERO_VALUE_TRIALS_AS_START_TRIAL &&
          metaEvent === 'Purchase' &&
          !value &&
          sanitized?.authorized_trial === true &&
          !!currency;
        const effectiveMetaEvent = isFreeTrialStart ? 'StartTrial' : metaEvent;

        // See SUPPRESS_OTO_PURCHASES_FROM_META.
        const isOtoPurchase =
          SUPPRESS_OTO_PURCHASES_FROM_META &&
          metaEvent === 'Purchase' &&
          sanitized?.product_category === 'oto';

        const suppliedEventId =
          typeof sanitized?.event_id === 'string'
            ? sanitized.event_id
            : typeof sanitized?.eventId === 'string'
              ? sanitized.eventId
              : undefined;

        // Delivery telemetry for the money events. KEEP THIS. Without the
        // browser→server CAPI mirror a Purchase can vanish invisibly: a
        // stub-state pixel (CDN failure, ad blocker) OR a payload that trips
        // the value/currency guard. A real buyer's session replay showed
        // exactly that — healthy PageViews, zero /tr?ev=Purchase, and no way
        // to tell from the outside. Every skip and drop is reported with its
        // reason so PostHog shows the TRUE Meta delivery rate.
        const reportDelivery = (
          pixelFired: boolean,
          skipReason: string | undefined,
          eventId: string | undefined,
        ) => {
          if (metaEvent !== 'Purchase') return;
          capturePostHogEvent('meta_pixel_delivery', {
            meta_event: effectiveMetaEvent,
            pixel_fired: pixelFired,
            skip_reason: skipReason,
            event_id: eventId,
            value,
            currency,
            product_category: sanitized?.product_category,
          });
        };

        // Purchase requires value + currency — skip if missing, so a
        // zero-intro upsell cannot fire a $0 Purchase.
        if (isOtoPurchase) {
          // Intentionally skipped, with no telemetry either: this is the
          // designed suppression, not a delivery failure.
        } else if (metaEvent === 'Purchase' && !isFreeTrialStart && (!value || !currency)) {
          reportDelivery(false, 'missing_value_or_currency', suppliedEventId);
        } else {
          // Generate one eventID and use it for BOTH the browser fbq event
          // and the server-side CAPI mirror. Meta dedupes on
          // (event_name, event_id) within a 28-day window.
          const eventId = suppliedEventId || generateMetaEventId();
          const pixelFired = trackMetaEvent(effectiveMetaEvent, sanitized, { eventID: eventId });
          // Browser→server CAPI mirror is OFF: browser-pixel only here, with
          // the durable server-side Purchase coming from the fulfillment
          // outbox instead. To re-enable, call sendCapiFromBrowser() from
          // lib/meta-capi-client.ts with this same `eventId` — Meta dedupes on
          // (event_name, event_id) within a 28-day window, which is exactly
          // why the id is generated once, above.
          reportDelivery(pixelFired === true, pixelFired === true ? undefined : 'pixel_not_loaded', eventId);
        }
      }
    },
    [trackEvent]
  );

  return { track };
}
