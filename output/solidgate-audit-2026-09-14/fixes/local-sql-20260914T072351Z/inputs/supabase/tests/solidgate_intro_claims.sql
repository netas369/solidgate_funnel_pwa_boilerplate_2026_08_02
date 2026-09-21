\set ON_ERROR_STOP on

DO $$
DECLARE
  s1 UUID; s2 UUID; s3 UUID;
  h  TEXT := repeat('a', 64);
  h2 TEXT := repeat('b', 64);
  h3 TEXT := repeat('c', 64);
  r  TEXT;
  arr TEXT[];
  n INTEGER;
BEGIN
  INSERT INTO public.sessions (locale) VALUES ('en') RETURNING id INTO s1;
  INSERT INTO public.sessions (locale) VALUES ('en') RETURNING id INTO s2;
  INSERT INTO public.sessions (locale) VALUES ('en') RETURNING id INTO s3;

  -- ── Regression guard: everything the previous round already proved ───────
  r := public.claim_solidgate_intro_offer('production', h, s1, 'trial1');
  ASSERT r = 'claimed', format('R1: %s', r);
  r := public.claim_solidgate_intro_offer('production', h, s1, 'trial1');
  ASSERT r = 'retry', format('R2: %s', r);

  -- A DIFFERENT session re-keys immediately. The incumbent holds nothing but
  -- an unopened checkout, and the 60-minute lease is no longer a gate: it kept
  -- a returning buyer (fresh quiz run, incognito, another device) from paying
  -- at all for an hour. Money is now the only thing that blocks, never time.
  r := public.claim_solidgate_intro_offer('production', h, s2, 'trial1');
  ASSERT r = 'claimed', format('R3: %s', r);

  -- ── NEW: same session, different tier, lease still live ─────────────────
  -- Previously 'in_progress' for a full hour: the buyer was pinned to whichever
  -- tier they opened first while the copy told them a checkout was in progress.
  r := public.claim_solidgate_intro_offer('production', h, s1, 'trial3');
  ASSERT r = 'claimed', format('N1 tier switch: expected claimed, got %s', r);

  -- The claim really moved to the new tier, not just returned 'claimed'.
  PERFORM 1 FROM public.solidgate_intro_claims
   WHERE email_hash = h AND tier = 'trial3' AND session_id = s1;
  ASSERT FOUND, 'N2: claim row did not re-key to the new tier';

  -- ...and back again, as many times as the buyer likes.
  r := public.claim_solidgate_intro_offer('production', h, s1, 'special_1eur');
  ASSERT r = 'claimed', format('N3 second switch: %s', r);
  r := public.claim_solidgate_intro_offer('production', h, s1, 'trial1');
  ASSERT r = 'claimed', format('N4 switch back: %s', r);

  -- ── NEW: the money guard still binds the SAME session ───────────────────
  -- A buyer whose earlier tier actually settled cannot open a second tier.
  -- psp is deliberately not 'solidgate': these fixtures only need a row in the
  -- session, and a Solidgate row would have to carry a full immutable checkout
  -- identity snapshot (see orders_solidgate_checkout_identity_check).
  INSERT INTO public.orders (
    session_id, payment_environment, status, amount_cents, product_name, psp
  )
  VALUES (s1, 'production', 'completed', 500, 'fixture-product', 'fixture');
  r := public.claim_solidgate_intro_offer('production', h, s1, 'trial2');
  ASSERT r = 'in_progress', format('N5: paid session must not switch tier, got %s', r);

  -- A merely 'pending' order does not block — that is the abandoned checkout.
  UPDATE public.orders SET status = 'pending' WHERE session_id = s1;
  r := public.claim_solidgate_intro_offer('production', h, s1, 'trial2');
  ASSERT r = 'claimed', format('N6: pending must not block, got %s', r);

  -- ── Cross-session retry is immediate ────────────────────────────────────
  r := public.claim_solidgate_intro_offer('production', h, s2, 'trial2');
  ASSERT r = 'claimed',
    format('N7: abandoned checkout must be retryable from a new session, got %s', r);

  -- ...but a 'pending' order whose payment actually STARTED blocks like moved
  -- money. The accepted auth_ok reservation keeps the main order 'pending' for
  -- the whole capture window; re-keying then would issue a SECOND payable
  -- intent for the same email while the first authorization settles.
  INSERT INTO public.orders (
    session_id, payment_environment, status, solidgate_payment_status,
    amount_cents, product_name, psp
  )
  VALUES (s2, 'production', 'pending', 'auth_ok', 500, 'fixture-product', 'fixture');
  r := public.claim_solidgate_intro_offer('production', h, s1, 'trial2');
  ASSERT r = 'in_progress',
    format('N8: a live authorization must block a re-key, got %s', r);

  -- Once that authorization is gone the same session simply refreshes.
  UPDATE public.orders SET solidgate_payment_status = NULL WHERE session_id = s2;
  r := public.claim_solidgate_intro_offer('production', h, s2, 'trial2');
  ASSERT r = 'retry', format('N9: same session and tier must be a retry, got %s', r);

  -- ── consume: the three outcomes are now distinguishable ─────────────────
  r := public.consume_solidgate_intro_offer('production', h, s2, 'trial2', 'sub-1');
  ASSERT r = 'consumed', format('C1: %s', r);
  r := public.consume_solidgate_intro_offer('production', h, s2, 'trial2', 'sub-1');
  ASSERT r = 'consumed', format('C2 idempotent: %s', r);

  -- A genuine SECOND subscription: grant, record, flag for refund.
  r := public.consume_solidgate_intro_offer('production', h, s1, 'trial2', 'sub-2');
  ASSERT r = 'superseded', format('C3: %s', r);
  SELECT superseded_subscription_ids INTO arr
    FROM public.solidgate_intro_claims WHERE email_hash = h;
  ASSERT arr = ARRAY['sub-2'], format('C4: %s', arr);

  -- NEW: a re-keyed claim whose displaced intent settled is 'reassigned', NOT
  -- 'superseded'. One subscription exists; nothing is owed.
  r := public.claim_solidgate_intro_offer('production', h2, s1, 'trial1');
  ASSERT r = 'claimed', format('C5: %s', r);
  r := public.consume_solidgate_intro_offer('production', h2, s3, 'trial1', 'sub-3');
  ASSERT r = 'reassigned', format('C6: expected reassigned, got %s', r);

  -- ...and it must NOT appear in the refund queue.
  SELECT cardinality(superseded_subscription_ids) INTO n
    FROM public.solidgate_intro_claims WHERE email_hash = h2;
  ASSERT n = 0, format('C7: reassigned must not queue a refund, got %s ids', n);

  -- ── The refund queue view shows exactly the real duplicates ─────────────
  SELECT count(*) INTO n FROM public.solidgate_intro_claims_needing_refund;
  ASSERT n = 1, format('V1: expected 1 row needing refund, got %s', n);
  PERFORM 1 FROM public.solidgate_intro_claims_needing_refund
   WHERE email_hash = h AND duplicate_count = 1
     AND duplicate_subscription_ids = ARRAY['sub-2']
     AND granted_subscription_id = 'sub-1';
  ASSERT FOUND, 'V2: refund view row did not describe the duplicate correctly';

  -- ── Environment isolation and validation unchanged ──────────────────────
  r := public.claim_solidgate_intro_offer('sandbox', h, s1, 'trial1');
  ASSERT r = 'claimed', format('E1: %s', r);
  SELECT count(*) INTO n FROM public.solidgate_intro_claims_needing_refund;
  ASSERT n = 1, format('E2: sandbox claim must not enter the queue, got %s', n);

  r := public.claim_solidgate_intro_offer('production', h3, s3, 'trial1');
  ASSERT r = 'claimed', format('E3: %s', r);
  BEGIN
    r := public.consume_solidgate_intro_offer('production', h3, s3, 'trial1', '   ');
    RAISE EXCEPTION 'E4: blank subscription id must raise';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%invalid Solidgate intro-offer consumption%' THEN RAISE; END IF;
  END;

  RAISE NOTICE 'ALL SCENARIOS PASSED';
END $$;
