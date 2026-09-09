# Realistic Failure Modes and Fixes

These are concrete risks in a full-snapshot quiz implementation.

## 1. A normal step save is lost

**How it happens:** the current frontend fires the request without awaiting it. The visitor closes the tab, navigates away, or loses mobile connectivity before the request completes.

**Impact:** resuming can return the visitor to an older step with missing recent answers.

**Fix:** serialize saves in a per-session queue, keep failed snapshots locally, retry on reconnect, and await the final lead/completion save before routing away.

## 2. An older request overwrites a newer snapshot

**How it happens:** two full-snapshot requests are in flight. The newer one reaches the database first, then the older one arrives and replaces `quiz_answers`.

**Impact:** recently answered questions disappear.

**Fix:** add `sessions.revision`; update with `WHERE id = :id AND revision = :expectedRevision`, increment atomically, and return `409` when no row matches. Also serialize frontend saves.

## 3. An empty or malformed snapshot wipes valid answers

**How it happens:** a store hydration bug or bad client submits `{}` or wrong value types. The current route trusts and replaces the JSON object.

**Impact:** valid progress is destroyed or later scoring breaks.

**Fix:** validate the entire snapshot against the session's immutable quiz definition. Reject unexplained key removal after the session has progressed unless the product explicitly supports branch cleanup.

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

**Fix:** the completion service calculates results from the stored, validated snapshot and a versioned scoring definition. The client only requests completion.
