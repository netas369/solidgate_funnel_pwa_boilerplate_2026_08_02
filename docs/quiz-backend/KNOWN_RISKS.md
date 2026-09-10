# Realistic Failure Modes and Fixes

These are concrete risks when the full current answer object is saved into one session row.

## 1. A normal step save is lost

**How it happens:** the current frontend fires the request without awaiting it. The visitor closes the tab, navigates away, or loses mobile connectivity before the request completes.

**Impact:** resuming can return the visitor to an older step with missing recent answers.

**Fix:** serialize saves in a per-session queue, keep failed progress locally, retry on reconnect, and await the final lead/completion save before routing away.

## 2. An older request overwrites newer answers

**How it happens:** two complete-answer save requests are in flight. The newer one reaches the database first, then the older one arrives and replaces `quiz_answers`.

**Impact:** recently answered questions disappear.

**Fix:** add `sessions.revision`; update with `WHERE id = :id AND revision = :expectedRevision`, increment atomically, and return `409` when no row matches. Also serialize frontend saves.

## 3. An empty or malformed save wipes valid answers

**How it happens:** a store hydration bug or bad client submits `{}` or wrong value types. An unsafe route trusts and replaces the JSON object.

**Impact:** valid progress is destroyed or later scoring breaks.

**Fix:** validate the entire answer object against the session's immutable quiz definition. Reject unexplained key removal after the session has progressed unless the product explicitly supports branch cleanup.

## 4. Duplicate funnel events inflate reports

**How it happens:** page refresh resets in-memory deduplication, or a failed client request is retried after the database already committed it.

**Impact:** conversion counts and step drop-off reports become inaccurate.

**Fix:** require a unique `event_id`, add a database unique constraint, and treat duplicate IDs as success.

## 5. State and event history disagree

**How it happens:** session update succeeds but the separate event insert fails, or the event insert races before the session exists.

**Impact:** the user can resume correctly while analytics shows the wrong funnel path.

**Fix:** write state and its required milestone event in one backend transaction. Keep optional third-party analytics outside that transaction.

## 6. A quiz edit breaks old sessions

**How it happens:** a question key, option code, branch, or scoring weight changes in place while unfinished sessions still use it.

**Impact:** resumed answers no longer validate or produce a different result than originally intended.

**Fix:** persist immutable `quiz_variant` on creation. Create a new variant for behavioral changes; never modify a version already referenced by sessions.

## 7. Email-only recovery loads another person's answers

**How it happens:** a visitor enters an email already used by another session, mistypes an address, or uses a shared address.

**Impact:** private quiz answers can be exposed and the wrong profile can be reused.

**Fix:** recover with authenticated ownership, OTP verification, or a signed single-session recovery link. Never treat an email string by itself as proof of access.

## 8. Client-supplied result is manipulated

**How it happens:** the browser sends `result_segment` or score JSON and the backend accepts it.

**Impact:** offer segmentation, reporting, or personalization can be falsified.

**Fix:** the completion service calculates results from the stored, validated answers and a versioned scoring definition. The client only requests completion.

## 9. Meta crawlers inflate first-screen traffic

**How it happens:** a Meta link-preview, ad, indexing, or AI crawler reaches the Quiz and is treated like a real visitor during automatic session creation.

**Impact:** `sessions` and `quiz_started` counts increase without a person ever seeing or using the Quiz, making first-screen drop-off look worse.

**Fix:** keep creating sessions when the screen becomes active so genuine zero-click exits remain visible, but reject explicit Meta crawler User-Agent tokens before cookie signing or database access. Do not use `fbclid`, a Meta referrer, `FBAN`, `FBAV`, or `Instagram` as bot evidence because real ad visitors carry them. User-Agent filtering improves reporting quality but is not a security boundary; use edge bot management or a challenge only if disguised automated abuse becomes material.

## 10. Device or country reports are not exact

**How it happens:** an iPad uses a desktop-style User-Agent, or a visitor uses a VPN, proxy, carrier NAT or privacy relay. Deployment geolocation headers can be absent locally.

**Impact:** some device/country rows become `unknown` or are grouped under the network exit location.

**Fix:** prefer Client Hints plus explicit tablet rules, retain `unknown` instead of guessing, use Vercel/Cloudflare country headers when available, and treat location as approximate analytics rather than identity or authorization.

## 11. A/B variants change unexpectedly

**How it happens:** the browser chooses its own variant, random assignment runs on every session, a visitor cookie is ignored, or weights are edited without changing the experiment name.

**Impact:** one person can see different experiences and experiment results become hard to interpret.

**Fix:** assign on the server from the stable visitor UUID, validate weighted configuration, persist the chosen variant on session creation, and change `FUNNEL_EXPERIMENT_KEY` only when starting a new experiment. Cookie deletion can still produce a new anonymous visitor and bucket.
