# Internal analytics contract

This boilerplate keeps product analytics in its own Supabase database. Browser
code sends events to same-origin API routes; those routes bind trusted identity
and persist to `public.analytics_events` with the service role. There is no
third-party product-analytics SDK.

Set one permanent lowercase identifier in the funnel, PWA, and Solidgate Edge
Function environments:

```dotenv
ANALYTICS_PROJECT_KEY=acme
```

The future unified dashboard should treat `(project_key,
deployment_environment, source_app, event_key)` as the producer idempotency
key. Export incrementally in `(created_at, id)` order and retain `occurred_at`
as the business-event time. `schema_version` allows
the contract to evolve without silently changing old events.

## Why this is one table

The suggested `PWA_events` model applies, but a PWA-only table would split the
same user's journey across funnel, app, and payment-webhook stores. The reusable
model therefore uses one append-only `analytics_events` table with dimensions
for project, environment, app, channel, user, session, and JSON properties.

Recommended canonical event names include:

| Event | Producer | Meaning |
|---|---|---|
| `first_login` | PWA | First authenticated PWA load for a user |
| `page_view` | Funnel/PWA | Route view without query-string secrets |
| `app_opened` | PWA server | One open after the 30-minute idle window |
| `installed_pwa` | PWA | Browser install confirmation or standalone launch |
| `cta_clicked` | Funnel/PWA | A named business CTA; put `target` in properties |
| `advisor_conversation_started` | Advisor API | First user message in a conversation |
| `advisor_message_sent` | Advisor API | User/advisor message lifecycle metric |
| `purchase_completed` | Payment webhook | Canonical booked one-time revenue |
| `subscription_started` | Payment webhook | Canonical initial subscription payment |
| `subscription_renewed` | Payment webhook | Canonical recurring revenue |

Prefer specific verbs such as `paywall_opened` over a generic `clicked_on`.
Never put email addresses, message text, journal content, image paths, access
tokens, or full URLs in event properties.

## Related reusable tables

- `user_prefs` is extended with `display_name`, `notifications_enabled`,
  `notifications_updated_at`, and `timezone`; its existing locale, country, and
  app-retention fields remain intact.
- `entitlements` already has the required user, product, access level, status,
  order, grant/expiry/revocation, provider subscription, and payment-environment
  fields. Reusing it avoids two competing access-control sources of truth.
- `advisor_conversations`, `advisor_messages`, and
  `advisor_message_attachments` provide the proposed advisor model with owner
  RLS, a first-advisor `preview`, a separate latest-message preview, message
  status/kind, idempotent client message IDs, archive timestamps, and private
  Storage object references.

Advisor image bytes belong in a private Supabase Storage bucket. Store only the
bucket and object path in `advisor_message_attachments`, and add bucket policies
that enforce the same conversation ownership before enabling uploads.

## Access and export

`analytics_events` has RLS enabled and grants no access to `anon` or
`authenticated`; only `service_role` can read/write it. Do not expose the table
through a browser Supabase client. The unified dashboard should use a dedicated
server-side credential or a narrowly scoped export job, keep a per-project
cursor, and copy the stable contract into its central warehouse.

Production should fail configuration validation if `ANALYTICS_PROJECT_KEY` is
missing. Legacy webhook-outbox rows migrate with `project_key = 'unconfigured'`;
map those during a one-time historical import if they exist.
