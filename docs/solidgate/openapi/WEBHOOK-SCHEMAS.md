# Solidgate Webhook Payload Schemas

Extracted verbatim from the official Solidgate OpenAPI 3.0.3 specification, downloaded from
`https://api-docs.solidgate.com/_bundle/api/@v1/index.yaml?download` (and `.json`), saved in this
directory as `solidgate-api-v1.yaml` / `solidgate-api-v1.json`. Webhooks are defined under the
spec's top-level `x-webhooks` key; schemas under `components.schemas`.

Field notation below: `REQUIRED` = listed in the schema's `required` array. All datetime strings
use pattern `YYYY-MM-DD HH:MM:SS` unless noted. Amounts are integers in the smallest currency
unit (e.g. `1020` = 10.20 EUR). Currency codes are 3-letter ISO-4217.

---

## Common webhook HTTP headers (all webhooks)

| Header | Required | Description / example |
|---|---|---|
| `merchant` | yes | Merchant public key, e.g. `wh_pk_7b197...ba108f842` |
| `signature` | yes | HMAC signature of the payload |
| `solidgate-event-id` | yes | Unique event id, e.g. `e1765cf7-70f7-4e56-8fb2-bd88744a94d1` |
| `solidgate-event-created-at` | yes | ISO 8601 with ms, e.g. `2025-06-05T12:34:56.789Z` |
| `solidgate-event-type` | yes | e.g. `subscription.updated.v2`, `card_gate.order.updated`, `card_gate.chargeback.received` |

Webhook endpoint event types (`SchemaWebhooksEventType` enum):
`card_gate.order.updated`, `card_gate.chargeback.received`, `card_gate.fraud_alert.received`,
`card_gate.prevention_alert.received`, `subscription.updated`, `subscription.updated.v2`,
`alt_gate.order.updated`, `alt_gate.paypal_dispute.received`, `card.network_token.created`,
`card.network_token.updated`, `taxer.tax.calculated`, `alt_gate.recurring_token.cancelled`.

Spec note (all webhooks): duplicate webhook events can occur — implement idempotency.

---

## 1. Subscription webhook (`webhook-subscription-status`)

Spec: `x-webhooks.Billing.post`. Body is `oneOf`:
- **Extended** (`subscription.updated.v2`) — `SchemaBillingSubscriptionDiscriminatorWebhookExtended`
- **Legacy** (`subscription.updated`) — `SchemaBillingSubscriptionDiscriminatorWebhook` (supported until end of June 2026 per spec description)

Both discriminate on **`callback_type`**.

### 1.1 Extended (v2) `callback_type` enum (19 values)

`create`, `expire`, `payment_attempt`, `active`, `renew`, `switch_product`, `order_update`,
`pause`, `pause_schedule.create`, `pause_schedule.update`, `pause_schedule.delete`, `resume`,
`recurring`, `restore`, `cancel`, `scheduled_for_cancellation`, `redemption`, `retry`,
`scheduled_for_retry`

### 1.2 Extended (v2) payload shape (all variants)

Top level (all variants identical in structure; `required`: `callback_type`, `subscription`, `product`, `customer`):

```
{
  callback_type: string (enum: one value per variant, see 1.1)   REQUIRED
  subscription:  object                                          REQUIRED
  product:       object                                          REQUIRED
  customer:      object                                          REQUIRED
  invoices:      object  (map: invoice_id -> invoice object)     optional
}
```

#### `subscription` object

| Field | Type | Notes |
|---|---|---|
| `id` | string (uuid, maxLength 36) | REQUIRED in all variants. Unique subscription identifier |
| `status` | string enum | REQUIRED. Per-variant values, see table 1.3 |
| `started_at` | string datetime | REQUIRED except `create`/`expire`/`payment_attempt`/`order_update` variants |
| `updated_at` | string datetime | REQUIRED in all variants |
| `expired_at` | string datetime | required in "settled" variants (see table) |
| `next_charge_at` | string datetime | required in active-like variants; absent in `cancel`, `scheduled_for_cancellation`, `retry` |
| `payment_type` | string enum: `card`, `paypal-vault`, `mercadopago`, `upi`, `pix`, `gcash`, `alipay`, `mbway`, `wechatpay` | required in most variants |
| `trial` | boolean | REQUIRED in all variants |
| `discount` | object | optional. `{ created_at (datetime, REQUIRED), coupon_code (string), coupon { name (REQUIRED), description, type enum: percentage/amount (REQUIRED), value (integer, REQUIRED) } (REQUIRED) }` |
| `cancel_code` | string enum: `8.01`–`8.15` | only `cancel` / `scheduled_for_cancellation` variants (REQUIRED there) |
| `cancel_message` | string | only `cancel` / `scheduled_for_cancellation` (REQUIRED there) |
| `cancellation_requested_at` | string datetime | `cancel` / `scheduled_for_cancellation` (REQUIRED there); also present in `switch_product` (optional, only when product changed after cancellation) |
| `cancelled_at` | string datetime | only `cancel` / `scheduled_for_cancellation` (REQUIRED there; spec notes it is `null` in some cases, e.g. refunds) |
| `pause` | object | only `pause`, `pause_schedule.create`, `pause_schedule.update` variants (REQUIRED there). `{ from_date (datetime, REQUIRED), to_date (datetime, absent when paused infinitely) }` |

