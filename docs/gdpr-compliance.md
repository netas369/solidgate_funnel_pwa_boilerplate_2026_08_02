# GDPR Compliance Audit & Implementation Guide

> ## ⚠️ READ THIS FIRST — this is a TEMPLATE, not a statement about your product
>
> This document was written as an audit of the **predecessor product** this
> boilerplate was extracted from. It is kept because the *structure* — the data
> inventory, the lawful-basis mapping, the DSR procedures, the processor list —
> is genuinely reusable, and rebuilding it from nothing is expensive.
>
> **Every specific claim in it must be re-verified against your own code and
> your own legal advice before you rely on any of it.** File paths, storage
> keys, retention periods and processor lists have all drifted.
>
> ### The consent decision you are inheriting
>
> The predecessor's owner decided to ship **without a cookie-consent banner**:
> analytics/marketing consent was treated as granted by default and all
> trackers (PostHog, GTM, Meta Pixel/CAPI, Vercel Analytics) load unconditionally.
> **The boilerplate still behaves that way.**
>
> That was one company's risk decision for one product, taken with their own
> counsel. It is **not** a default you should inherit unexamined, and it is not
> legal advice. If you serve the EU/UK, decide this deliberately before launch.
> The sections below that describe consent gating were written for that removed
> implementation and are a reasonable starting point if you decide to add one.

**Project:** _(your product)_
**Original audit date:** 2026-04-09 (against the predecessor product)
**Applicable law:** GDPR (EU 2016/679), ePrivacy Directive (2002/58/EC), EU Consumer Rights Directive (2011/83/EU)

---

## Table of Contents

