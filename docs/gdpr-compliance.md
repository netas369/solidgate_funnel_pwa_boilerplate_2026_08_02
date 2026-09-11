# GDPR and privacy checklist

This is implementation guidance, not legal advice. Replace the placeholder
legal entity, purposes, retention periods, and contact details with decisions
approved for each launch.

## Product analytics

Product events are first-party records in Supabase. The funnel and PWA post to
same-origin routes and do not load an external product-analytics or session-
replay SDK. The `analytics_events` table is private to `service_role` and must
not contain raw email, free-form advisor messages, journal content, image paths,
tokens, or query strings.

Before launch:

1. Document a lawful basis for each event category.
2. Set a retention period and scheduled deletion/anonymization policy.
3. Include product-event processing and the future unified-dashboard export in
   the privacy notice and records of processing.
4. Make account deletion remove or anonymize user-linked analytics according to
   the approved retention policy.
5. Restrict dashboard/export credentials and log administrative access.

## Optional advertising integrations

Meta Pixel/CAPI and Google Tag Manager remain optional marketing delivery
integrations. They are separate from the internal product-analytics stream. If
enabled, implement the consent behavior required in each target jurisdiction,
list the processors and transfers in the privacy notice, configure consent mode
where applicable, and verify that raw email never reaches browser tags.

## Accounts, payments, and advisor content

- Supabase Auth cookies are essential for account sessions.
- Solidgate payment identifiers and entitlement history are retained according
  to contractual, accounting, chargeback, and fraud obligations.
- Advisor messages and attachments may be sensitive. Use a private Storage
  bucket, ownership-based RLS, malware/content checks appropriate to the
  product, explicit retention, and an account-deletion workflow.
- Notification preferences should record when consent/state changed;
  `notifications_updated_at` supports that audit trail.

## Launch verification

- Search the built output and network log for unexpected analytics vendors.
- Verify `analytics_events` is inaccessible with anon/authenticated keys.
- Verify same-origin event routes reject invalid payloads and bind user/session
  identity server-side.
- Verify advertising tags do not load before the chosen consent condition.
- Exercise access, correction, export, deletion, and consent-withdrawal flows.
