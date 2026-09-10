# Meta Tracking Contract

This is the reusable Meta Pixel and Conversions API (CAPI) contract for the Quiz funnel. A copied product may change its Pixel ID and campaign names, but should keep the event, privacy, verification, and deduplication rules below.

## What is sent

| Internal event | Meta event | Type | Pixel | CAPI |
|---|---|---|---|---|
| Page activation | `PageView` | Standard | Yes | No session exists yet |
| `quiz_started` | `ViewContent` | Standard | Yes | Yes when session exists |
| `step_completed` | `QuizStepCompleted` | Custom | Yes | Yes |
| `quiz_completed` | `QuizCompleted` | Custom | Yes | Yes |
| `lead_captured` | `Lead` | Standard | Yes | Yes |
| `tier_selected` | `AddToCart` | Standard | Yes | Yes |
| `checkout_opened` | `InitiateCheckout` | Standard | Yes | Yes |
| Paid `checkout_completed` | `Purchase` | Standard | Yes | Yes |
| Verified zero-cost subscription | `StartTrial` | Standard | Yes | Yes |

Real OTO purchases are included. They are separate paid orders with unique `purchase:{orderId}` identifiers, so they must not be suppressed merely because their product category is `oto`.

## Match-quality data

The server adds the strongest safe identifiers it has:

- normalized email as SHA-256 `em`, but only after the email was saved;
- session ID as SHA-256 `external_id`;
- `_fbp` browser ID and `_fbc` Meta click ID;
- client IP address and User-Agent on the server request;
- same-origin `event_source_url`;
- first- and last-touch UTM labels stored on the session;
- server-owned `quiz_variant`, `funnel_variant`, and `locale`;
- stable product ID/name, `content_ids`, `contents`, quantity, value, and currency where relevant;
- verified provider order ID for a Purchase.

`_fbc` is created from a real `fbclid` when necessary. `_fbp` gets a first-party fallback value if the Pixel library is delayed or blocked. Both are retained in the session attribution record so later CAPI events can still use them when a request cookie is missing.

## Deduplication

The browser Pixel event and browser-triggered CAPI event always receive the same `event_name` and `event_id`. Meta uses that pair to treat them as copies of one event.

Purchases use the deterministic ID `purchase:{providerOrderId}`. The main purchase also has a durable fulfillment-outbox sender. Therefore the browser Pixel, browser-triggered CAPI, and durable server retry all describe the same purchase without intentionally creating three conversions.

Do not generate a second ID when retrying the same event. A new ID means a genuinely new event.

## Revenue trust boundary

The browser may request a Purchase/StartTrial CAPI send, but the API ignores browser-supplied revenue. It reloads the order, verifies that it belongs to the session and has an accepted payment state, checks the signed Payment cookie, and then uses the stored amount, currency, product, and order ID.

A paid order becomes `Purchase`. Only a real zero-amount order with a subscription ID becomes `StartTrial`. A zero-value browser payload without that proof is not reported as a Purchase.

## Data intentionally not sent to Meta

More data is useful only when it is safe and meaningful. The integration must not send:

- individual quiz answers or the complete answer object;
- result profile, result segment, score data, or generated result content;
- question/step keys that reveal the subject of a sensitive question;
- raw email, name, user ID, visitor ID, or session ID;
- payment card details, payment tokens, cookies, or credentials.

For quiz progress, Meta receives only the step number and safe session context. Raw email never appears in the browser CAPI request; the server reads it from the bound session and hashes it.

## Bot handling

Known Meta link-preview and indexing User-Agents do not load Pixel scripts and do not create a Quiz session. Facebook and Instagram in-app browsers used by people remain allowed. Never classify `fbclid`, Meta referrer, `FBAN`, `FBAV`, or `Instagram` as bot proof.

## Configuration

The integration is optional and becomes a quiet no-op if credentials are absent:

```text
NEXT_PUBLIC_META_PIXEL_ID=browser_pixel_id
META_PIXEL_ID=server_pixel_id
META_CAPI_ACCESS_TOKEN=server_only_access_token
META_CAPI_TEST_EVENT_CODE=temporary_test_code_only
```

`NEXT_PUBLIC_META_PIXEL_ID` is browser-visible. `META_CAPI_ACCESS_TOKEN` must never use the `NEXT_PUBLIC_` prefix. Remove the test event code after Events Manager validation.

## Verification before handoff

1. Open Meta Events Manager Test Events and temporarily configure `META_CAPI_TEST_EVENT_CODE`.
2. Complete one human quiz journey and one real test checkout.
3. Confirm the mapped events appear and Pixel/CAPI copies are deduplicated.
4. Confirm Purchase value, currency, order ID, product ID, `_fbc`/`_fbp`, and event source URL are present.
5. Confirm no answer, result segment, raw email, or raw session ID appears.
6. Open a URL containing a test `fbclid` and confirm it is retained as `_fbc`.
7. Request the create route with a known Meta crawler User-Agent and confirm no session or Meta event is produced.
8. Remove `META_CAPI_TEST_EVENT_CODE` before production traffic.

Official references: [Meta Conversions API customer information parameters](https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters), [Meta Pixel event reference](https://developers.facebook.com/docs/meta-pixel/reference), and [Pixel/CAPI event deduplication](https://developers.facebook.com/docs/marketing-api/conversions-api/deduplicate-pixel-and-server-events).