1. [Data Inventory](#1-data-inventory)
2. [Critical Violations (P0)](#2-critical-violations-p0)
3. [High Priority Issues (P1)](#3-high-priority-issues-p1)
4. [Medium Priority Issues (P2)](#4-medium-priority-issues-p2)
5. [Lower Priority Issues (P3)](#5-lower-priority-issues-p3)
6. [Third-Party Data Processors](#6-third-party-data-processors)
7. [Implementation Roadmap](#7-implementation-roadmap)

---

## 1. Data Inventory

### 1.1 Personal Data Collected

| Data Category | Data Fields | Collection Point | Storage Location | Retention | Legal Basis Needed |
|---------------|-------------|-----------------|------------------|-----------|-------------------|
| **Email address** | `email` | Quiz email capture step (`apps/funnel/src/features/quiz/components/steps/email-capture-step.tsx`) | Supabase `sessions.email`; may also be part of the seven-day `quiz-store` recovery state | Indefinite on the server until a product retention policy is configured | Consent (Art. 6(1)(a)) |
| **Health-related quiz answers** | `quiz_answers` (JSONB) | Quiz step selections (`apps/funnel/src/stores/quiz-store.ts`) | Supabase `sessions.quiz_answers`, localStorage `quiz-store` | Indefinite (no policy) | Explicit consent (Art. 9(2)(a))  -  special category |
| **Behavioral segment** | `result_segment` | Quiz completion | Supabase `sessions.result_segment` | Indefinite (no policy) | Legitimate interest or consent |
| **Payment identifiers** | `stripe_customer_id`, `default_payment_method`, `stripe_payment_intent_id` | Stripe checkout | Supabase `sessions`, `stripe_customers`, `orders` | Indefinite (no policy) | Contract (Art. 6(1)(b)) |
| **Order history** | `amount_cents`, `currency`, `status`, `product_name` | Purchases | Supabase `orders` | Indefinite (no policy) | Contract + legal obligation (Art. 6(1)(b), (c)) |
| **Listening progress** | `day_number`, `listen_duration_seconds`, `language` | PWA session player | Supabase `user_progress` | Indefinite (no policy) | Contract (Art. 6(1)(b)) |
| **OTP login attempts** | `email`, `ip_address`, `success`, `attempted_at` | Login flow | Supabase `otp_attempts` | Indefinite (no policy) | Legitimate interest (Art. 6(1)(f))  -  security |
| **Funnel behavior events** | `event_type`, `step_number`, `metadata` | Every quiz/OTO interaction | Supabase `funnel_events` | Indefinite (no policy) | Consent (Art. 6(1)(a)) |
| **Entitlements** | `product_slug`, `access_level`, `granted_at`, `expires_at` | Purchases | Supabase `entitlements` | Indefinite (no policy) | Contract (Art. 6(1)(b)) |

### 1.2 Cookies & Client-Side Storage

| Identifier | Type | Data Stored | Duration | Essential? | Consent Required? |
|------------|------|-------------|----------|------------|-------------------|
| `payment_access` | HTTP cookie (HttpOnly, Secure, SameSite=Lax) | HMAC-signed `paymentIntentId:sessionId` | 90 minutes | Yes  -  payment flow | No (strictly necessary) |
| Supabase auth cookies | HTTP cookie | Auth session token | Session | Yes  -  authentication | No (strictly necessary) |
| PostHog cookies | JS cookie | Analytics identifiers, session replay | Varies (up to 1 year) | No  -  analytics | **Yes** |
| `_fbp`, `_fbc` | JS cookie | Meta browser identifier and ad-click attribution | Up to 90 days in this template | No - marketing attribution | **Yes** |
| `quiz-store` | localStorage | Full quiz answers, session ID, step history | 7 days from the latest persisted change | Debatable  -  UX recovery | **Yes** (contains PII + health data) |
| `solidgate_main_recovery_v1` | localStorage | Payment recovery handle | Until cleared | Yes  -  payment recovery | No (no PII) |

> The predecessor also stored a product-specific onboarding flag here. Re-run
> this inventory against your own build: `grep -rn "localStorage\." apps/*/src`.

### 1.3 Third-Party Data Flows

| Service | Role | Data Sent | Server Location | Purpose |
|---------|------|-----------|-----------------|---------|
| **PostHog** | Processor | Session ID, email (raw), event names, event metadata, page URLs | EU (`eu.i.posthog.com`) | Product analytics, funnel tracking |
| **Google Tag Manager** | Processor / Controller | Hashed email (SHA-256), session ID, event names, metadata | US (Google) | Retargeting, conversion tracking, audience building |
| **Meta Pixel / Conversions API** | Processor / Controller | Hashed email and session ID, `_fbp`, `_fbc`, IP, User-Agent, source URL, safe campaign/event/product/revenue context; no quiz answers or result profile | Verify the contracted Meta region/transfers | Attribution, retargeting, conversion optimization |
| **Stripe** | Processor | Email, payment card (tokenized), amounts, customer ID, metadata | US (Stripe Inc.) | Payment processing |
| **Vercel Analytics** | Processor | Page URLs, Web Vitals, referrer, user agent | US (Vercel Inc.) | Performance monitoring |
| **Vercel Speed Insights** | Processor | Page load metrics, connection type | US (Vercel Inc.) | Real User Monitoring |
| **Supabase** | Processor | All database contents (sessions, orders, events, progress, auth) | Check project region | Database, authentication, edge functions |

---

## 2. Critical Violations (P0)

These must be fixed before going live. Each one represents a direct violation of EU law.

---

### 2.1 No Cookie Consent Banner

**What's wrong:**
All analytics and tracking scripts load immediately when a user visits the site, before any consent is given. PostHog initializes in `apps/funnel/src/app/_components/providers.tsx`, GTM loads in `apps/funnel/src/app/layout.tsx`, and Vercel Analytics/Speed Insights render unconditionally.

**Why it matters:**
The ePrivacy Directive (Article 5(3)) and GDPR (Article 6-7) require informed, freely given consent before storing non-essential cookies or sending data to analytics providers. "Non-essential" means anything that isn't strictly necessary for the service the user requested. Analytics, retargeting, and behavioral tracking are never strictly necessary.

Fines for cookie violations are common. The French DPA (CNIL) fined Google EUR 150 million and Facebook EUR 60 million specifically for making cookie rejection harder than acceptance.

**What to implement:**

1. **Consent banner UI**  -  Must appear on first visit. Must offer equal-weight "Accept" and "Reject" buttons (no dark patterns  -  the reject option cannot be hidden behind "Manage preferences"). Must list categories: Necessary, Analytics, Marketing.

2. **Consent gate**  -  PostHog, GTM, Vercel Analytics, and Speed Insights must NOT load until the user clicks "Accept". This means:
   - Move PostHog initialization behind a consent check
   - Conditionally render `<GoogleTagManager>`, `<Analytics>`, `<SpeedInsights>` based on consent state
   - Store consent decision in a cookie (this cookie itself IS strictly necessary, so it doesn't need consent)

3. **Consent persistence**  -  Store the user's choice in a `cookie_consent` cookie with categories: `{ analytics: boolean, marketing: boolean, timestamp: string }`. Respect this on subsequent visits.

4. **Consent withdrawal**  -  Users must be able to change their mind. Add a "Cookie Settings" link in the footer that reopens the banner.

**Files to modify:**
- `apps/funnel/src/app/_components/providers.tsx`  -  gate PostHog init
- `apps/funnel/src/app/layout.tsx`  -  conditionally render GTM, Analytics, SpeedInsights
- `apps/funnel/src/features/analytics/hooks/use-analytics.ts`  -  check consent before dispatching events
- `apps/funnel/src/features/analytics/lib/posthog.ts`  -  add consent check
- `apps/funnel/src/features/analytics/lib/gtm.ts`  -  add consent check
- New: cookie consent banner component
- New: cookie consent context/store

**Affected pages:** Every page on the funnel site.

---

### 2.2 No Privacy Policy Page

**What's wrong:**
The site footer links to `/privacy` but the page doesn't exist  -  it returns 404. Same for `/terms`, `/cookies`, and `/contact`.

**Why it matters:**
GDPR Article 13 requires that at the point of data collection, you provide: your identity, purpose of processing, legal basis, data recipients, retention periods, and user rights. A privacy policy is the standard way to fulfill this. Without it, every single data collection point on the site is non-compliant.

**What the privacy policy must contain** (per Article 13):

1. **Identity and contact details**  -  Company name, address, email, DPO contact (if applicable)
2. **What data is collected**  -  Use the data inventory in Section 1 above
3. **Purpose of each data type**  -  Why you collect it (quiz personalization, payment processing, analytics, retargeting)
4. **Legal basis for each purpose**  -  Consent, contract performance, legitimate interest, or legal obligation
5. **Data recipients**  -  List all third parties (PostHog, Stripe, Google/GTM, Vercel, Supabase)
6. **International transfers**  -  Stripe, Google, Vercel are US-based. Document the transfer mechanism (Standard Contractual Clauses, adequacy decision, etc.)
7. **Retention periods**  -  How long each data type is kept (you need to define these  -  see Section 3.3)
8. **User rights**  -  Right to access, rectification, erasure, restrict processing, data portability, object, withdraw consent
9. **How to exercise rights**  -  Contact email or form
10. **Right to lodge complaint**  -  With the relevant supervisory authority
11. **Whether data provision is required**  -  Email is required for quiz results; payment data is required for purchase
12. **Automated decision-making**  -  If quiz segmentation constitutes automated profiling, disclose it

**Files to create:**
- `apps/funnel/src/app/(legal)/privacy/page.tsx`
- `apps/funnel/src/app/(legal)/terms/page.tsx`
- `apps/funnel/src/app/(legal)/cookies/page.tsx`
- `apps/funnel/src/app/(legal)/contact/page.tsx`
- Also link these from the PWA if users access it independently

---

### 2.3 No Consent on Email Capture

**What's wrong:**
The email capture step (`apps/funnel/src/features/quiz/components/steps/email-capture-step.tsx`) collects email with only the text "No spam. Unsubscribe anytime." There is no consent checkbox, no link to the privacy policy, and no explanation of what the email will be used for. The email is immediately sent to PostHog (`posthog.identify(sessionId, { email })`) and stored in Supabase.

**Why it matters:**
GDPR Article 6(1)(a) requires consent to be "freely given, specific, informed and unambiguous." Article 7 requires that consent be demonstrable  -  you must be able to prove the user consented. A text line saying "no spam" is not consent. It doesn't tell the user:
- Who will receive their email (PostHog, potentially GTM audiences)
- That their email will be linked to their quiz answers
- That their email will be used for retargeting
- How to withdraw consent

For health-related quiz data specifically, Article 9 requires **explicit consent**  -  a clear affirmative action specifically for the processing of special category data.

**What to implement:**

1. **Consent checkbox** (unchecked by default) with text like:
   > "I agree to the processing of my email and quiz responses as described in the [Privacy Policy](/privacy). I understand my data will be used to provide personalized results and may be shared with analytics providers."

2. **Separate marketing consent** (optional, unchecked by default):
   > "I'd like to receive tips and offers by email. I can unsubscribe at any time."

3. **Privacy policy link**  -  Must be clickable and lead to the actual privacy policy page.

4. **Record consent**  -  Store a timestamp and version of the consent text in the database. Add columns to `sessions`:
   - `consent_given_at TIMESTAMPTZ`
   - `consent_version TEXT`
   - `marketing_consent BOOLEAN DEFAULT false`

5. **Don't send to PostHog without consent**  -  Gate `posthog.identify()` behind analytics consent from the cookie banner. Gate email storage behind the data processing consent checkbox.

**Files to modify:**
- `apps/funnel/src/features/quiz/components/steps/email-capture-step.tsx`  -  add checkbox + privacy link
- `apps/funnel/src/features/analytics/lib/posthog.ts`  -  gate `identify()` behind consent
- `apps/funnel/src/app/api/session/persist/route.ts`  -  accept and store consent fields
- New migration: add consent columns to `sessions` table

---

### 2.4 OTO One-Click Charges Without Proper Consent

**What's wrong:**
After the initial purchase, OTO pages (1 through 7) charge the user's saved card with a single button click. The button does not show the amount being charged, does not require explicit confirmation, and does not display terms. The only disclosure is on the main offer page: "Your card will be securely saved for one-click upgrades on the next screens."

**Affected files:**
- `apps/funnel/src/features/oto/components/oto1-page.tsx`  -  Advisory Board trial (EUR 0 then EUR 27/week)
- `apps/funnel/src/features/oto/components/oto2-page.tsx` through `oto7-page.tsx`  -  Digital products
- `apps/funnel/src/features/oto/components/oto-lifetime-page.tsx`  -  Lifetime access
- `apps/funnel/src/features/checkout/hooks/use-off-session-checkout.ts`  -  Off-session charge logic

**Why it matters:**

**EU Consumer Rights Directive, Article 8(2):**
> "The trader shall ensure that the consumer, when placing his order, explicitly acknowledges that the order implies an obligation to pay. If placing an order entails activating a button or a similar function, the button or similar function shall be labelled in an easily legible manner only with the words 'order with obligation to pay' or a corresponding unambiguous formulation..."

If the button is not properly labeled, **the consumer is not bound by the contract or order**. This means chargebacks are legally justified, and you cannot enforce payment.

**GDPR Article 6(1)(b):**
Off-session charges require a valid contract. Without proper Article 8(2) compliance, there is no valid contract, so there is no legal basis for processing the payment data.

**What to implement:**

1. **Show the exact amount** on or near the button: "EUR 47.00" (or whatever the OTO price is)

2. **Label the button** with obligation language. Examples that comply:
   - "Order with obligation to pay  -  EUR 47.00"
   - "Buy now  -  EUR 47.00"
   - "Pay EUR 47.00"
   
   Examples that do NOT comply:
   - "Yes, add this!"
   - "Upgrade now"
   - "Get instant access"

3. **Show a brief summary** before the button:
   - Product name
   - Price (including VAT)
   - If subscription: billing frequency and how to cancel
   - For OTO1 (trial): clearly state "EUR 0 now, then EUR 27/week after 7 days. Cancel anytime."

4. **Link to terms** near the payment button

5. **Confirmation step**  -  Consider adding a confirmation modal for charges over a threshold, though this is not strictly required if the button is properly labeled.

**Files to modify:**
- All `apps/funnel/src/features/oto/components/oto*-page.tsx` files  -  update button labels and add price display
- `apps/funnel/src/features/checkout/hooks/use-off-session-checkout.ts`  -  pass price info to the hook for display
- Shared price/product config  -  ensure prices are accessible to frontend components

---

### 2.5 Health Data Without Explicit Consent (Special Category)

**What's wrong:**
Quiz answers likely include health-related information  -  weight, stress levels, sleep patterns, health goals, behavioral assessments. Under GDPR, this is "special category data" which has stricter requirements than regular personal data. The quiz currently collects this data with no consent mechanism at all.

**Why it matters:**
GDPR Article 9(1) prohibits processing of health data unless an exception in Article 9(2) applies. The most practical exception is Article 9(2)(a): **explicit consent**. "Explicit" means more than a pre-ticked box  -  it requires a clear, affirmative statement specifically for the health data processing.

The consequences of getting this wrong are severe. Supervisory authorities treat health data violations as "high gravity"  -  the Italian DPA fined a company EUR 75,000 specifically for processing health data without explicit consent.

**What to implement:**

1. **Before the quiz begins**, show a clear notice:
   > "This quiz asks about your health and wellbeing. Your answers will be used to generate a personalized recommendation. By starting the quiz, you explicitly consent to the processing of your health-related responses as described in our [Privacy Policy](/privacy)."

2. **Require affirmative action**  -  Either a checkbox or a clearly labeled "I consent and want to start" button (not just "Start quiz").

3. **Record explicit consent separately** from general data processing consent. Add to database:
   - `health_data_consent_at TIMESTAMPTZ`
   - `health_data_consent_version TEXT`

4. **Allow withdrawal**  -  If a user withdraws health data consent, you must delete their quiz answers (not just stop collecting new ones).

**Files to modify:**
- `apps/funnel/src/features/quiz/components/quiz-page.tsx`  -  add pre-quiz consent gate
- New migration: add health consent columns
- `apps/funnel/src/app/api/session/persist/route.ts`  -  store consent records

---

## 3. High Priority Issues (P1)

These should be fixed before or shortly after launch. They represent significant compliance gaps.

---

### 3.1 No Right to Erasure (Account Deletion)

**What's wrong:**
There is no way for users to delete their account or request data deletion. The PWA settings page (`apps/pwa/src/features/settings/components/settings-content.tsx`) shows email and subscription status but has no deletion option.

**Why it matters:**
GDPR Article 17 gives users the right to erasure ("right to be forgotten"). You must delete personal data when:
- The user withdraws consent
- The data is no longer necessary for the purpose it was collected
- The user objects to processing based on legitimate interest
- The data was unlawfully processed

You must respond to deletion requests within 30 days. If you have no mechanism, you cannot comply.

**What to implement:**

1. **"Delete my account" button** in PWA settings with confirmation dialog explaining:
   - What will be deleted (account, quiz data, progress, orders metadata)
   - What will be retained (financial records for legal obligations  -  you can keep order amounts and dates for tax purposes, but must anonymize the personal identifiers)
   - That deletion is irreversible
   - That active subscriptions will be cancelled

2. **API endpoint** `DELETE /api/user/delete` that:
   - Cancels any active Stripe subscriptions
   - Deletes from `user_progress`
   - Deletes from `entitlements`
   - Anonymizes `sessions` (null out email, quiz_answers, set user_id to null)
   - Anonymizes `orders` (keep amount/date for accounting, null out user_id, session_id)
   - Deletes from `otp_attempts` where email matches
   - Deletes from `stripe_customers`
   - Deletes Supabase auth user
   - Optionally: request deletion from Stripe Customer API
   - Optionally: request deletion from PostHog

3. **Email-based requests**  -  Even without an account, users who only completed the quiz (no purchase) should be able to email you to request deletion. Document this in the privacy policy.

**Files to create/modify:**
- New: `apps/pwa/src/app/api/user/delete/route.ts`
- `apps/pwa/src/features/settings/components/settings-content.tsx`  -  add delete button
- New migration: create a `deletion_requests` audit table (who requested, when, what was deleted)

---

### 3.2 No Right to Access / Data Export

**What's wrong:**
There is no way for users to download or view all data held about them.

**Why it matters:**
GDPR Article 15 (right of access) requires that you provide, on request, a copy of all personal data you hold about the user. Article 20 (right to data portability) requires that this be in a "structured, commonly used and machine-readable format" (typically JSON or CSV). You must respond within 30 days.

**What to implement:**

1. **"Download my data" button** in PWA settings

2. **API endpoint** `GET /api/user/export` that returns a JSON file containing:
   ```json
   {
     "account": { "email": "...", "created_at": "..." },
     "quiz_responses": { "answers": {...}, "segment": "..." },
     "orders": [{ "product": "...", "amount": "...", "date": "...", "status": "..." }],
     "entitlements": [{ "product": "...", "access_level": "...", "expires": "..." }],
     "progress": [{ "day": 1, "completed": "...", "duration_seconds": 120 }],
     "consent_records": [{ "type": "...", "given_at": "...", "version": "..." }],
     "funnel_events": [{ "type": "...", "step": 1, "timestamp": "..." }]
   }
   ```

3. **Rate limit**  -  One export per 24 hours to prevent abuse.

**Files to create/modify:**
- New: `apps/pwa/src/app/api/user/export/route.ts`
- `apps/pwa/src/features/settings/components/settings-content.tsx`  -  add export button

---

### 3.3 No Data Retention Policy

**What's wrong:**
All data is stored indefinitely. There are no cleanup jobs, no TTLs, no archival processes. The `sessions` table accumulates forever, `otp_attempts` (which contain IP addresses) are never pruned, and abandoned quiz sessions with email addresses sit in the database permanently.

**Why it matters:**
GDPR Article 5(1)(e)  -  the "storage limitation" principle  -  requires that personal data be "kept in a form which permits identification of data subjects for no longer than is necessary for the purposes for which the personal data are processed."

Keeping abandoned quiz data from 2 years ago serves no purpose and creates unnecessary liability.

**Recommended retention periods:**

| Data | Retention Period | Justification |
|------|-----------------|---------------|
| Abandoned sessions (no purchase, no auth) | 90 days | No ongoing relationship; quiz curiosity doesn't justify permanent storage |
| Sessions with purchase (anonymized) | 7 years | Tax/accounting legal obligation (varies by EU country  -  7 years covers most) |
| Funnel events | 90 days (anonymous) or 2 years (linked to purchase) | Analytics value diminishes; aggregate stats can be kept indefinitely |
| OTP attempts | 30 days | Security purpose fulfilled; IP addresses are PII |
| User progress | Duration of account + 30 days after deletion | Service delivery |
| Orders (financial records) | 7 years (anonymized after account deletion) | Tax/accounting legal obligation |
| Entitlements | Duration of account | Service delivery |
| localStorage (`quiz-store`) | 7 days (auto-clear via JS) | Session recovery; permanent storage is excessive |

**What to implement:**

1. **Supabase cron job or Edge Function** that runs daily:
   - Delete sessions older than 90 days with no `user_id` and no linked order
   - Delete `otp_attempts` older than 30 days
   - Delete `funnel_events` older than 90 days where session has no purchase

2. **Review the implemented `quiz-store` seven-day TTL** for each product and shorten it if the quiz collects especially sensitive data.

3. **Document retention periods** in the privacy policy.

**Files to create/modify:**
- New: `supabase/functions/data-cleanup/index.ts`  -  scheduled cleanup function
- `apps/funnel/src/stores/quiz-store.ts`  -  adjust the implemented TTL if the product requires a shorter recovery window

---

### 3.4 No Purchase Confirmation Email

**What's wrong:**
After a successful payment, no confirmation email is sent. No receipt, no access link, no record of what was purchased.

**Why it matters:**
The EU Consumer Rights Directive (Article 8(7)) requires that the trader provide confirmation of the contract on a "durable medium" (email counts) within a reasonable time after the conclusion of the contract. This confirmation must include:
- The main characteristics of the goods/services
- The total price including taxes
- The right of withdrawal (14-day cooling-off period for digital content, with exceptions)
- Trader identity and contact details

**What to implement:**
- Transactional email via Supabase Edge Function (triggered by `payment_intent.succeeded` webhook) or a third-party email service (Resend, Postmark, etc.)
- Include: product name, price paid, date, access link to PWA, cancellation info for subscriptions, contact details
- For OTO1 (trial subscription): clearly state when the trial ends and what the recurring charge will be

---

### 3.5 Unencrypted PII in localStorage

**What's wrong:**
The redundant `funnel_pending_leads` copy has been removed. The Quiz store (`apps/funnel/src/stores/quiz-store.ts`) still persists answers for interrupted-session recovery, but now rejects state older than seven days. Anyone with physical or remote access to the browser during that period may still read this data.

**Why it matters:**
GDPR Article 32 requires "appropriate technical and organisational measures" to ensure data security. Storing health-related data and email addresses in plaintext client-side storage is not appropriate. While localStorage is same-origin, it's accessible to any JavaScript running on the page (including injected scripts from GTM tags or browser extensions).

**What to implement:**
- **Option A (highest privacy):** Don't store answers in localStorage. Use the Quiz-owned `/api/quiz/session/save` endpoint and retain only the session UUID locally. The tradeoff is losing an answer typed while the visitor is offline and reloads before it can be saved.
- **Option B (current boilerplate):** Keep the short-lived recovery cache, enforce the seven-day TTL, and shorten the period for products that collect especially sensitive answers.

---

## 4. Medium Priority Issues (P2)

---

### 4.1 Data Processing Agreements (DPAs)

**What's wrong:**
No DPAs are documented or referenced for any third-party processor.

**Why it matters:**
GDPR Article 28 requires a written contract (DPA) with every data processor. This isn't optional  -  it's a legal requirement. The DPA must specify: subject matter, duration, nature/purpose of processing, data types, and obligations of the processor.

**What to do:**
1. **PostHog**  -  Sign PostHog's standard DPA (available at posthog.com/dpa). Already using EU instance, which is good.
2. **Stripe**  -  Stripe's DPA is built into their terms of service. Verify it covers your use case.
3. **Vercel**  -  Sign Vercel's DPA (available in account settings or legal page).
4. **Supabase**  -  Sign Supabase's DPA (available at supabase.com/legal). Confirm your project is in an EU region.
5. **Google (GTM)**  -  If using GTM with Google Ads or Google Analytics tags, accept Google's data processing terms in Google Ads/Analytics settings.

**Keep a record** of all signed DPAs. List all sub-processors in your privacy policy.

---

### 4.2 Weak Email Hashing for GTM

**What's wrong:**
`apps/funnel/src/features/analytics/lib/hash-email.ts` sends SHA-256 hashed emails to GTM alongside session IDs. The hash is sent to the GTM dataLayer, where it can be picked up by any tag configured in GTM (Google Ads, Facebook Pixel, etc.).

**Why it matters:**
A SHA-256 hash of an email is still personal data under GDPR. The Article 29 Working Party (now EDPB) has stated that hashing alone does not constitute anonymization  -  it's pseudonymization. The hash can be reversed via rainbow tables or matched against known email databases. Combined with the session ID (which links to quiz answers and orders), re-identification is trivial.

**What to do:**
- Gate GTM loading behind marketing consent (see Section 2.1)
- If the user consents to marketing, hashed email in GTM is acceptable (it's pseudonymized, not anonymous, but consent covers it)
- If the user does NOT consent, do not push any data to GTM  -  not even hashed
- Consider whether you actually need email hashing in GTM, or if session-level conversion events are sufficient

---

### 4.3 Cookie Policy Page

**What's wrong:**
Footer links to `/cookies` but the page doesn't exist.

**What to include:**
1. List all cookies by category (Necessary, Analytics, Marketing)
2. For each cookie: name, provider, purpose, type (HTTP/JS), expiry
3. How to manage cookie preferences (link back to consent banner)
4. How to delete cookies via browser settings
5. Last updated date

---

### 4.4 Consent Audit Trail

**What's wrong:**
There's no record of when users gave or withdrew consent, or what version of the consent text they agreed to.

**Why it matters:**
GDPR Article 7(1): "Where processing is based on consent, the controller shall be able to demonstrate that the data subject consented." If challenged, you need to prove: who consented, when, to what, and how.

**What to implement:**
- New table: `consent_records`
  ```sql
  CREATE TABLE consent_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID REFERENCES sessions(id),
    user_id UUID REFERENCES auth.users(id),
    consent_type TEXT NOT NULL,          -- 'cookie_analytics', 'cookie_marketing', 'data_processing', 'health_data', 'marketing_email'
    granted BOOLEAN NOT NULL,
    consent_text_version TEXT NOT NULL,   -- e.g., 'v1.0'
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  ```
- Record every consent grant AND withdrawal
- Never delete consent records (they're your legal proof)

---

### 4.5 Missing Stripe Webhook Handlers

**What's wrong:**
The webhook handler (`supabase/functions/stripe-webhooks/index.ts`) only handles `payment_intent.succeeded` and `customer.subscription.created`. Missing handlers for:
- `payment_intent.payment_failed`
- `charge.refunded`
- `charge.dispute.created`
- `customer.subscription.deleted`

**Why it matters for GDPR:**
When a user disputes a charge or requests a refund, there may be an implicit data deletion request. When a subscription is cancelled, you need to know when to stop processing their data and when retention periods start.

---

## 5. Lower Priority Issues (P3)

---

### 5.1 Unsubscribe Promise Without Implementation

The email capture step says "Unsubscribe anytime" but no email marketing system exists. If you start sending marketing emails in the future, you need: double opt-in, unsubscribe link in every email, and prompt processing of unsubscribe requests.

**Immediate fix:** Remove the "Unsubscribe anytime" text until you actually have an email marketing system with unsubscribe functionality.

### 5.2 Settings Preferences Not Persisted

PWA settings toggles (daily reminder, streak reminder) are React state only  -  they reset on page reload. If these affect data processing (e.g., push notifications, email reminders), the user's preference must be persisted and respected.

### 5.3 No Age Verification

If the quiz collects health data, consider whether any users might be under 16 (the GDPR age of consent for data processing varies by EU member state, 13-16). If children might use the service, parental consent mechanisms are required under Article 8.

### 5.4 Automated Profiling Disclosure

The quiz segmentation (`result_segment`) constitutes automated profiling under GDPR Article 22. If the segment directly determines what product/price is shown (which it does  -  different OTO flows based on segment), users have the right to:
- Be informed that profiling is happening
- Obtain human intervention
- Express their point of view
- Contest the decision

Disclose this in the privacy policy.

### 5.5 Cross-Border Data Transfers

Stripe, Google, and Vercel are US-based. Post-Schrems II, EU-to-US transfers require Standard Contractual Clauses (SCCs) or reliance on the EU-US Data Privacy Framework (if the US company is certified). Verify each processor's transfer mechanism and document it in the privacy policy.

---

## 6. Third-Party Data Processors

### 6.1 Required Actions Per Processor

| Processor | DPA Status | Action Required |
|-----------|------------|-----------------|
| **PostHog** | Not signed | Sign DPA at posthog.com. Verify EU data residency. Configure to respect consent signals. |
| **Stripe** | Built into ToS | Review Stripe's processing terms. Verify EU entity handles EU payments. |
| **Google (GTM)** | Not signed | Accept Google Ads Data Processing Terms. Review what tags fire and what data each tag receives. |
| **Vercel** | Not signed | Sign DPA in Vercel dashboard. Document which Vercel services process personal data. |
| **Supabase** | Not signed | Sign DPA at supabase.com. Verify project is hosted in EU region. Enable audit logging. |

### 6.2 Sub-Processor Documentation

Your privacy policy must list all sub-processors (or link to a maintained list). Users have the right to object to new sub-processors under certain DPA terms.

---

## 7. Implementation Roadmap

### Phase 1  -  Legal Blockers (before launch)
1. Create privacy policy page (`/privacy`)
2. Create terms of service page (`/terms`)
3. Create cookie policy page (`/cookies`)
4. Implement cookie consent banner with analytics/marketing gates
5. Add consent checkbox to email capture step
6. Add health data consent gate before quiz
7. Fix OTO button labels with prices and obligation-to-pay language
8. Sign DPAs with all processors

### Phase 2  -  User Rights (within 30 days of launch)
1. Implement account deletion endpoint + UI
2. Implement data export endpoint + UI
3. Define and document data retention periods
4. Implement data cleanup cron job
5. Add consent audit trail table and recording

### Phase 3  -  Hardening (within 90 days of launch)
1. Remove PII from localStorage (or encrypt + TTL)
2. Implement purchase confirmation emails
3. Add missing Stripe webhook handlers
4. Add automated profiling disclosure to privacy policy
5. Verify cross-border transfer mechanisms
6. Remove "Unsubscribe anytime" text or implement email system
7. Persist settings preferences to database
8. Add contact page with data request submission form

---

## Appendix A: Files Referenced

| File | Section |
|------|---------|
| `apps/funnel/src/app/_components/providers.tsx` | 2.1 |
| `apps/funnel/src/app/layout.tsx` | 2.1, 2.2 |
| `apps/funnel/src/features/quiz/components/steps/email-capture-step.tsx` | 2.3 |
| `apps/funnel/src/features/quiz/components/quiz-page.tsx` | 2.5 |
| `apps/funnel/src/features/oto/components/oto1-page.tsx` (through oto7) | 2.4 |
| `apps/funnel/src/features/oto/components/oto-lifetime-page.tsx` | 2.4 |
| `apps/funnel/src/features/checkout/hooks/use-off-session-checkout.ts` | 2.4 |
| `apps/funnel/src/features/analytics/lib/posthog.ts` | 2.1, 2.3 |
| `apps/funnel/src/features/analytics/lib/gtm.ts` | 2.1, 4.2 |
| `apps/funnel/src/features/analytics/lib/hash-email.ts` | 4.2 |
| `apps/funnel/src/features/analytics/hooks/use-analytics.ts` | 2.1 |
| `apps/funnel/src/features/quiz/hooks/use-quiz-persistence.ts` | 3.5 |
| `apps/funnel/src/stores/quiz-store.ts` | 3.5 |
| `apps/funnel/src/app/api/session/persist/route.ts` | 2.3 |
| `apps/pwa/src/features/settings/components/settings-content.tsx` | 3.1, 3.2 |
| `packages/shared/src/payment-cookie.ts` | 1.2 |
| `packages/shared/src/payment-session-access.ts` | 1.2 |
| `packages/shared/src/auth/request-otp.ts` | 1.1 |
| `packages/shared/src/auth/verify-otp.ts` | 1.1 |
| `supabase/migrations/00001_initial_schema.sql` | 1.1 |
| `supabase/migrations/00009_sessions_stripe_customer.sql` | 1.1 |
| `supabase/migrations/00014_otp_attempts.sql` | 1.1 |
| `supabase/migrations/00018_rls_hardening.sql` | 1.1 |
| `supabase/migrations/00019_entitlements.sql` | 1.1 |
| `supabase/migrations/00024_user_progress.sql` | 1.1 |
| `supabase/functions/stripe-webhooks/index.ts` | 4.5 |

## Appendix B: GDPR Articles Referenced

| Article | Topic | Where It Applies |
|---------|-------|-----------------|
| Art. 5(1)(e) | Storage limitation | 3.3  -  Data retention |
| Art. 6(1)(a) | Consent as legal basis | 2.1, 2.3  -  Cookie consent, email consent |
| Art. 6(1)(b) | Contract performance | 1.1  -  Payment data, order data |
| Art. 6(1)(c) | Legal obligation | 1.1  -  Financial records retention |
| Art. 6(1)(f) | Legitimate interest | 1.1  -  OTP security |
| Art. 7 | Conditions for consent | 2.3, 4.4  -  Demonstrable consent |
| Art. 8 | Child consent | 5.3  -  Age verification |
| Art. 9 | Special categories (health) | 2.5  -  Quiz health data |
| Art. 13 | Information at collection | 2.2  -  Privacy policy |
| Art. 15 | Right of access | 3.2  -  Data export |
| Art. 17 | Right to erasure | 3.1  -  Account deletion |
| Art. 20 | Data portability | 3.2  -  Machine-readable export |
| Art. 22 | Automated profiling | 5.4  -  Quiz segmentation |
| Art. 28 | Processor agreements | 4.1  -  DPAs |
| Art. 32 | Security of processing | 3.5  -  localStorage encryption |
| ePrivacy Art. 5(3) | Cookie consent | 2.1  -  Consent banner |
| Consumer Rights Dir. Art. 8(2) | Order button labeling | 2.4  -  OTO payment buttons |
| Consumer Rights Dir. Art. 8(7) | Purchase confirmation | 3.4  -  Confirmation emails |