#### `product` object (`SchemaBillingSubscriptionWebhookProduct`)

| Field | Type | Notes |
|---|---|---|
| `product_id` | string (uuid) | REQUIRED |
| `name` | string | REQUIRED |
| `payment_action` | string enum: `auth_0_amount`, `auth_void`, `auth_settle` | optional |
| `amount` | integer | REQUIRED. Product price |
| `currency` | string (ISO-4217) | REQUIRED |
| `trial` | boolean | REQUIRED |
| `trial_period` | integer (minutes) | required if product has trial |
| `trial_amount` | integer | required if product has trial |
| `trial_currency` | string | required if product has trial |

#### `customer` object (`SchemaBillingSubscriptionWebhookCustomer`)

| Field | Type | Notes |
|---|---|---|
| `customer_account_id` | string | REQUIRED. Merchant-defined customer id |
| `customer_email` | string | REQUIRED |

#### `invoices` map — `{ "<invoice_id>": invoice }`

"Latest invoice for the subscription." Each invoice object:

| Field | Type | Notes |
|---|---|---|
| `id` | string (uuid) | REQUIRED |
| `status` | string enum | REQUIRED. Per-variant, see table 1.3; full set: `processing`, `retry`, `success`, `fail` |
| `created_at` / `updated_at` | string datetime | REQUIRED |
| `amount` | integer | REQUIRED. Current subscription price |
| `product_price_id` | string (uuid) | optional |
| `discount` | object | optional, same shape as `subscription.discount` |
| `billing_period_started_at` / `billing_period_ended_at` | string datetime | filled if invoice status is `success` |
| `subscription_term_number` | integer | passed billing periods excluding trial |
| `orders` | object (map: order_id -> order) | REQUIRED |
| `order_metadata` | object, `additionalProperties: string (maxLength 380)`, max 10 props | optional |

#### `invoices.<id>.orders` map — `{ "<order_id>": order }`

| Field | Type | Notes |
|---|---|---|
| `id` | string | REQUIRED |
| `status` | string enum: `created`, `processing`, `3ds_verify`, `auth_ok`, `auth_failed`, `void_ok`, `settle_ok`, `refunded`, `approved`, `declined` | REQUIRED (card statuses = first 8; APM statuses = `approved`/`declined`) |
| `created_at` | string datetime | REQUIRED |
| `updated_at` | string datetime | optional |
| `processed_at` | string datetime | empty while processing |
| `amount` | integer | REQUIRED |
| `failed_reason` | string (error code) | only on failed orders that are last or precede a successful one (present in fail-capable variants) |
| `retry_attempt` | integer | filled for retry-strategy orders |
| `payment_details` | object | `{ invoice_id (string), payer_email (string) }` — paypal-vault only |
| `operation` | string enum: `pay`, `recurring`, `recurring-auth`, `refund`, `resign`, `resign-auth`, `auth`, `settle`, `void`, `apple-pay`, `google-pay` | optional |

### 1.3 Extended (v2) per-variant enum matrix

| `callback_type` | `subscription.status` enum | `invoice.status` enum |
|---|---|---|
| `create` | `pending` | `processing` |
| `expire` | `cancelled` | `fail` |
| `payment_attempt` | `pending` | `processing` |
| `active` | `active` | `success` |
| `renew` | `active` | `success` |
| `switch_product` | `active` | `success`, `fail` |
| `order_update` | `pending`, `active`, `cancelled`, `redemption`, `paused`, `expired` | `processing`, `retry`, `success`, `fail` |
| `pause` | `paused` | `success` |
| `pause_schedule.create` | `active` | `success` |
| `pause_schedule.update` | `active`, `paused` | `success` |
| `pause_schedule.delete` | `active` | `processing`, `retry`, `success`, `fail` |
| `resume` | `active` | `success` |
| `recurring` | `active` | `processing`, `retry`, `success`, `fail` |
| `restore` | `active` | `success`, `fail` |
| `cancel` | `cancelled` | `success`, `fail` |
| `scheduled_for_cancellation` | `active` | `success`, `fail` |
| `redemption` | `redemption` | `retry` |
| `retry` | `redemption` | `retry` |
| `scheduled_for_retry` | `redemption` | `retry` |

