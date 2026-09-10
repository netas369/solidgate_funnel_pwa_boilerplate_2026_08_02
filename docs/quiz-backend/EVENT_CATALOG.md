# Funnel Event Catalog

Database events are durable business milestones. Frontend analytics tools remain responsible for high-volume interaction and performance events.

## Envelope

```json
{
  "eventId": "0198d633-0000-7000-8000-000000000002",
  "sessionId": "0198d633-48df-7ca8-b728-c4339d29db47",
  "type": "step_completed",
  "stepNumber": 3,
  "metadata": {"step_id": "activity_level"},
  "occurredAt": "2026-09-09T10:12:00Z"
}
```

The server verifies session ownership, supplies `created_at`, bounds client-supplied `occurred_at`, and rejects unknown event names.

Quiz-screen milestones use the session transaction that owns the matching state change: create writes `quiz_started`, save writes `step_completed` or `lead_captured`, and completion writes `quiz_completed`. The quiz browser does not insert these rows directly.

## Canonical events

| Event | Emitted when | Owner | Idempotency |
|---|---|---|---|
| `quiz_started` | First quiz screen becomes active | Client request, backend validated | Once per session |
| `step_completed` | Valid step progress is saved | Save transaction | Unique `event_id`; normally once per session/step |
| `lead_captured` | Valid email/consent state is committed | Backend | Once per session |
| `quiz_completed` | Result and completed session are committed | Completion transaction | Exactly once per session |
| `results_viewed` | Results are first displayed | Client request, backend validated | Normally once per session |
| `offer_viewed` | Downstream offer is displayed | Funnel | Per meaningful display policy |
| `offer_accepted` | Visitor explicitly accepts an offer | Funnel | Per acceptance action |
| `offer_declined` | Visitor explicitly declines an offer | Funnel | Per displayed offer |
| `checkout_completed` | Payment system confirms checkout | Trusted backend integration | Unique provider/idempotency reference |

Existing implementations may use `oto_viewed`, `oto_accepted`, and `oto_declined` instead of the generic offer names. Renaming existing production events requires a reporting migration; do not change names silently.

## Metadata rules

- Maximum serialized size: 8 KiB.
- Keys use `snake_case`.
- Use stable codes, not translated display labels.
- Do not include email, full answers, result payloads, IP addresses, auth/session credentials, payment card data, or message content.
- Add a new event only when it represents a durable business fact used by recovery, operations, or reporting.
- Update this catalog, runtime allowlist, database constraint, reporting queries, and tests together.

## Keep these in product analytics instead

- every answer click;
- hover, scroll, and animation events;
- repeated viewability signals;
- frontend performance timings;
- raw device fingerprints;
- debug logs.