Full `subscription.status` value space across variants: `pending`, `active`, `cancelled`,
`redemption`, `paused`, `expired`.

### 1.4 Legacy (v1, `subscription.updated`) — `callback_type` enum (9 values)

`init`, `renew`, `update`, `cancel`, `pause`, `resume`, `pause_schedule.create`,
`pause_schedule.update`, `pause_schedule.delete`

Same top-level shape (`callback_type`, `subscription`, `product`, `customer` REQUIRED; `invoices`
map optional). Example — legacy `update` variant:
- `subscription` required: `id`, `status`, `updated_at`, `trial`; props: `id`, `status`
  (enum `active`, `cancelled`, `redemption`, `paused`), `started_at`, `updated_at`, `expired_at`,
  `next_charge_at`, `payment_type`, `trial`, `cancelled_at`, `cancellation_requested_at`,
  `cancel_code`, `cancel_message`, `pause`
- invoice props/status enum and order props/status enum identical to the extended version above.

---

## 2. Card order status webhook (`webhook-card-order-status`)

Spec: `x-webhooks.CardsOrderStatus.post`, schema `RequestCardsWebhookOrderStatus`.
Event type: `card_gate.order.updated`. No fields are marked `required` at the root of this schema.

```
{
  order: { ... }                       # see 2.1
  error: { ... }                       # order-level error, see 2.4 (present when order failed)
  transaction: { ... }                 # latest transaction, see 2.2
  transactions: { "<transaction_id>": { ... } }   # map of all transactions, same shape as 2.2
  three_ds: { eci, flow, exception }               # see 2.3
  routing: { cascade_steps: [ {mid, mid_descriptor, route_id, cascade_number, segment_id} ] }
  antifraud_result: { pre_auth: enum reject|review|pass }
  verification_result: {
    avs_result: enum matched|partially_matched|not_matched|unsupported|unavailable|unknown,
    cvv_result: enum matched|not_matched|not_checked|unavailable|unknown,
    ani: { status: enum performed|not_performed|not_supported,
           full_name_match / first_name_match / last_name_match:
             enum matched|partially_matched|not_matched }
  }
  chargebacks: { id, dispute_date, settlement_date, amount, currency, type, status,
                 reason_group, reason_code, reason_description, chargeback_flow: [...] }
  device_info: { user_agent: string }
  verify_url: string          # 3DS redirect URL for the customer
  redirect_url: string        # post-3DS/redirect return URL
  order_metadata: { <key>: string }   # additionalProperties: string
  payment_adviser: { advise: string }
}
```

### 2.1 `order` object

| Field | Type | Notes |
|---|---|---|
| `order_id` | string (maxLength 255) | Merchant-defined for first payment; Solidgate-generated for recurring |
| `order_description` | string | |
| `psp_order_id` | string | PSP id generated by Solidgate |
| `provider_payment_id` | string | PSP id generated by the PSP |
| `product_id` | string (uuid) | |
| `product_name` | string | |
| `subscription_id` | string (uuid) | |
| `amount` | integer | intended initial authorization amount |
| `currency` | string | ISO-4217 |
| `processing_amount` / `processing_currency` | integer / string | amount as processed by the PSP |
| `marketing_amount` / `marketing_currency` | integer / string | converted (e.g. USD) amount |
| `refunded_amount` | integer | already refunded |
| `authorized_amount` | integer | total authorized |
| `status` | string enum: `processing`, `3ds_verify`, `refunded`, `auth_ok`, `auth_failed`, `settle_ok`, `partial_settled`, `void_ok` | on `auth_failed` an `error` object is returned at order level |
| `auth_code` | string | may be empty |
| `payment_type` | string enum: `1-click`, `recurring`, `retry`, `installment`, `rebill`, `moto` | CIT/MIT indicator |
| `payment_method` | string enum: `card`, `network-token`, `token`, `apple-pay`, `google-pay` | |
| `customer_account_id` | string | |
| `customer_email` | string | |
| `descriptor` | string | statement descriptor |
| `mid` | string | merchant identifier in Solidgate |
| `ip_address` | string | IPv4/IPv6 |
| `traffic_source` | string | |
| `fraudulent` | boolean | merchant-flagged suspicious customer |

### 2.2 `transaction` object (and each value of the `transactions` map)

| Field | Type | Notes |
|---|---|---|
| `id` | string | unique transaction identifier |
| `created_at` / `updated_at` | string | datetimes |
| `amount` / `currency` | integer / string | |
| `marketing_amount` / `marketing_currency` | integer / string | |
| `operation` | string enum: `recurring-auth`, `refund`, `resign-auth`, `auth`, `settle`, `void`, `apple-pay`, `google-pay` | |
| `status` | string enum: `processing`, `success`, `fail`, `verify` | on `fail`, an `error` object is returned at transaction level |
| `authorization_type` | string enum: `final`, `estimated`, `incremental` | |
| `scheme_transaction_id` | string | |
| `transaction_link_id` | string | Mastercard TLID |
| `descriptor` | string | |
| `billing_details` | object | `{ address, country (ISO-3166 a3), city, state (ISO 3166-2), zip }` |
| `refund_reason` | string | |
| `refund_reason_code` | string | |
| `card_token` | object | `{ token: string, original_payment_method: enum card|apple-pay|google-pay|network-token|click-to-pay }` |
| `card` | object | `{ bank, bin, brand, card_exp_month (string), card_exp_year (integer), card_holder, card_type: enum CREDIT|CREDIT/DEBIT|DEBIT|PREPAID|CHARGE CARD|DEFERRED DEBIT, is_reloadable (boolean), card_id (uuid), country (a3), number (masked), card_token {token, original_payment_method} }` |
| `error` | object | see 2.4 |
| `payment_account_reference` | string | PAR |
| `arn_code` | string | Acquirer Reference Number |
| `rrn_code` | string | Retrieval Reference Number (12 chars) |

### 2.3 `three_ds` object

| Field | Type |
|---|---|
| `eci` | string (Electronic Commerce Indicator) |
| `flow` | string enum: `frictionless`, `challenge`, `none`, `unspecified` (null = 3DS not initiated) |
| `exception` | string enum: `low_value`, `transaction_risk_assessment` |

### 2.4 `error` object (order-level and transaction-level)

Discriminated on `code` (`SchemaCardsDiscriminatorErrorSuccess`). General shape (`SchemaCardsError`,
required: `code`, `messages`):

| Field | Type | Notes |
|---|---|---|
| `code` | string | REQUIRED. Gateway error code, e.g. `3.08` |
| `messages` | array of string-or-object | REQUIRED. e.g. `["Do not honor"]` |
| `recommended_message_for_user` | string | recommended next steps for the end user |
| `merchant_advice_code` | string | Mastercard MAC, when present |

---

## 3. Chargeback webhook (`webhook-chargeback`)

Spec: `x-webhooks.Chargeback.post`, schema `RequestCardsWebhookChargeback`
(title `RequestWebhookCardsChargeback`). Event type: `card_gate.chargeback.received`.
No `required` array at root.

```
{
  order: { order_id, amount, currency, status }
  chargeback: { ... }            # see 3.1
  chargeback_flow: [ { ... } ]   # array, see 3.2
}
```

`order.status` enum: `processing`, `3ds_verify`, `refunded`, `auth_ok`, `auth_failed`,
`settle_ok`, `partial_settled`, `void_ok`. `order_id` string maxLength 255.

### 3.1 `chargeback` object

| Field | Type | Notes |
|---|---|---|
| `id` | integer | unique chargeback identifier |
| `dispute_date` | string datetime | created by issuer |
| `settlement_date` | string datetime | financially settled |
| `amount` | integer | may differ from order amount |
| `currency` | string (3) | |
| `type` | string enum: `1st_chb`, `2nd_chb`, `arbitration` | current type |
| `status` | string enum: `in_progress`, `document_sent`, `reversed`, `accepted`, `resolved`, `resolved_reversal` | |
| `reason_group` | string | reason code group |
| `reason_code` | string | card-scheme reason code |
| `reason_description` | string | |
| `available_actions` | array of string enum: `enrich_evidence`, `provide_evidence` | actions available in current state |

### 3.2 `chargeback_flow` array items

| Field | Type | Notes |
|---|---|---|
| `id` | integer | chargeback flow identifier |
| `date` / `updated_date` | string datetime | created / updated |
| `settlement_date` | string datetime | |
| `deadline_date` | string datetime | dispute response deadline |
| `amount` | integer | amount at this stage |
| `dispute_amount` | integer | amount returned to merchant if won |
| `currency` | string (3) | |
| `type` | string enum: `1st_chb`, `2nd_chb`, `arbitration` | |
| `status` | string enum: `in_progress`, `document_sent`, `reversed`, `accepted`, `resolved`, `resolved_reversal` | |
| `represented_by` | string enum: `merchant`, `automation` | who provided the defense document |
| `arn_code` | string | |
| `rrn_code` | string (12) | |

Note: `chargebacks` embedded in the card order status webhook (section 2) has the same field set
as 3.1 (minus `available_actions`) with `chargeback_flow` nested inside it.
