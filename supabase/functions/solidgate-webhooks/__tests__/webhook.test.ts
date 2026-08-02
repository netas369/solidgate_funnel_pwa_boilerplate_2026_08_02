import { describe, expect, it, beforeEach, vi } from 'vitest';
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifySolidgateWebhook, signSolidgatePayload } from '../_signature';
import {
  canonicalProductName,
  isRecurringAddon,
  isMainSubscription,
  isOurProduct,
  productTokenFromSlug,
  slugFromCode,
} from '../_codes';
import {
  configureWebhookRuntime,
  drainAnalyticsOutbox,
  handleEvent,
  serveRequest,
  triggerFunnelFulfillment,
  WEBHOOK_CONTRACT_VERSION,
} from '../index';

// Server-side analytics: capture spy behind the npm:posthog-node alias.
const posthogCapture = vi.fn();
vi.mock('npm:posthog-node', () => ({
  PostHog: class {
    capture = posthogCapture;
    shutdown() {
      return Promise.resolve();
    }
  },
}));

// The webhook is the only thing standing between Solidgate's view of the money
// and ours. These tests pin the rules that, when broken, cost the customer
// access they paid for — or hand access to someone who charged back.

const WH_PUBLIC = 'wh_pk_test_public';
const WH_SECRET = 'wh_sk_test_secret_0123456789abcdefghij';

describe('signature verification', () => {
  it('accepts a payload signed the way Solidgate signs it', async () => {
    const body = JSON.stringify({ order: { order_id: 'x' } });
    const signature = await signSolidgatePayload(WH_PUBLIC, WH_SECRET, body);
    await expect(
      verifySolidgateWebhook({ publicKey: WH_PUBLIC, secretKey: WH_SECRET, rawBody: body, signature }),
    ).resolves.toBe(true);
  });

  it('rejects a tampered body — the whole point of the signature', async () => {
    const body = JSON.stringify({ order: { order_id: 'x', amount: 100 } });
    const signature = await signSolidgatePayload(WH_PUBLIC, WH_SECRET, body);
    const tampered = JSON.stringify({ order: { order_id: 'x', amount: 999999 } });
    await expect(
      verifySolidgateWebhook({ publicKey: WH_PUBLIC, secretKey: WH_SECRET, rawBody: tampered, signature }),
    ).resolves.toBe(false);
  });

  it('rejects the RE-SERIALISED body — signatures cover raw bytes', async () => {
    // Solidgate signs the exact bytes it sent. Parsing and stringifying can
    // reorder keys or change spacing, and every signature would then fail; this
    // pins the reason the handler must never parse before verifying.
    const raw = '{"order":{"order_id":"x",  "amount":100}}';
    const signature = await signSolidgatePayload(WH_PUBLIC, WH_SECRET, raw);
    const reserialised = JSON.stringify(JSON.parse(raw));
    expect(reserialised).not.toBe(raw);
    await expect(
      verifySolidgateWebhook({ publicKey: WH_PUBLIC, secretKey: WH_SECRET, rawBody: reserialised, signature }),
    ).resolves.toBe(false);
  });

  it('rejects a signature made with the API keys instead of the webhook keys', async () => {
    const body = '{"a":1}';
    const signature = await signSolidgatePayload('api_pk_other', 'api_sk_other_secret_key_012345678', body);
    await expect(
      verifySolidgateWebhook({ publicKey: WH_PUBLIC, secretKey: WH_SECRET, rawBody: body, signature }),
    ).resolves.toBe(false);
  });

  it('rejects an empty signature', async () => {
    await expect(
      verifySolidgateWebhook({ publicKey: WH_PUBLIC, secretKey: WH_SECRET, rawBody: '{}', signature: '' }),
    ).resolves.toBe(false);
  });
});

describe('product codes (brand guard)', () => {
  it('recognises both code shapes, forever', () => {
    // New Solidgate orders carry no locale prefix; history does. Both must
    // resolve or a buyer silently loses what they paid for.
    expect(isOurProduct('BRANDPDF5_000000_PDF')).toBe(true);
    expect(isOurProduct('LT_BRANDPDF5_000000_PDF')).toBe(true);
    expect(slugFromCode('BRANDPDF5_000000_PDF')).toBe('oto5_pdf');
    expect(slugFromCode('LT_BRANDPDF5_000000_PDF')).toBe('oto5_pdf');
  });

  it('ignores another brand on the same channel', () => {
    expect(isOurProduct('EN_OTHERBRAND_000000_SUB')).toBe(false);
    expect(isOurProduct(null)).toBe(false);
    expect(slugFromCode('EN_OTHERBRAND_000000_SUB')).toBeNull();
  });

  it('distinguishes the main subscription from the addon one', () => {
    expect(isMainSubscription('BRAND_000000_SUB')).toBe(true);
    expect(isMainSubscription('BRANDADDON_000000_SUB')).toBe(false);
    expect(isRecurringAddon('BRANDADDON_000000_SUB')).toBe(true);
    expect(productTokenFromSlug('trial3')).toBe('BRAND');
    expect(productTokenFromSlug('oto2_addon_weekly')).toBe('BRANDADDON');
  });

  it('maps technical amount-based OTO codes to human commerce names', () => {
    expect(canonicalProductName(
      'oto3_bundle_all',
      'BRANDBUNDLE_000000_PDF',
    )).toBe('Bundle (all)');
    expect(canonicalProductName(
      'oto2_addon_weekly',
      'Provider Weekly Add-on (7-day trial)',
    )).toBe('Weekly Add-on');
  });
});

// ── Handler behaviour, against a fake Supabase ──────────────────────────────

interface Row {
  [k: string]: unknown;
}

// Fixture-only provider catalog ids. These are deliberately fake: the real ones
// live in packages/shared/src/solidgate/catalog-ids.json, which the boilerplate
// ships scrubbed. Only their stability across a test run matters.
const PRODUCT_IDS: Record<string, string> = {
  trial1: 'product-id-trial1',
  trial2: 'product-id-trial2',
  trial3: 'product-id-trial3',
  trial4: 'product-id-trial4',
  special_1eur: 'product-id-special-1eur',
  special_free: 'product-id-special-free',
  addon_trial: 'product-id-addon-trial',
  addon_direct: 'product-id-addon-direct',
};

/**
 * Older webhook tests predate the immutable checkout snapshot. Keep their
 * commerce fixtures concise while making the persisted row as complete as a
 * real v2 opener row. Tests that exercise a bad identity can still override
 * any of these fields explicitly after calling this helper.
 */
function checkoutIdentityFixture(
  source: Row,
  sessions: Row[],
  extras: Record<string, Row[]>,
): Row {
  const row = { ...source };
  if (row.psp !== 'solidgate') return row;

  const metadata = row.tracking_metadata && typeof row.tracking_metadata === 'object'
    && !Array.isArray(row.tracking_metadata)
    ? row.tracking_metadata as Record<string, unknown>
    : {};
  const productCode = String(row.product_slug ?? '');
  const amount = Number(row.solidgate_original_amount_cents ?? row.amount_cents);
  const session = sessions.find((candidate) => candidate.id === row.session_id);
  const authUser = (extras.auth_users ?? []).find((candidate) => candidate.id === row.user_id);
  const subscriptionProduct = isMainSubscription(productCode) || isRecurringAddon(productCode);
  const expectedProductId = isMainSubscription(productCode)
    ? PRODUCT_IDS[String(metadata.product_slug ?? '')]
    : isRecurringAddon(productCode)
      ? PRODUCT_IDS[metadata.funnel_code === 'PWA' ? 'addon_direct' : 'addon_trial']
      : null;

  return {
    solidgate_customer_email: String(
      row.solidgate_customer_email
        ?? session?.email
        ?? authUser?.email
        ?? (row.session_id ? 'buyer@example.com' : 'member@example.com'),
    ).trim().toLowerCase(),
    solidgate_checkout_locale: String(
      row.solidgate_checkout_locale ?? metadata.locale ?? session?.locale ?? 'en',
    ),
    solidgate_product_id: subscriptionProduct
      ? (row.solidgate_product_id ?? expectedProductId ?? null)
      : null,
    solidgate_payment_action: row.solidgate_payment_action
      ?? (isMainSubscription(productCode) && amount === 0 ? 'auth_0_amount' : 'auth_settle'),
    solidgate_checkout_identity_legacy: row.solidgate_checkout_identity_legacy ?? false,
    solidgate_card_source_sequence: row.solidgate_card_source_sequence ?? 1,
    ...row,
  };
}

interface DbFailures {
  reads?: Record<string, string>;
  writes?: Record<string, string>;
  rpc?: Record<string, string>;
  authCreate?: { userId?: string; code?: string; message?: string };
  emptyUpdateSelect?: Record<string, boolean>;
  emptyUpdateSelectOn?: Record<string, number[]>;
  updateRaceWinner?: Record<string, Row>;
  readRaceWinner?: Record<string, { onMaybeSingle: number; patch: Row }>;
}

function makeDb(
  orders: Row[],
  sessions: Row[] = [{ id: 'sess-1', email: 'buyer@example.com', locale: 'en', user_id: 'user-1' }],
  extras: Record<string, Row[]> = {},
  rpcResults: Record<string, unknown> = {},
  failures: DbFailures = {},
) {
  const rpcAlias: Record<string, string> = {
    write_solidgate_session_vault_monotonic: 'write_solidgate_session_vault_with_method',
    write_solidgate_account_vault_monotonic: 'write_solidgate_account_vault_with_method',
    promote_solidgate_session_vault_monotonic: 'promote_solidgate_session_vault_with_method',
  };
  const legacyRpcName = (name: string) => Object.entries(rpcAlias)
    .find(([, current]) => current === name)?.[0];
  const writes: Array<{
    table: string;
    op: string;
    payload: Row;
    filters: Array<{ column: string; value: unknown }>;
  }> = [];
  const tables: Record<string, Row[]> = { orders, sessions, ...extras };
  tables.orders = (tables.orders ?? []).map((row) => checkoutIdentityFixture(row, sessions, extras));
  const rpcCalls: Array<{ name: string; args: Row }> = [];
  const maybeSingleReads: Record<string, number> = {};
  const updateMaybeSingleReads: Record<string, number> = {};
  const createUser = vi.fn(({ email }: { email: string }) => {
    const configured = failures.authCreate;
    if (configured?.userId) {
      return Promise.resolve({
        data: { user: { id: configured.userId, email } },
        error: null,
      });
    }
    return Promise.resolve({
      data: { user: null },
      error: {
        code: configured?.code ?? 'email_exists',
        message: configured?.message ?? 'A user with this email already exists',
      },
    });
  });

  const builder = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    let pendingWrite: (typeof writes)[number] | null = null;
    let operation: 'read' | 'update' | 'upsert' | 'insert' | 'delete' = 'read';
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = (col: string, val: unknown) => {
      pendingWrite?.filters.push({ column: col, value: val });
      rows = rows.filter((r) => {
        const actual = r[col] ??
          ((col === 'payment_environment' || col === 'environment') ? 'production' : undefined);
        return actual === val;
      });
      return chain;
    };
    chain.in = (col: string, values: unknown[]) => {
      pendingWrite?.filters.push({ column: col, value: values });
      const set = new Set(values);
      rows = rows.filter((r) => set.has(r[col]));
      return chain;
    };
    chain.ilike = (col: string, pattern: string) => {
      const needle = pattern.replaceAll('%', '').toLowerCase();
      rows = rows.filter((r) => String(r[col] ?? '').toLowerCase().includes(needle));
      return chain;
    };
    chain.order = () => chain;
    chain.limit = (limit: number) => {
      rows = rows.slice(0, limit);
      return chain;
    };
    const resultError = () => {
      const message = operation === 'read'
        ? failures.reads?.[table]
        : failures.writes?.[table];
      return message ? { message } : null;
    };
    chain.maybeSingle = () => {
      const error = resultError();
      if (!error && operation === 'read') {
        const readNumber = (maybeSingleReads[table] ?? 0) + 1;
        maybeSingleReads[table] = readNumber;
        const winner = failures.readRaceWinner?.[table];
        if (winner?.onMaybeSingle === readNumber && rows[0]) {
          Object.assign(rows[0], winner.patch);
        }
      }
      if (!error && operation === 'update') {
        const updateNumber = (updateMaybeSingleReads[table] ?? 0) + 1;
        updateMaybeSingleReads[table] = updateNumber;
        const winner = failures.updateRaceWinner?.[table];
        const selected = rows[0];
        if (winner && selected) {
          const durable = (tables[table] ?? []).find((row) => row.id === selected.id);
          if (durable) Object.assign(durable, winner);
          Object.assign(selected, winner);
        }
        const forceEmpty = failures.emptyUpdateSelect?.[table]
          || failures.emptyUpdateSelectOn?.[table]?.includes(updateNumber);
        if (forceEmpty) {
          return Promise.resolve({ data: null, error: null });
        }
      }
      return Promise.resolve({ data: error ? null : (rows[0] ?? null), error });
    };
    chain.update = (payload: Row) => {
      operation = 'update';
      pendingWrite = { table, op: 'update', payload, filters: [] };
      writes.push(pendingWrite);
      return chain;
    };
    // IS NULL filter + thenable resolution, for the analytics-claim chain
    // update(...).eq(...).is('analytics_captured_at', null).select('id').
    chain.is = (col: string, val: unknown) => {
      rows = rows.filter((r) => (r[col] ?? null) === val);
      return chain;
    };
    chain.then = (
      res: (v: { data: Row[] | null; error: { message: string } | null }) => unknown,
      rej?: (e: unknown) => unknown,
    ) => {
      const error = resultError();
      return Promise.resolve({ data: error ? null : rows, error }).then(res, rej);
    };
    chain.upsert = (payload: Row) => {
      operation = 'upsert';
      writes.push({ table, op: 'upsert', payload, filters: [] });
      return Promise.resolve({ error: resultError() });
    };
    chain.insert = (payload: Row) => {
      operation = 'insert';
      writes.push({ table, op: 'insert', payload, filters: [] });
      return Promise.resolve({ error: resultError() });
    };
    chain.delete = () => {
      operation = 'delete';
      return chain;
    };
    return chain;
  };

  return {
    db: {
      from: (table: string) => builder(table),
      auth: {
        admin: {
          createUser,
          getUserById: (userId: string) => {
            const user = (tables.auth_users ?? []).find((candidate) => candidate.id === userId) ?? {
              id: userId,
              email: 'member@example.com',
            };
            return Promise.resolve({ data: { user }, error: null });
          },
        },
      },
      rpc: (name: string, args: Row) => {
        rpcCalls.push({ name, args });
        const defaults: Record<string, unknown> = {
          consume_solidgate_intro_offer: 'consumed',
          persist_user_acquisition_attribution: true,
          grant_solidgate_main_entitlement: true,
          grant_solidgate_oto_entitlement: true,
          grant_solidgate_pwa_entitlement: true,
          solidgate_special_free_card_ready: true,
          apply_solidgate_subscription_entitlement_lifecycle: 'applied',
          write_solidgate_session_vault_with_method: 'written',
          record_solidgate_pwa_confirmed_capture: 'hosted_form',
          write_solidgate_account_vault_with_method: 'written',
          promote_solidgate_session_vault_with_method: 'written',
          claim_solidgate_webhook_event_v2: [{
            claim_state: 'claimed',
            claim_token: '11111111-1111-4111-8111-111111111111',
            claim_generation: 1,
          }],
          complete_solidgate_webhook_event_v2: true,
          fail_solidgate_webhook_event_v2: true,
          claim_solidgate_entity_event: 'claimed',
        };
        const legacyName = legacyRpcName(name);
        const failure = failures.rpc?.[name]
          ?? (legacyName ? failures.rpc?.[legacyName] : undefined);
        const data = failure
          ? null
          : Object.prototype.hasOwnProperty.call(rpcResults, name)
          ? rpcResults[name]
          : legacyName && Object.prototype.hasOwnProperty.call(rpcResults, legacyName)
          ? rpcResults[legacyName]
          : (defaults[name] ?? null);
        const claim = name === 'claim_solidgate_webhook_event_v2'
          ? (Array.isArray(data) ? data[0] : data) as Row | null
          : null;
        if (claim?.claim_state === 'claimed') {
          (tables.solidgate_webhook_events ??= []).push({
            environment: args.p_environment,
            event_id: args.p_event_id,
            status: 'processing',
            claim_token: claim.claim_token,
            claim_generation: claim.claim_generation,
          });
        }
        if (name === 'complete_solidgate_webhook_event_v2' && data === true) {
          writes.push({
            table: 'solidgate_webhook_events',
            op: 'update',
            payload: { status: 'completed', claim_token: null },
            filters: [
              { column: 'environment', value: args.p_environment },
              { column: 'event_id', value: args.p_event_id },
              { column: 'claim_token', value: args.p_claim_token },
              { column: 'claim_generation', value: args.p_claim_generation },
            ],
          });
        }
        if (name === 'fail_solidgate_webhook_event_v2' && data === true) {
          writes.push({
            table: 'solidgate_webhook_events',
            op: 'update',
            payload: {
              status: 'failed',
              claim_token: null,
              last_error: args.p_last_error,
            },
            filters: [
              { column: 'environment', value: args.p_environment },
              { column: 'event_id', value: args.p_event_id },
              { column: 'claim_token', value: args.p_claim_token },
              { column: 'claim_generation', value: args.p_claim_generation },
            ],
          });
        }
        return Promise.resolve({
          data,
          error: failure ? { message: failure } : null,
        });
      },
    } as never,
    writes,
    rpcCalls,
    createUser,
    updatesTo: (table: string) => writes.filter((w) => w.table === table && w.op === 'update').map((w) => w.payload),
    upsertsTo: (table: string) => writes.filter((w) => w.table === table && w.op === 'upsert').map((w) => w.payload),
    rpcsTo: (name: string) => {
      const canonicalName = rpcAlias[name] ?? name;
      return rpcCalls.filter((call) => call.name === canonicalName).map((call) => call.args);
    },
  };
}

const ORDER_ROW = {
  id: 'order-1',
  psp: 'solidgate',
  product_name: 'BRAND_000000_SUB',
  session_id: 'sess-1',
  user_id: 'user-1',
  status: 'pending',
  product_slug: 'BRAND_000000_SUB',
  currency: 'usd',
  amount_cents: 1767,
  solidgate_order_id: 'sess-1:trial4:1',
  solidgate_subscription_id: 'sub-uuid-1',
  payment_environment: 'production',
  created_at: '2026-07-16T08:50:00.000Z',
  tracking_metadata: {
    funnel_code: 'BRAND',
    funnel_variant: 'main',
    session_id: 'sess-1',
    product_slug: 'trial4',
    price_id: 'ef09864f-5a27-4b96-bd1e-61c9ea49c1de',
  },
};

function specialFreeOrder(overrides: Row = {}): Row {
  return {
    ...ORDER_ROW,
    amount_cents: 0,
    solidgate_order_id: 'sess-1:special_free:1',
    solidgate_subscription_id: 'sub-free',
    tracking_metadata: {
      funnel_code: 'BRAND',
      funnel_variant: 'special_free',
      session_id: 'sess-1',
      product_slug: 'special_free',
      price_id: 'c7539dd6-4a8e-477c-9987-ad7a2f2c71f5',
    },
    ...overrides,
  };
}

function pwaAddonOrder(overrides: Row = {}): Row {
  return {
    ...ORDER_ROW,
    session_id: null,
    product_name: 'BRANDADDON_000000_SUB',
    product_slug: 'BRANDADDON_000000_SUB',
    amount_cents: 5900,
    solidgate_order_id: 'u-user-1:oto2_addon_weekly:1',
    solidgate_subscription_id: 'sub-addon-direct',
    tracking_metadata: {
      funnel_code: 'PWA',
      funnel_variant: 'member_area',
      session_id: 'u-user-1',
      product_slug: 'oto2_addon_weekly',
      price_id: '1bb9649e-40a2-4898-bb3d-85ccb2dbd9ff',
    },
    ...overrides,
  };
}

function capturedSubscriptionOrder(overrides: Row = {}): Row {
  const merged = { ...ORDER_ROW, status: 'active', ...overrides };
  return {
    ...merged,
    solidgate_original_amount_cents: merged.amount_cents,
    solidgate_payment_status: 'settle_ok',
    ...overrides,
  };
}

function subscriptionEntitlement(row: Row, overrides: Row = {}): Row {
  return {
    order_id: row.id,
    payment_environment: row.payment_environment ?? 'production',
    user_id: row.user_id,
    product_slug: row.product_slug,
    solidgate_subscription_id: row.solidgate_subscription_id,
    status: 'active',
    revoked_at: null,
    ...overrides,
  };
}

function positiveOrderPayload(
  row: Row,
  orderOverrides: Row = {},
  metadataOverride?: Record<string, string>,
) {
  const metadata = metadataOverride ?? { ...(row.tracking_metadata as Record<string, string>) };
  const productCode = String(row.product_slug);
  const subscriptionProduct = isMainSubscription(productCode) || isRecurringAddon(productCode);
  const productId = isMainSubscription(productCode)
    ? PRODUCT_IDS[metadata.product_slug]
    : isRecurringAddon(productCode)
      ? PRODUCT_IDS[metadata.funnel_code === 'PWA' ? 'addon_direct' : 'addon_trial']
      : undefined;
  const providerProductName = isMainSubscription(productCode)
    ? `Provider Monthly (${metadata.product_slug})`
    : isRecurringAddon(productCode)
      ? metadata.funnel_code === 'PWA'
        ? 'Provider Weekly Add-on'
        : 'Provider Weekly Add-on (7-day trial)'
      : undefined;
  const amount = Number(row.solidgate_original_amount_cents ?? row.amount_cents);
  const customerAccountId = row.session_id ?? row.user_id;
  return {
    order: {
      order_id: row.solidgate_order_id,
      status: 'settle_ok',
      amount,
      currency: String(row.currency).toUpperCase(),
      customer_account_id: customerAccountId,
      customer_email: row.session_id ? 'buyer@example.com' : 'member@example.com',
      ...(subscriptionProduct && {
        subscription_id: row.solidgate_subscription_id ?? 'sub-new',
        product_id: productId,
        product_name: providerProductName,
      }),
      ...orderOverrides,
    },
    order_metadata: { ...metadata },
  };
}

function webhookTokenAuthorization(id = 'auth-1', overrides: Row = {}) {
  const overrideCardToken = overrides.card_token;
  const rest = { ...overrides };
  delete rest.card_token;
  return {
    id,
    status: 'success',
    operation: 'auth',
    amount: 1767,
    currency: 'USD',
    card_token: {
      token: 'tok_abc',
      original_payment_method: 'card',
      ...(overrideCardToken && typeof overrideCardToken === 'object'
        ? overrideCardToken as Row
        : {}),
    },
    card: { brand: 'VISA', number: '406742XXXXXX9265' },
    ...rest,
  };
}

interface InitialSubscriptionPayloadOptions {
  callbackType?: string;
  subscriptionId?: string;
  subscription?: Row;
  product?: Row;
  customer?: Row;
  invoice?: Row;
  invoiceOrder?: Row;
  metadata?: Record<string, string>;
}

function initialSubscriptionPayload(
  row: Row,
  options: InitialSubscriptionPayloadOptions = {},
) {
  const metadata = options.metadata ?? { ...(row.tracking_metadata as Record<string, string>) };
  const productCode = String(row.product_slug);
  const productId = isMainSubscription(productCode)
    ? PRODUCT_IDS[metadata.product_slug]
    : PRODUCT_IDS[metadata.funnel_code === 'PWA' ? 'addon_direct' : 'addon_trial'];
  const amount = Number(row.solidgate_original_amount_cents ?? row.amount_cents);
  const subscriptionId = options.subscriptionId ?? String(row.solidgate_subscription_id ?? 'sub-new');
  return {
    callback_type: options.callbackType ?? 'active',
    subscription: {
      id: subscriptionId,
      status: 'active',
      next_charge_at: '2026-07-28 08:50:00',
      trial: true,
      ...options.subscription,
    },
    product: {
      product_id: productId,
      amount: 5900,
      currency: String(row.currency).toUpperCase(),
      ...options.product,
    },
    customer: {
      customer_account_id: row.session_id ?? row.user_id,
      customer_email: row.session_id ? 'buyer@example.com' : 'member@example.com',
      ...options.customer,
    },
    invoices: {
      initial: {
        id: 'inv-initial',
        status: 'success',
        amount,
        product_price_id: metadata.price_id,
        subscription_term_number: 0,
        order_metadata: { ...metadata },
        orders: {
          initial: {
            id: row.solidgate_order_id,
            status: 'settle_ok',
            amount,
            ...options.invoiceOrder,
          },
        },
        ...options.invoice,
      },
    },
  };
}

async function makeWebhookRequest(
  eventType: string,
  payload: unknown,
  eventId = 'evt-1',
): Promise<Request> {
  const body = JSON.stringify(payload);
  const signature = await signSolidgatePayload(WH_PUBLIC, WH_SECRET, body);
  return new Request('https://example.test/functions/v1/solidgate-webhooks', {
    method: 'POST',
    headers: {
      signature,
      merchant: 'test-merchant',
      'solidgate-event-id': eventId,
      'solidgate-event-type': eventType,
      'solidgate-event-created-at': '2026-07-21T08:50:00.000Z',
    },
    body,
  });
}

beforeEach(() => {
  posthogCapture.mockClear();
  configureWebhookRuntime({
    environment: 'production',
    webhookPublicKey: WH_PUBLIC,
    webhookSecretKey: WH_SECRET,
    analyticsEnabled: true,
    customerSideEffectsEnabled: true,
    fulfillmentWorkerUrl: '',
    fulfillmentWorkerSecret: '',
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('fulfillment worker trigger routing', () => {
  it('identifies the hardened handler on an unsigned deployment probe', async () => {
    const response = await serveRequest(new Request(
      'https://example.test/functions/v1/solidgate-webhooks',
      { method: 'POST', body: '{}' },
    ));

    expect(response.status).toBe(400);
    expect(response.headers.get('x-solidgate-webhook-contract'))
      .toBe(WEBHOOK_CONTRACT_VERSION);
  });

  it('drains sandbox work only through its explicitly configured preview worker', async () => {
    configureWebhookRuntime({
      environment: 'sandbox',
      analyticsEnabled: false,
      customerSideEffectsEnabled: false,
      fulfillmentWorkerUrl: 'https://sandbox-preview.example/api/internal/solidgate-fulfillment',
      fulfillmentWorkerSecret: 'sandbox-worker-secret',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    try {
      await triggerFunnelFulfillment();
      expect(fetchSpy).toHaveBeenCalledWith(
        new URL('https://sandbox-preview.example/api/internal/solidgate-fulfillment'),
        {
          method: 'POST',
          headers: { 'x-internal-secret': 'sandbox-worker-secret' },
        },
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('does not make a sandbox request when the explicit worker config is absent', async () => {
    configureWebhookRuntime({
      environment: 'sandbox',
      fulfillmentWorkerUrl: '',
      fulfillmentWorkerSecret: '',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    try {
      await triggerFunnelFulfillment();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('ACKs without waiting for a slow fulfillment worker and registers the task with EdgeRuntime', async () => {
    configureWebhookRuntime({
      fulfillmentWorkerUrl: 'https://worker.example/api/internal/solidgate-fulfillment',
      fulfillmentWorkerSecret: 'worker-secret',
      analyticsEnabled: false,
    });
    let resolveWorker!: (response: Response) => void;
    const workerResponse = new Promise<Response>((resolve) => {
      resolveWorker = resolve;
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockReturnValue(workerResponse);
    const waitUntil = vi.fn();
    const runtimeGlobal = globalThis as typeof globalThis & {
      EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void };
    };
    const previousEdgeRuntime = runtimeGlobal.EdgeRuntime;
    runtimeGlobal.EdgeRuntime = { waitUntil };
    const { db } = makeDb(
      [ORDER_ROW],
      undefined,
      {},
      { claim_solidgate_webhook_event_v2: [{
        claim_state: 'completed', claim_token: null, claim_generation: 4,
      }] },
    );

    try {
      const responsePromise = serveRequest(
        await makeWebhookRequest(
          'card_gate.order.updated',
          positiveOrderPayload(ORDER_ROW),
          'evt-slow-worker',
        ),
        db,
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const winner = await Promise.race([
        responsePromise.then((response) => ({ kind: 'response' as const, response })),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          timeout = setTimeout(() => resolve({ kind: 'timeout' }), 100);
        }),
      ]);
      if (timeout) clearTimeout(timeout);

      expect(winner.kind).toBe('response');
      if (winner.kind === 'response') expect(winner.response.status).toBe(200);
      expect(waitUntil).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      resolveWorker(new Response(null, { status: 204 }));
      if (previousEdgeRuntime) runtimeGlobal.EdgeRuntime = previousEdgeRuntime;
      else delete runtimeGlobal.EdgeRuntime;
      fetchSpy.mockRestore();
    }
  });
});

describe('durable webhook inbox claim states', () => {
  const claimedToken = '11111111-1111-4111-8111-111111111111';

  it('ACKs a completed duplicate without dispatching or rewriting the inbox', async () => {
    const { db, writes, rpcCalls } = makeDb(
      [{ ...ORDER_ROW }],
      undefined,
      {},
      { claim_solidgate_webhook_event_v2: [{
        claim_state: 'completed', claim_token: null, claim_generation: 2,
      }] },
    );
    const response = await serveRequest(
      await makeWebhookRequest('card_gate.order.updated', {
        order: { order_id: ORDER_ROW.solidgate_order_id, status: 'settle_ok', amount: 1767 },
      }, 'evt-completed'),
      db,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ duplicate: true });
    expect(rpcCalls.map((call) => call.name)).toEqual(['claim_solidgate_webhook_event_v2']);
    expect(writes).toHaveLength(0);
  });

  it('returns a retryable response for a fresh processing lease and leaves its owner untouched', async () => {
    const { db, writes, rpcCalls } = makeDb(
      [{ ...ORDER_ROW }],
      undefined,
      {},
      { claim_solidgate_webhook_event_v2: [{
        claim_state: 'busy', claim_token: null, claim_generation: 2,
      }] },
    );
    const response = await serveRequest(
      await makeWebhookRequest('card_gate.order.updated', {
        order: { order_id: ORDER_ROW.solidgate_order_id, status: 'settle_ok', amount: 1767 },
      }, 'evt-busy'),
      db,
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    expect(rpcCalls.map((call) => call.name)).toEqual(['claim_solidgate_webhook_event_v2']);
    expect(writes).toHaveLength(0);
  });

  it.each([
    {
      label: 'an unknown top-level event',
      eventType: 'merchant.unknown',
      payload: { harmless: true },
      diagnostic: 'unsupported Solidgate webhook event type: merchant.unknown',
    },
    {
      label: 'the legacy subscription.updated event',
      eventType: 'subscription.updated',
      payload: { subscription: { id: 'sub-legacy' } },
      diagnostic: 'configure subscription.updated.v2',
    },
  ])('fails $label after claiming it instead of completing the inbox', async ({
    label,
    eventType,
    payload,
    diagnostic,
  }) => {
    const { db, writes, updatesTo, rpcsTo } = makeDb([]);
    const response = await serveRequest(
      await makeWebhookRequest(eventType, payload, `evt-contract-${label.replaceAll(' ', '-')}`),
      db,
    );

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain(diagnostic);
    expect(rpcsTo('fail_solidgate_webhook_event_v2')).toContainEqual(expect.objectContaining({
      p_claim_token: claimedToken,
      p_claim_generation: 1,
      p_last_error: expect.stringContaining(diagnostic),
    }));
    expect(updatesTo('solidgate_webhook_events')).toContainEqual(expect.objectContaining({
      status: 'failed',
      last_error: expect.stringContaining(diagnostic),
    }));
    expect(rpcsTo('complete_solidgate_webhook_event_v2')).toHaveLength(0);
    expect(rpcsTo('claim_solidgate_entity_event')).toHaveLength(0);
    expect(writes.filter((write) => write.table !== 'solidgate_webhook_events')).toHaveLength(0);
  });

  const configuredEntityCases: Array<{
    eventType: string;
    entityPath: string;
    payload: (value: unknown) => unknown;
  }> = [
    {
      eventType: 'card_gate.order.updated',
      entityPath: 'order.order_id',
      payload: (value) => ({ order: { order_id: value, status: 'settle_ok' } }),
    },
    {
      eventType: 'alt_gate.order.updated',
      entityPath: 'order.order_id',
      payload: (value) => ({ order: { order_id: value, status: 'settle_ok' } }),
    },
    {
      eventType: 'subscription.updated.v2',
      entityPath: 'subscription.id',
      payload: (value) => ({
        callback_type: 'cancel',
        subscription: { id: value, status: 'cancelled' },
      }),
    },
    {
      eventType: 'card_gate.chargeback.received',
      entityPath: 'order.order_id',
      payload: (value) => ({
        order: { order_id: value },
        chargeback: { id: 'cb-invalid-entity', status: 'in_progress' },
      }),
    },
  ];
  const invalidEntityValues = [
    { label: 'missing', value: undefined },
    { label: 'blank', value: '   ' },
    { label: 'padded', value: '  provider-entity-id  ' },
    { label: 'non-string', value: 42 },
  ];

  it.each(configuredEntityCases.flatMap((family) =>
    invalidEntityValues.map((invalid) => ({ ...family, ...invalid }))))(
    'fails $eventType when $entityPath is $label without claiming an entity',
    async ({ eventType, entityPath, payload, label, value }) => {
      const { db, writes, updatesTo, rpcsTo } = makeDb([]);
      const response = await serveRequest(
        await makeWebhookRequest(
          eventType,
          payload(value),
          `evt-${eventType.replaceAll('.', '-')}-${label}`,
        ),
        db,
      );
      const diagnostic = `${eventType} requires a non-empty string at ${entityPath}`;

      expect(response.status).toBe(500);
      await expect(response.text()).resolves.toContain(diagnostic);
      expect(rpcsTo('fail_solidgate_webhook_event_v2')).toContainEqual(expect.objectContaining({
        p_claim_token: claimedToken,
        p_claim_generation: 1,
        p_last_error: expect.stringContaining(diagnostic),
      }));
      expect(updatesTo('solidgate_webhook_events')).toContainEqual(expect.objectContaining({
        status: 'failed',
        last_error: expect.stringContaining(diagnostic),
      }));
      expect(rpcsTo('complete_solidgate_webhook_event_v2')).toHaveLength(0);
      expect(rpcsTo('claim_solidgate_entity_event')).toHaveLength(0);
      expect(writes.filter((write) => write.table !== 'solidgate_webhook_events')).toHaveLength(0);
    },
  );

  it.each([
    { eventType: 'card_gate.order.updated', entityPath: 'order.order_id', payload: null },
    { eventType: 'alt_gate.order.updated', entityPath: 'order.order_id', payload: 42 },
    {
      eventType: 'subscription.updated.v2',
      entityPath: 'subscription.id',
      payload: 'malformed',
    },
    {
      eventType: 'card_gate.chargeback.received',
      entityPath: 'order.order_id',
      payload: [],
    },
  ])(
    'fails a malformed $eventType payload safely before entity ordering',
    async ({ eventType, entityPath, payload }) => {
      const { db, writes, rpcsTo } = makeDb([]);
      const response = await serveRequest(
        await makeWebhookRequest(
          eventType,
          payload,
          `evt-${eventType.replaceAll('.', '-')}-malformed-payload`,
        ),
        db,
      );

      expect(response.status).toBe(500);
      await expect(response.text()).resolves.toContain(
        `${eventType} requires a non-empty string at ${entityPath}`,
      );
      expect(rpcsTo('fail_solidgate_webhook_event_v2')).toHaveLength(1);
      expect(rpcsTo('complete_solidgate_webhook_event_v2')).toHaveLength(0);
      expect(rpcsTo('claim_solidgate_entity_event')).toHaveLength(0);
      expect(writes.filter((write) => write.table !== 'solidgate_webhook_events')).toHaveLength(0);
    },
  );

  it.each([
    { label: 'missing', callbackType: undefined },
    { label: 'unknown', callbackType: 'future_subscription_state' },
  ])(
    'fails a locally owned subscription with a $label callback_type before shared writes',
    async ({ label, callbackType }) => {
      const localOrder = capturedSubscriptionOrder();
      const payload = {
        ...(callbackType === undefined ? {} : { callback_type: callbackType }),
        subscription: { id: localOrder.solidgate_subscription_id, status: 'active' },
      };
      const { db, writes, updatesTo, rpcsTo } = makeDb(
        [localOrder],
        undefined,
        { entitlements: [subscriptionEntitlement(localOrder)] },
      );
      const response = await serveRequest(
        await makeWebhookRequest(
          'subscription.updated.v2',
          payload,
          `evt-owned-subscription-${label}-callback`,
        ),
        db,
      );

      expect(response.status).toBe(500);
      await expect(response.text()).resolves.toContain('unsupported subscription callback_type');
      expect(rpcsTo('fail_solidgate_webhook_event_v2')).toContainEqual(expect.objectContaining({
        p_claim_token: claimedToken,
        p_claim_generation: 1,
        p_last_error: expect.stringContaining('unsupported subscription callback_type'),
      }));
      expect(updatesTo('solidgate_webhook_events')).toContainEqual(expect.objectContaining({
        status: 'failed',
        last_error: expect.stringContaining('unsupported subscription callback_type'),
      }));
      expect(rpcsTo('release_solidgate_entity_event')).toHaveLength(1);
      expect(rpcsTo('complete_solidgate_entity_event')).toHaveLength(0);
      expect(rpcsTo('complete_solidgate_webhook_event_v2')).toHaveLength(0);
      expect(writes.filter((write) => write.table !== 'solidgate_webhook_events')).toHaveLength(0);
    },
  );

  it('does not bind an initially unbound local order for an unknown callback_type', async () => {
    const unboundOrder = {
      ...ORDER_ROW,
      status: 'pending',
      solidgate_subscription_id: null,
    };
    const payload = initialSubscriptionPayload(unboundOrder, {
      callbackType: 'future_subscription_state',
      subscriptionId: 'sub-unbound-unknown',
    });
    const { db, writes, updatesTo, rpcsTo } = makeDb([unboundOrder]);
    const response = await serveRequest(
      await makeWebhookRequest(
        'subscription.updated.v2',
        payload,
        'evt-unbound-owned-subscription-unknown-callback',
      ),
      db,
    );

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain('unsupported subscription callback_type');
    expect(updatesTo('orders')).toHaveLength(0);
    expect(rpcsTo('release_solidgate_entity_event')).toHaveLength(1);
    expect(rpcsTo('complete_solidgate_entity_event')).toHaveLength(0);
    expect(rpcsTo('fail_solidgate_webhook_event_v2')).toContainEqual(expect.objectContaining({
      p_claim_token: claimedToken,
      p_claim_generation: 1,
      p_last_error: expect.stringContaining('future_subscription_state'),
    }));
    expect(rpcsTo('complete_solidgate_webhook_event_v2')).toHaveLength(0);
    expect(writes.filter((write) => write.table !== 'solidgate_webhook_events')).toHaveLength(0);
  });

  it.each([
    {
      label: 'an unowned card order',
      orders: [] as Row[],
      eventType: 'card_gate.order.updated',
      payload: { order: { order_id: 'another-brand-order', status: 'settle_ok' } },
    },
    {
      label: 'another-brand subscription',
      orders: [{
        ...capturedSubscriptionOrder(),
        product_name: 'EN_OTHERBRAND_000000_SUB',
        product_slug: 'EN_OTHERBRAND_000000_SUB',
      }],
      eventType: 'subscription.updated.v2',
      payload: {
        callback_type: 'cancel',
        subscription: { id: 'sub-uuid-1', status: 'cancelled' },
      },
    },
  ])('completes $label as a proven irrelevant no-op', async ({
    label,
    orders,
    eventType,
    payload,
  }) => {
    const { db, writes, updatesTo, rpcsTo } = makeDb(orders);
    const response = await serveRequest(
      await makeWebhookRequest(
        eventType,
        payload,
        `evt-irrelevant-${label.replaceAll(' ', '-')}`,
      ),
      db,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(rpcsTo('complete_solidgate_webhook_event_v2')).toContainEqual(expect.objectContaining({
      p_claim_token: claimedToken,
      p_claim_generation: 1,
    }));
    expect(updatesTo('solidgate_webhook_events')).toContainEqual(expect.objectContaining({
      status: 'completed',
    }));
    expect(rpcsTo('fail_solidgate_webhook_event_v2')).toHaveLength(0);
    expect(rpcsTo('claim_solidgate_entity_event')).toHaveLength(1);
    expect(rpcsTo('complete_solidgate_entity_event')).toHaveLength(1);
    expect(writes.filter((write) => write.table !== 'solidgate_webhook_events')).toHaveLength(0);
  });

  it('completes a captured PDF-coded OTO without enqueueing PDF delivery', async () => {
    const claimedOrder = {
      ...ORDER_ROW,
      product_name: 'BRANDPDF5_000000_PDF',
      product_slug: 'BRANDPDF5_000000_PDF',
      solidgate_order_id: 'sess-1:oto5_pdf:1',
      solidgate_subscription_id: null,
      tracking_metadata: {
        funnel_code: 'BRAND',
        funnel_variant: 'oto5',
        session_id: 'sess-1',
        product_slug: 'oto5_pdf',
        locale: 'en',
      },
    };
    const { db, updatesTo, upsertsTo } = makeDb(
      [claimedOrder],
      undefined,
      {},
      { claim_solidgate_webhook_event_v2: [{
        claim_state: 'claimed',
        claim_token: '22222222-2222-4222-8222-222222222222',
        claim_generation: 3,
      }] },
    );
    const response = await serveRequest(
      await makeWebhookRequest(
        'card_gate.order.updated',
        positiveOrderPayload(claimedOrder),
        'evt-reclaimed',
      ),
      db,
    );

    expect(response.status).toBe(200);
    expect(updatesTo('orders')).toContainEqual(expect.objectContaining({ status: 'completed' }));
    expect(updatesTo('solidgate_webhook_events')).toContainEqual(expect.objectContaining({
      status: 'completed',
    }));
    expect(upsertsTo('solidgate_fulfillment_outbox')).toHaveLength(0);
  });

  it('cannot complete or fail the inbox after its token/generation fence is stale', async () => {
    const staleToken = '44444444-4444-4444-8444-444444444444';
    const { db, writes, rpcCalls } = makeDb(
      [],
      undefined,
      {},
      {
        claim_solidgate_webhook_event_v2: [{
          claim_state: 'claimed', claim_token: staleToken, claim_generation: 7,
        }],
        complete_solidgate_webhook_event_v2: false,
        fail_solidgate_webhook_event_v2: false,
      },
    );
    const response = await serveRequest(
      await makeWebhookRequest(
        'card_gate.order.updated',
        { order: { order_id: 'another-brand-stale-owner-order', status: 'settle_ok' } },
        'evt-stale-owner',
      ),
      db,
    );

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain('claim is stale');
    expect(writes.filter((write) => write.table === 'solidgate_webhook_events')).toHaveLength(0);
    expect(rpcCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'complete_solidgate_webhook_event_v2',
        args: expect.objectContaining({
          p_claim_token: staleToken,
          p_claim_generation: 7,
        }),
      }),
      expect.objectContaining({
        name: 'fail_solidgate_webhook_event_v2',
        args: expect.objectContaining({
          p_claim_token: staleToken,
          p_claim_generation: 7,
        }),
      }),
    ]));
  });

  it('keeps the Boolean legacy RPC and adds fenced v2 claim states', () => {
    const migration = readFileSync(
      resolve(
        process.cwd(),
        '../../supabase/migrations/00001_baseline.sql',
      ),
      'utf8',
    );

    expect(migration).toContain('claim_solidgate_webhook_event_v2');
    expect(migration).toContain("'claimed'::TEXT");
    expect(migration).toContain("'completed'::TEXT");
    expect(migration).toContain("'busy'::TEXT");
    expect(migration).not.toMatch(/DROP FUNCTION[^;]*claim_solidgate_webhook_event\s*\(/i);
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.claim_solidgate_webhook_event\([\s\S]+?RETURNS BOOLEAN/i,
    );
    expect(migration).toMatch(/claim_token\s*=\s*NULL/);
    expect(migration).toMatch(/claim_generation\s*=\s*public\.solidgate_webhook_events\.claim_generation\s*\+\s*1/);
    expect(migration).toContain('claim_token UUID');
    expect(migration).toContain('claim_generation BIGINT');
    expect(migration).toContain('complete_solidgate_webhook_event_v2');
    expect(migration).toContain('fail_solidgate_webhook_event_v2');
    expect(migration).toMatch(/processing_started_at\s+IS NULL/);
    expect(migration).toMatch(/processing_started_at\s+< NOW\(\) - make_interval/);
    expect(migration).toContain('SECURITY INVOKER');
    expect(migration).toContain("SET search_path = ''");
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION[\s\S]+FROM PUBLIC, anon, authenticated/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]+TO service_role/);
  });
});

describe('fail-closed database boundaries', () => {
  const cases: Array<{
    name: string;
    eventType: string;
    payload: unknown;
    orders: Row[];
    extras?: Record<string, Row[]>;
    failures: DbFailures;
    error: string;
  }> = [
    {
      name: 'order ownership read',
      eventType: 'card_gate.order.updated',
      payload: {
        order: { order_id: ORDER_ROW.solidgate_order_id, status: 'settle_ok', amount: 1767 },
      },
      orders: [{ ...ORDER_ROW }],
      failures: { reads: { orders: 'orders read unavailable' } },
      error: 'order lookup failed',
    },
    {
      name: 'initial settlement write',
      eventType: 'card_gate.order.updated',
      payload: positiveOrderPayload(ORDER_ROW),
      orders: [{ ...ORDER_ROW }],
      failures: { writes: { orders: 'orders write unavailable' } },
      error: 'order settlement update failed',
    },
    {
      name: 'refund write',
      eventType: 'card_gate.order.updated',
      payload: {
        order: {
          order_id: ORDER_ROW.solidgate_order_id,
          status: 'refunded',
          amount: 1767,
          refunded_amount: 1767,
        },
      },
      orders: [{ ...ORDER_ROW, status: 'completed' }],
      failures: { writes: { orders: 'refund write unavailable' } },
      error: 'order refund update failed',
    },
    {
      name: 'void entitlement revoke',
      eventType: 'card_gate.order.updated',
      payload: {
        order: { order_id: ORDER_ROW.solidgate_order_id, status: 'void_ok', amount: 1767 },
      },
      orders: [{ ...ORDER_ROW, status: 'trialing' }],
      failures: { writes: { entitlements: 'revoke unavailable' } },
      error: 'void entitlement revoke failed',
    },
    {
      name: 'decline write',
      eventType: 'card_gate.order.updated',
      payload: {
        order: { order_id: ORDER_ROW.solidgate_order_id, status: 'auth_failed' },
      },
      orders: [{ ...ORDER_ROW }],
      failures: { writes: { orders: 'decline write unavailable' } },
      error: 'order decline update failed',
    },
    {
      name: 'recurring payment mapping read',
      eventType: 'card_gate.order.updated',
      payload: {
        order: { order_id: 'generated-renewal', status: 'refunded', refunded_amount: 5900 },
      },
      orders: [],
      failures: { reads: { solidgate_invoice_orders: 'mapping read unavailable' } },
      error: 'recurring order lookup failed',
    },
    {
      name: 'subscription lifecycle write',
      eventType: 'subscription.updated.v2',
      payload: {
        callback_type: 'cancel',
        subscription: { id: 'sub-uuid-1', status: 'cancelled' },
      },
      orders: [capturedSubscriptionOrder()],
      extras: {
        entitlements: [subscriptionEntitlement(capturedSubscriptionOrder())],
      },
      failures: { writes: { orders: 'subscription write unavailable' } },
      error: 'subscription cancellation update failed',
    },
    {
      name: 'subscription binding ownership read',
      eventType: 'subscription.updated.v2',
      payload: {
        callback_type: 'active',
        subscription: { id: 'sub-raced', status: 'active', trial: true },
        customer: { customer_account_id: 'sess-1' },
        invoices: {
          raced: {
            id: 'inv-raced',
            status: 'success',
            amount: 1767,
            order_metadata: { session_id: 'sess-1', product_slug: 'trial4' },
          },
        },
      },
      orders: [{ ...ORDER_ROW, solidgate_subscription_id: null, psp: 'solidgate' }],
      failures: { reads: { sessions: 'session ownership unavailable' } },
      error: 'subscription session ownership lookup failed',
    },
    {
      name: 'chargeback write',
      eventType: 'card_gate.chargeback.received',
      payload: {
        order: { order_id: ORDER_ROW.solidgate_order_id, amount: 1767, currency: 'USD' },
        chargeback: { id: 'cb-write-error', status: 'in_progress', amount: 1767 },
      },
      orders: [{ ...ORDER_ROW, status: 'completed' }],
      failures: { writes: { orders: 'chargeback write unavailable' } },
      error: 'chargeback order update failed',
    },
    {
      name: 'renewal chargeback mapping read',
      eventType: 'card_gate.chargeback.received',
      payload: {
        order: { order_id: 'generated-chargeback', amount: 5900, currency: 'USD' },
        chargeback: { id: 'cb-read-error', status: 'in_progress', amount: 5900 },
      },
      orders: [],
      failures: { reads: { solidgate_invoice_orders: 'chargeback mapping unavailable' } },
      error: 'chargeback renewal mapping lookup failed',
    },
  ];

  it.each(cases)('$name error returns 5xx, persists failure, and stops downstream effects', async ({
    eventType,
    payload,
    orders,
    extras,
    failures,
    error,
  }) => {
    const { db, writes, updatesTo, upsertsTo } = makeDb(
      orders,
      undefined,
      extras ?? {},
      { claim_solidgate_webhook_event_v2: [{
        claim_state: 'claimed',
        claim_token: '33333333-3333-4333-8333-333333333333',
        claim_generation: 1,
      }] },
      failures,
    );
    const response = await serveRequest(
      await makeWebhookRequest(eventType, payload, `evt-${error.replaceAll(' ', '-')}`),
      db,
    );

    expect(response.status).toBeGreaterThanOrEqual(500);
    await expect(response.text()).resolves.toContain(error);
    expect(updatesTo('solidgate_webhook_events')).toContainEqual(expect.objectContaining({
      status: 'failed',
    }));
    expect(updatesTo('solidgate_webhook_events')).not.toContainEqual(expect.objectContaining({
      status: 'completed',
    }));
    expect(upsertsTo('entitlements')).toHaveLength(0);
    expect(upsertsTo('solidgate_analytics_outbox')).toHaveLength(0);
    expect(
      writes.filter((write) =>
        write.table === 'solidgate_webhook_events' && write.payload.status === 'completed'
      ),
    ).toHaveLength(0);
  });
});

describe('positive settlement binding', () => {
  it('models provider product names without inventing one for amount-based OTOs', () => {
    const subscription = positiveOrderPayload(ORDER_ROW);
    const oneTimeOrder = {
      ...ORDER_ROW,
      product_name: 'BRANDPDF5_000000_PDF',
      product_slug: 'BRANDPDF5_000000_PDF',
      solidgate_order_id: 'sess-1:oto5_pdf:1',
      solidgate_subscription_id: null,
      tracking_metadata: {
        funnel_code: 'BRAND',
        funnel_variant: 'oto5',
        session_id: 'sess-1',
        product_slug: 'oto5_pdf',
        locale: 'en',
      },
    };
    const oneTime = positiveOrderPayload(oneTimeOrder);

    expect(subscription.order.product_name).toBe('Provider Monthly (trial4)');
    expect(oneTime.order).not.toHaveProperty('product_name');
    expect(oneTime.order).not.toHaveProperty('product_id');
  });

  const canonicalMismatchRow = {
    ...ORDER_ROW,
    solidgate_order_id: 'sess-1:not-trial4:1',
  };
  const metadataMismatch = {
    ...ORDER_ROW.tracking_metadata,
    product_slug: 'trial3',
  };
  const cases: Array<{ name: string; row: Row; payload: unknown }> = [
    {
      name: 'canonical order identity',
      row: canonicalMismatchRow,
      payload: positiveOrderPayload(canonicalMismatchRow),
    },
    {
      name: 'authorized amount',
      row: ORDER_ROW,
      payload: positiveOrderPayload(ORDER_ROW, { amount: 9999 }),
    },
    {
      name: 'currency',
      row: ORDER_ROW,
      payload: positiveOrderPayload(ORDER_ROW, { currency: 'EUR' }),
    },
    {
      name: 'customer account',
      row: ORDER_ROW,
      payload: positiveOrderPayload(ORDER_ROW, { customer_account_id: 'sess-attacker' }),
    },
    {
      name: 'customer email',
      row: ORDER_ROW,
      payload: positiveOrderPayload(ORDER_ROW, { customer_email: 'attacker@example.com' }),
    },
    {
      name: 'catalog product',
      row: ORDER_ROW,
      payload: positiveOrderPayload(ORDER_ROW, {
        product_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }),
    },
    {
      name: 'catalog price',
      row: ORDER_ROW,
      payload: positiveOrderPayload(ORDER_ROW, {}, {
        ...ORDER_ROW.tracking_metadata,
        price_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      }),
    },
    {
      name: 'subscription',
      row: ORDER_ROW,
      payload: positiveOrderPayload(ORDER_ROW, { subscription_id: 'sub-attacker' }),
    },
    {
      name: 'tracking metadata',
      row: ORDER_ROW,
      payload: positiveOrderPayload(ORDER_ROW, {}, metadataMismatch),
    },
  ];

  it.each(cases)('rejects a $name mismatch before any business mutation', async ({
    name,
    row,
    payload,
  }) => {
    const { db, writes, upsertsTo, updatesTo } = makeDb([row]);
    const response = await serveRequest(
      await makeWebhookRequest(
        'card_gate.order.updated',
        payload,
        `evt-binding-${name.replaceAll(' ', '-')}`,
      ),
      db,
    );

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain('positive settlement');
    expect(updatesTo('orders')).toHaveLength(0);
    expect(upsertsTo('entitlements')).toHaveLength(0);
    expect(upsertsTo('solidgate_analytics_outbox')).toHaveLength(0);
    expect(upsertsTo('solidgate_fulfillment_outbox')).toHaveLength(0);
    expect(
      writes.filter((write) => write.table !== 'solidgate_webhook_events'),
    ).toHaveLength(0);
  });

  it('completes a settle whose session the buyer already claimed before the callback landed', async () => {
    // Grant polling stops at auth_ok, so the buyer can reach the PWA login and
    // claim the session while the order is still unclaimed. The settle retry
    // must recognise the session owner as the buyer and finish provisioning
    // instead of dead-ending on the ownership mismatch forever.
    const pendingOrder = { ...ORDER_ROW, user_id: null, solidgate_subscription_id: null };
    const { db, createUser, updatesTo, upsertsTo, rpcsTo } = makeDb(
      [pendingOrder],
      [{ id: 'sess-1', email: 'buyer@example.com', locale: 'en', user_id: 'pwa-login-user' }],
      {},
      { find_auth_user_id_by_email: 'pwa-login-user' },
    );

    await handleEvent(db, 'card_gate.order.updated', positiveOrderPayload(pendingOrder));

    expect(createUser).toHaveBeenCalledTimes(1);
    expect(updatesTo('orders')).toContainEqual(expect.objectContaining({
      user_id: 'pwa-login-user',
    }));
    expect(updatesTo('sessions')).toHaveLength(0);
    expect(rpcsTo('grant_solidgate_main_entitlement')).toContainEqual(expect.objectContaining({
      p_user_id: 'pwa-login-user',
      p_order_id: 'order-1',
    }));
    expect(upsertsTo('solidgate_fulfillment_outbox')).toContainEqual([
      expect.objectContaining({
        effect_key: 'enrich_main_profile',
        payload: { user_id: 'pwa-login-user' },
      }),
      expect.objectContaining({
        effect_key: 'send_welcome_email',
        payload: { user_id: 'pwa-login-user' },
      }),
      expect.objectContaining({
        effect_key: 'send_meta_capi_purchase',
        payload: { user_id: 'pwa-login-user' },
      }),
    ]);
  });

  it('rejects a settle whose unclaimed order session belongs to a different account', async () => {
    const pendingOrder = { ...ORDER_ROW, user_id: null, solidgate_subscription_id: null };
    const { db, writes, updatesTo, upsertsTo } = makeDb(
      [pendingOrder],
      [{ id: 'sess-1', email: 'buyer@example.com', locale: 'en', user_id: 'foreign-user' }],
      {},
      { find_auth_user_id_by_email: 'buyer-account' },
    );

    const response = await serveRequest(
      await makeWebhookRequest(
        'card_gate.order.updated',
        positiveOrderPayload(pendingOrder),
        'evt-foreign-session-owner',
      ),
      db,
    );

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain(
      'positive settlement customer ownership binding mismatch',
    );
    expect(updatesTo('orders')).toHaveLength(0);
    expect(upsertsTo('entitlements')).toHaveLength(0);
    expect(upsertsTo('solidgate_fulfillment_outbox')).toHaveLength(0);
    expect(
      writes.filter((write) => write.table !== 'solidgate_webhook_events'),
    ).toHaveLength(0);
  });

  it('keeps the hard mismatch for a claimed order regardless of the buyer email lookup', async () => {
    const { db, writes, updatesTo, rpcsTo } = makeDb(
      [ORDER_ROW],
      [{ id: 'sess-1', email: 'buyer@example.com', locale: 'en', user_id: 'other-user' }],
      {},
      { find_auth_user_id_by_email: 'other-user' },
    );

    const response = await serveRequest(
      await makeWebhookRequest(
        'card_gate.order.updated',
        positiveOrderPayload(ORDER_ROW),
        'evt-claimed-order-session-mismatch',
      ),
      db,
    );

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain(
      'positive settlement customer ownership binding mismatch',
    );
    expect(rpcsTo('find_auth_user_id_by_email')).toHaveLength(0);
    expect(updatesTo('orders')).toHaveLength(0);
    expect(
      writes.filter((write) => write.table !== 'solidgate_webhook_events'),
    ).toHaveLength(0);
  });
});

describe('card_gate.order.updated', () => {
  it.each([
    ['canceled', { status: 'canceled' }],
    ['charged back', {
      status: 'disputed',
      solidgate_chargeback_id: 'chargeback-1',
      solidgate_chargeback_status: 'in_progress',
      solidgate_chargeback_amount_cents: 1767,
    }],
  ])('does not resurrect a %s order from a later settle replay', async (_label, terminal) => {
    const { db, updatesTo, upsertsTo } = makeDb([{ ...ORDER_ROW, ...terminal }]);

    await handleEvent(db, 'card_gate.order.updated', {
      order: {
        order_id: 'sess-1:trial4:1',
        status: 'settle_ok',
        amount: 1767,
        currency: 'USD',
        subscription_id: 'sub-uuid-1',
      },
    });

    expect(updatesTo('orders')).toHaveLength(0);
    expect(upsertsTo('entitlements')).toHaveLength(0);
  });

  it('does not clear a matching entitlement revoke tombstone on settle replay', async () => {
    const { db, upsertsTo } = makeDb(
      [{ ...ORDER_ROW, status: 'completed' }],
      [],
      {
        entitlements: [{
          order_id: 'order-1',
          payment_environment: 'production',
          status: 'canceled',
          revoked_at: '2026-07-16T10:00:00.000Z',
        }],
      },
    );

    await handleEvent(db, 'card_gate.order.updated', {
      order: {
        order_id: 'sess-1:trial4:1',
        status: 'settle_ok',
        amount: 1767,
        currency: 'USD',
        subscription_id: 'sub-uuid-1',
      },
    });

    expect(upsertsTo('entitlements')).toHaveLength(0);
  });

  it('keeps identical sandbox/live order ids in separate ledgers and suppresses sandbox analytics', async () => {
    configureWebhookRuntime({
      environment: 'sandbox',
      analyticsEnabled: false,
      customerSideEffectsEnabled: false,
    });
    const sandboxOrder = {
      ...ORDER_ROW,
      id: 'sandbox-order',
      user_id: 'sandbox-user',
      payment_environment: 'sandbox',
    };
    const { db, writes, upsertsTo, rpcsTo } = makeDb([
      { ...ORDER_ROW, id: 'live-order', user_id: 'live-user', payment_environment: 'production' },
      sandboxOrder,
    ], [{ id: 'sess-1', email: 'buyer@example.com', locale: 'en', user_id: 'sandbox-user' }]);

    try {
      await handleEvent(
        db,
        'card_gate.order.updated',
        positiveOrderPayload(sandboxOrder),
        { environment: 'sandbox' },
      );

      const orderWrite = writes.find((write) => write.table === 'orders' && write.op === 'update');
      expect(orderWrite?.filters).toContainEqual({
        column: 'payment_environment',
        value: 'sandbox',
      });
      expect(rpcsTo('grant_solidgate_main_entitlement')[0]).toMatchObject({
        p_payment_environment: 'sandbox',
        p_user_id: 'sandbox-user',
        p_order_id: 'sandbox-order',
      });
      expect(upsertsTo('solidgate_analytics_outbox')).toHaveLength(0);
    } finally {
      configureWebhookRuntime({
        environment: 'production',
        analyticsEnabled: true,
        customerSideEffectsEnabled: true,
      });
    }
  });

  it('settles a charge our API route left pending (the async-charge safety net)', async () => {
    const { db, updatesTo, upsertsTo, rpcsTo } = makeDb([{ ...ORDER_ROW }]);
    await handleEvent(db, 'card_gate.order.updated', {
      ...positiveOrderPayload(ORDER_ROW),
      transactions: {
        t1: webhookTokenAuthorization('t1'),
      },
    });

    expect(updatesTo('orders')[0]).toMatchObject({ status: 'trialing', solidgate_subscription_id: 'sub-uuid-1' });
    // The token is what the entire OTO chain spends.
    expect(rpcsTo('write_solidgate_session_vault_monotonic')[0]).toEqual({
      p_payment_environment: 'production',
      p_session_id: 'sess-1',
      p_source_order_id: 'order-1',
      p_customer_account_id: 'sess-1',
      p_card_token: 'tok_abc',
      p_original_payment_method: 'card',
      p_card_brand: 'VISA',
      p_card_last4: '9265',
    });
    // If the browser grant vanished after payment, the webhook still promotes
    // the session token to the authenticated account before acknowledging.
    expect(rpcsTo('promote_solidgate_session_vault_monotonic')[0]).toEqual({
      p_payment_environment: 'production',
      p_user_id: 'user-1',
      p_session_id: 'sess-1',
    });
    expect(rpcsTo('grant_solidgate_main_entitlement')[0]).toMatchObject({
      p_user_id: 'user-1',
      p_order_id: 'order-1',
      p_product_slug: 'BRAND_000000_SUB',
      p_subscription_id: 'sub-uuid-1',
    });
  });

  it('vaults an exact reusable token supplied only as the official singular auth transaction', async () => {
    const { db, rpcsTo } = makeDb([{ ...ORDER_ROW }]);

    await handleEvent(db, 'card_gate.order.updated', {
      ...positiveOrderPayload(ORDER_ROW),
      transaction: webhookTokenAuthorization('singular-auth'),
    });

    expect(rpcsTo('write_solidgate_session_vault_monotonic')[0]).toMatchObject({
      p_source_order_id: 'order-1',
      p_card_token: 'tok_abc',
      p_original_payment_method: 'card',
      p_card_brand: 'VISA',
      p_card_last4: '9265',
    });
  });

  it('uses signed order payment_method when Payment Form omits token provenance', async () => {
    const { db, rpcsTo } = makeDb([{ ...ORDER_ROW }]);

    await handleEvent(db, 'card_gate.order.updated', {
      ...positiveOrderPayload(ORDER_ROW, { payment_method: 'card' }),
      transaction: webhookTokenAuthorization('singular-auth', {
        card_token: {
          token: 'tok_abc',
          original_payment_method: undefined,
        },
      }),
    });

    expect(rpcsTo('write_solidgate_session_vault_with_method')[0]).toMatchObject({
      p_source_order_id: 'order-1',
      p_card_token: 'tok_abc',
      p_original_payment_method: 'card',
    });
  });

  it.each([
    ['Apple Pay', 'apple-pay', 'apple-pay'],
    ['Google Pay', 'google-pay', 'google-pay'],
  ] as const)(
    'vaults an operation-aligned %s token with provider provenance',
    async (_label, operation, originalPaymentMethod) => {
      const { db, rpcsTo, rpcCalls } = makeDb([{ ...ORDER_ROW }]);

      await handleEvent(db, 'card_gate.order.updated', {
        ...positiveOrderPayload(ORDER_ROW),
        transaction: webhookTokenAuthorization('wallet-auth', {
          operation,
          card_token: {
            token: `${originalPaymentMethod}-token`,
            original_payment_method: originalPaymentMethod,
          },
        }),
      });

      expect(rpcsTo('write_solidgate_session_vault_with_method')[0]).toMatchObject({
        p_source_order_id: 'order-1',
        p_card_token: `${originalPaymentMethod}-token`,
        p_original_payment_method: originalPaymentMethod,
      });
      expect(rpcCalls.some(
        (call) => call.name === 'write_solidgate_session_vault_with_method',
      )).toBe(true);
      expect(rpcCalls.some(
        (call) => call.name === 'promote_solidgate_session_vault_with_method',
      )).toBe(true);
    },
  );

  it.each([
    [
      'a singular transaction without an id',
      { transaction: webhookTokenAuthorization('auth-1', { id: undefined }) },
    ],
    [
      'a map key that conflicts with its nested id',
      { transactions: { 'map-auth': webhookTokenAuthorization('different-auth') } },
    ],
    [
      'conflicting direct and nested tokens',
      {
        transaction: webhookTokenAuthorization('auth-1', {
          card: {
            brand: 'VISA',
            number: '406742XXXXXX9265',
            card_token: { token: 'different-token' },
          },
        }),
      },
    ],
    [
      'conflicting duplicate card data',
      {
        transaction: webhookTokenAuthorization('auth-1'),
        transactions: {
          'auth-1': webhookTokenAuthorization('auth-1', {
            card: { brand: 'MASTERCARD', number: '406742XXXXXX9265' },
          }),
        },
      },
    ],
    [
      'conflicting direct and nested payment-method provenance',
      {
        transaction: webhookTokenAuthorization('auth-1', {
          card: {
            brand: 'VISA',
            number: '406742XXXXXX9265',
            card_token: {
              token: 'tok_abc',
              original_payment_method: 'google-pay',
            },
          },
        }),
      },
    ],
    [
      'an operation/provenance mismatch',
      {
        transaction: webhookTokenAuthorization('auth-1', {
          card_token: {
            token: 'tok_abc',
            original_payment_method: 'apple-pay',
          },
        }),
      },
    ],
    [
      'missing payment-method provenance',
      {
        transaction: webhookTokenAuthorization('auth-1', {
          card_token: {
            token: 'tok_abc',
            original_payment_method: undefined,
          },
        }),
      },
    ],
    [
      'a malformed payment-method provenance value',
      {
        transaction: webhookTokenAuthorization('auth-1', {
          card_token: {
            token: 'tok_abc',
            original_payment_method: ' apple-pay ',
          },
        }),
      },
    ],
  ])('settles and records a tokenless watermark for ambiguous %s', async (_case, transactionShape) => {
    const { db, updatesTo, rpcsTo } = makeDb([{ ...ORDER_ROW }]);

    await handleEvent(db, 'card_gate.order.updated', {
      ...positiveOrderPayload(ORDER_ROW),
      ...transactionShape,
    });

    expect(updatesTo('orders')[0]).toMatchObject({ status: 'trialing' });
    expect(rpcsTo('grant_solidgate_main_entitlement')).toHaveLength(1);
    expect(rpcsTo('write_solidgate_session_vault_monotonic')).toEqual([
      expect.objectContaining({
        p_source_order_id: 'order-1',
        p_card_token: null,
        p_original_payment_method: null,
        p_card_brand: null,
        p_card_last4: null,
      }),
    ]);
  });

  it.each([
    [
      'a non-authorization operation',
      { transactions: { 'auth-1': webhookTokenAuthorization('auth-1', { operation: 'settle' }) } },
    ],
    [
      'a different amount',
      { transactions: { 'auth-1': webhookTokenAuthorization('auth-1', { amount: 1766 }) } },
    ],
    [
      'a different currency',
      { transactions: { 'auth-1': webhookTokenAuthorization('auth-1', { currency: 'EUR' }) } },
    ],
    [
      'multiple distinct authorization tokens',
      {
        transactions: {
          'auth-1': webhookTokenAuthorization('auth-1'),
          'auth-2': webhookTokenAuthorization('auth-2', {
            card_token: { token: 'second-token' },
          }),
        },
      },
    ],
  ])('settles the signed order and watermarks %s without a token', async (_case, transactionShape) => {
    const { db, updatesTo, rpcsTo } = makeDb([{ ...ORDER_ROW }]);

    await handleEvent(db, 'card_gate.order.updated', {
      ...positiveOrderPayload(ORDER_ROW),
      ...transactionShape,
    });

    expect(updatesTo('orders')[0]).toMatchObject({ status: 'trialing' });
    expect(rpcsTo('grant_solidgate_main_entitlement')).toHaveLength(1);
    expect(rpcsTo('write_solidgate_session_vault_monotonic')).toEqual([
      expect.objectContaining({
        p_source_order_id: 'order-1',
        p_card_token: null,
        p_card_brand: null,
        p_card_last4: null,
      }),
    ]);
  });

  it('grants main access before surfacing a session-watermark repair failure', async () => {
    const { db, rpcsTo, rpcCalls } = makeDb(
      [{ ...ORDER_ROW }],
      undefined,
      {},
      {},
      { rpc: { write_solidgate_session_vault_monotonic: 'vault unavailable' } },
    );

    await expect(handleEvent(db, 'card_gate.order.updated', {
      ...positiveOrderPayload(ORDER_ROW),
    })).rejects.toThrow('session vault source write failed');

    expect(rpcsTo('grant_solidgate_main_entitlement')).toHaveLength(1);
    expect(rpcCalls.findIndex((call) => call.name === 'write_solidgate_session_vault_monotonic'))
      .toBeLessThan(rpcCalls.findIndex((call) => call.name === 'grant_solidgate_main_entitlement'));
  });

  it('does not acknowledge a captured main order when account promotion reports missing', async () => {
    const { db, rpcsTo } = makeDb(
      [{ ...ORDER_ROW }],
      undefined,
      {},
      { promote_solidgate_session_vault_monotonic: 'missing' },
    );

    await expect(handleEvent(db, 'card_gate.order.updated', {
      ...positiveOrderPayload(ORDER_ROW),
    })).rejects.toThrow('account vault promotion returned missing');

    expect(rpcsTo('grant_solidgate_main_entitlement')).toHaveLength(1);
  });

  it('uses the official singular settle transaction as exact partial-capture evidence', async () => {
    const { db, updatesTo, rpcsTo } = makeDb([{ ...ORDER_ROW }]);

    await handleEvent(db, 'card_gate.order.updated', {
      ...positiveOrderPayload(ORDER_ROW, { status: 'partial_settled' }),
      transaction: {
        id: 'settle-singular',
        operation: 'settle',
        status: 'success',
        amount: 1767,
        currency: 'USD',
      },
    });

    expect(updatesTo('orders')[0]).toMatchObject({ status: 'trialing' });
    expect(rpcsTo('grant_solidgate_main_entitlement')).toHaveLength(1);
  });

  it.each([
    [
      'a settle map key/id mismatch',
      {
        transactions: {
          'settle-map': {
            id: 'different-settle',
            operation: 'settle',
            status: 'success',
            amount: 1767,
            currency: 'USD',
          },
        },
      },
    ],
    [
      'conflicting duplicate settle money',
      {
        transaction: {
          id: 'settle-duplicate',
          operation: 'settle',
          status: 'success',
          amount: 1767,
          currency: 'USD',
        },
        transactions: {
          'settle-duplicate': {
            id: 'settle-duplicate',
            operation: 'settle',
            status: 'success',
            amount: 1000,
            currency: 'USD',
          },
        },
      },
    ],
  ])('fails closed on %s', async (_case, transactionShape) => {
    const { db, updatesTo, rpcsTo } = makeDb([{ ...ORDER_ROW }]);

    await expect(handleEvent(db, 'card_gate.order.updated', {
      ...positiveOrderPayload(ORDER_ROW),
      ...transactionShape,
    })).rejects.toThrow('positive settlement amount binding mismatch');

    expect(updatesTo('orders')).toHaveLength(0);
    expect(rpcsTo('grant_solidgate_main_entitlement')).toHaveLength(0);
  });

  it('retries durable main fulfillment after the order transition committed but outbox enqueue failed', async () => {
    const pendingOrder = {
      ...ORDER_ROW,
      user_id: null,
      solidgate_subscription_id: null,
    };
    const payload = positiveOrderPayload(pendingOrder);
    const first = makeDb(
      [pendingOrder],
      [{ id: 'sess-1', email: 'buyer@example.com', locale: 'en', user_id: null }],
      {},
      {},
      {
        writes: { solidgate_fulfillment_outbox: 'temporary outbox failure' },
        authCreate: { userId: 'webhook-user' },
      },
    );

    await expect(handleEvent(first.db, 'card_gate.order.updated', payload)).rejects.toThrow(
      'main enrichment outbox enqueue failed: temporary outbox failure',
    );
    expect(first.updatesTo('orders')).toContainEqual(expect.objectContaining({
      status: 'trialing',
      solidgate_subscription_id: 'sub-new',
      solidgate_payment_status: 'settle_ok',
    }));
    expect(first.createUser).toHaveBeenCalledTimes(1);

    // Supabase writes above are individually durable: model the redelivery
    // after the order/user/entitlement writes committed, while the outbox did
    // not. The pending/failed CAS now affects zero rows.
    const capturedOrder = {
      ...pendingOrder,
      user_id: 'webhook-user',
      // A subscription callback may advance the already-captured row before
      // this failed card event is redelivered; that must not strand its outbox.
      status: 'active',
      solidgate_subscription_id: 'sub-new',
      solidgate_original_amount_cents: 1767,
      solidgate_payment_status: 'settle_ok',
    };
    const lateAuth = makeDb(
      [capturedOrder],
      [{ id: 'sess-1', email: 'buyer@example.com', locale: 'en', user_id: 'webhook-user' }],
      {
        entitlements: [{
          order_id: 'order-1',
          payment_environment: 'production',
          status: 'active',
          revoked_at: null,
        }],
      },
    );
    await handleEvent(
      lateAuth.db,
      'card_gate.order.updated',
      positiveOrderPayload(capturedOrder, { status: 'auth_ok' }),
      {
        eventId: 'late-auth-same-time',
        eventCreatedAt: '2026-07-21T08:50:00.000Z',
        environment: 'production',
      },
    );
    expect(lateAuth.updatesTo('orders')).toHaveLength(0);

    const retry = makeDb(
      [capturedOrder],
      [{ id: 'sess-1', email: 'buyer@example.com', locale: 'en', user_id: 'webhook-user' }],
      {
        entitlements: [{
          order_id: 'order-1',
          payment_environment: 'production',
          status: 'active',
          revoked_at: null,
        }],
      },
    );

    await handleEvent(
      retry.db,
      'card_gate.order.updated',
      payload,
      {
        eventId: 'settle-retry-same-time',
        eventCreatedAt: '2026-07-21T08:50:00.000Z',
        environment: 'production',
      },
    );

    expect(retry.createUser).not.toHaveBeenCalled();
    expect(retry.upsertsTo('solidgate_fulfillment_outbox')).toContainEqual([
      expect.objectContaining({
        environment: 'production',
        solidgate_order_id: 'sess-1:trial4:1',
        effect_type: 'enrich_main_profile',
        effect_key: 'enrich_main_profile',
        payload: { user_id: 'webhook-user' },
      }),
      expect.objectContaining({
        environment: 'production',
        solidgate_order_id: 'sess-1:trial4:1',
        effect_type: 'send_welcome_email',
        effect_key: 'send_welcome_email',
        payload: { user_id: 'webhook-user' },
      }),
      expect.objectContaining({
        environment: 'production',
        solidgate_order_id: 'sess-1:trial4:1',
        effect_type: 'send_meta_capi_purchase',
        effect_key: 'send_meta_capi_purchase',
        payload: { user_id: 'webhook-user' },
      }),
    ]);
    expect(retry.rpcsTo('grant_solidgate_main_entitlement')).toContainEqual(expect.objectContaining({
      p_user_id: 'webhook-user',
      p_order_id: 'order-1',
    }));
    expect(retry.upsertsTo('solidgate_analytics_outbox')).not.toHaveLength(0);
  });

  it('queues lifetime replacement cancellation only after capture is recognised', async () => {
    const lifetime = {
      ...ORDER_ROW,
      id: 'lifetime-order-db',
      solidgate_order_id: 'sess-1:oto1_lifetime:1',
      solidgate_subscription_id: null,
      product_name: 'BRANDLIFETIME_000000_SUB',
      product_slug: 'BRANDLIFETIME_000000_SUB',
      amount_cents: 5900,
      tracking_metadata: {
        funnel_code: 'BRAND',
        funnel_variant: 'oto1',
        session_id: 'sess-1',
        product_slug: 'oto1_lifetime',
      },
    };
    const main = {
      ...ORDER_ROW,
      id: 'main-order-db',
      status: 'trialing',
      solidgate_order_id: 'sess-1:trial4:1',
      solidgate_subscription_id: 'sub-main',
      product_slug: 'BRAND_000000_SUB',
    };
    const { db, upsertsTo } = makeDb([lifetime, main]);

    await handleEvent(db, 'card_gate.order.updated', positiveOrderPayload(lifetime));

    expect(upsertsTo('solidgate_fulfillment_outbox')).toContainEqual([
      expect.objectContaining({
        solidgate_order_id: lifetime.solidgate_order_id,
        effect_type: 'cancel_main_subscription',
        effect_key: 'cancel_main_subscription:sub-main',
        payload: { subscription_id: 'sub-main' },
      }),
    ]);
  });

  /**
   * Throwing on a superseded claim aborted the whole handler, so Solidgate
   * retried the delivery forever and the buyer it had already charged never got
   * an account. The claim ledger stops us issuing a second payable intent; it
   * must not withhold provisioning after the money moved.
   */
  it('provisions a superseded intro subscription and flags it for a refund', async () => {
    const supersededOrder = {
      ...ORDER_ROW,
      solidgate_subscription_id: 'sub-superseded',
    };
    const { db, upsertsTo, rpcCalls } = makeDb(
      [supersededOrder],
      undefined,
      {},
      { consume_solidgate_intro_offer: 'superseded' },
    );

    await handleEvent(db, 'card_gate.order.updated', positiveOrderPayload(supersededOrder));

    expect(rpcCalls).toContainEqual(expect.objectContaining({
      name: 'grant_solidgate_main_entitlement',
    }));
    expect(upsertsTo('solidgate_analytics_outbox')[0]).toMatchObject({
      event_name: 'intro_offer_conflict',
      distinct_id: 'sess-1',
      properties: {
        environment: 'production',
        solidgate_order_id: 'sess-1:trial4:1',
        solidgate_subscription_id: 'sub-superseded',
        tier: 'trial4',
        resolution: 'granted_needs_refund',
      },
    });
    expect(
      rpcCalls.find((call) => call.name === 'consume_solidgate_intro_offer')?.args,
    ).toMatchObject({
      p_payment_environment: 'production',
      p_session_id: 'sess-1',
      p_tier: 'trial4',
      p_subscription_id: 'sub-superseded',
      p_email_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('still fails closed before access on an unrecognised consume result', async () => {
    const conflictOrder = {
      ...ORDER_ROW,
      solidgate_subscription_id: 'sub-conflict',
    };
    const { db, upsertsTo } = makeDb(
      [conflictOrder],
      undefined,
      {},
      { consume_solidgate_intro_offer: 'conflict' },
    );

    await expect(
      handleEvent(db, 'card_gate.order.updated', positiveOrderPayload(conflictOrder)),
    ).rejects.toThrow('intro offer conflict');

    expect(upsertsTo('entitlements')).toHaveLength(0);
    expect(upsertsTo('solidgate_analytics_outbox')[0]).toMatchObject({
      event_name: 'intro_offer_conflict',
      properties: { resolution: 'aborted' },
    });
  });

  it('never downgrades an order that already succeeded (events arrive out of order)', async () => {
    const { db, updatesTo } = makeDb([{ ...ORDER_ROW, status: 'completed' }]);
    await handleEvent(db, 'card_gate.order.updated', {
      order: { order_id: 'sess-1:trial4:1', status: 'auth_failed' },
    });
    expect(updatesTo('orders')).toHaveLength(0);
  });

  it('marks a decline failed', async () => {
    const { db, updatesTo } = makeDb([{ ...ORDER_ROW }]);
    await handleEvent(db, 'card_gate.order.updated', {
      order: { order_id: 'sess-1:trial4:1', status: 'auth_failed' },
    });
    expect(updatesTo('orders')[0]).toMatchObject({ status: 'failed' });
  });

  it('does not downgrade or revoke a browser grant that wins the decline CAS', async () => {
    const pending = { ...ORDER_ROW, user_id: null, status: 'pending' };
    const browserWinner = capturedSubscriptionOrder({ user_id: 'user-1' });
    const attempt = makeDb(
      [pending],
      undefined,
      { entitlements: [subscriptionEntitlement(browserWinner, { access_level: 'full' })] },
      {},
      {
        emptyUpdateSelectOn: { orders: [1] },
        updateRaceWinner: {
          orders: {
            user_id: browserWinner.user_id,
            status: browserWinner.status,
            solidgate_original_amount_cents: browserWinner.solidgate_original_amount_cents,
            solidgate_payment_status: browserWinner.solidgate_payment_status,
          },
        },
      },
    );

    await expect(handleEvent(attempt.db, 'card_gate.order.updated', {
      order: { order_id: 'sess-1:trial4:1', status: 'auth_failed' },
    })).resolves.toBeUndefined();

    const declineWrite = attempt.writes.find((write) =>
      write.table === 'orders' && write.op === 'update'
    );
    expect(declineWrite?.filters).toContainEqual({
      column: 'status',
      value: ['pending', 'failed'],
    });
    expect(attempt.updatesTo('entitlements')).toHaveLength(0);
    expect(attempt.upsertsTo('solidgate_analytics_outbox')).toHaveLength(0);
  });

  it('revokes access on a FULL refund but keeps it on a partial one', async () => {
    const full = makeDb([{ ...ORDER_ROW, status: 'completed' }]);
    await handleEvent(full.db, 'card_gate.order.updated', {
      order: { order_id: 'sess-1:trial4:1', status: 'refunded', refunded_amount: 1767 },
    });
    expect(full.updatesTo('orders')[0]).toMatchObject({ status: 'refunded' });
    expect(full.updatesTo('entitlements')[0]).toMatchObject({ status: 'canceled' });
    expect(
      full.writes.find((write) => write.table === 'entitlements' && write.op === 'update')?.filters,
    ).toContainEqual({ column: 'order_id', value: 'order-1' });

    const partial = makeDb([{ ...ORDER_ROW, status: 'completed' }]);
    await handleEvent(partial.db, 'card_gate.order.updated', {
      order: { order_id: 'sess-1:trial4:1', status: 'refunded', refunded_amount: 500 },
    });
    expect(partial.updatesTo('orders')[0]).toMatchObject({
      amount_cents: 1267,
      solidgate_refunded_amount_cents: 500,
    });
    expect(partial.updatesTo('orders')[0]).not.toHaveProperty('status');
    expect(partial.updatesTo('entitlements')).toHaveLength(0);
  });

  it('revokes an exact browser grant that commits before a full-refund update', async () => {
    const pending = { ...ORDER_ROW, user_id: null, status: 'pending' };
    const browserWinner = capturedSubscriptionOrder({ user_id: 'user-1' });
    const attempt = makeDb(
      [pending],
      undefined,
      { entitlements: [subscriptionEntitlement(browserWinner, { access_level: 'full' })] },
      {},
      {
        updateRaceWinner: {
          orders: {
            user_id: browserWinner.user_id,
            status: browserWinner.status,
            solidgate_original_amount_cents: browserWinner.solidgate_original_amount_cents,
            solidgate_payment_status: browserWinner.solidgate_payment_status,
          },
        },
      },
    );

    await handleEvent(attempt.db, 'card_gate.order.updated', {
      order: {
        order_id: 'sess-1:trial4:1',
        status: 'refunded',
        refunded_amount: 1767,
      },
    });

    expect(attempt.updatesTo('orders')[0]).toMatchObject({ status: 'refunded' });
    expect(attempt.updatesTo('entitlements')).toHaveLength(1);
    const revoke = attempt.writes.find((write) =>
      write.table === 'entitlements' && write.op === 'update'
    );
    expect(revoke?.filters).toContainEqual({ column: 'order_id', value: 'order-1' });
    expect(revoke?.filters).not.toContainEqual({ column: 'user_id', value: 'user-1' });
  });

  it('preserves a concurrent successful status on a partial refund without revoking access', async () => {
    const pending = { ...ORDER_ROW, user_id: null, status: 'pending' };
    const browserWinner = capturedSubscriptionOrder({ user_id: 'user-1' });
    const attempt = makeDb(
      [pending],
      undefined,
      { entitlements: [subscriptionEntitlement(browserWinner, { access_level: 'full' })] },
      {},
      {
        updateRaceWinner: {
          orders: {
            user_id: browserWinner.user_id,
            status: browserWinner.status,
            solidgate_original_amount_cents: browserWinner.solidgate_original_amount_cents,
            solidgate_payment_status: browserWinner.solidgate_payment_status,
          },
        },
      },
    );

    await handleEvent(attempt.db, 'card_gate.order.updated', {
      order: {
        order_id: 'sess-1:trial4:1',
        status: 'refunded',
        refunded_amount: 500,
      },
    });

    expect(attempt.updatesTo('orders')[0]).toMatchObject({
      amount_cents: 1267,
      solidgate_refunded_amount_cents: 500,
    });
    expect(attempt.updatesTo('orders')[0]).not.toHaveProperty('status');
    expect(attempt.updatesTo('entitlements')).toHaveLength(0);
  });

  it('does NOT grant on a positive auth_ok reservation', async () => {
    const { db, updatesTo, upsertsTo } = makeDb([{ ...ORDER_ROW, amount_cents: 1767 }]);
    await handleEvent(db, 'card_gate.order.updated', {
      order: {
        order_id: 'sess-1:trial4:1',
        status: 'auth_ok',
        amount: 1767,
        currency: 'USD',
        subscription_id: 'sub-uuid-1',
      },
    });
    expect(updatesTo('orders')[0]).toMatchObject({ solidgate_payment_status: 'auth_ok' });
    expect(updatesTo('orders')[0]).not.toHaveProperty('status');
    expect(upsertsTo('entitlements')).toHaveLength(0);
    expect(upsertsTo('solidgate_analytics_outbox')).toHaveLength(0);
  });

  it('accepts special_free auth_ok only with the exact reusable authorization token', async () => {
    const zeroTrialOrder = specialFreeOrder();
    const { db, updatesTo, rpcsTo, rpcCalls } = makeDb([zeroTrialOrder]);
    await handleEvent(
      db,
      'card_gate.order.updated',
      {
        ...positiveOrderPayload(
          zeroTrialOrder,
          {
            status: 'auth_ok',
            amount: 0,
            settled_amount: 0,
            payment_method: 'card',
          },
        ),
        transaction: webhookTokenAuthorization('free-auth', {
          amount: 0,
          card_token: {
            token: 'tok_free',
            original_payment_method: undefined,
          },
        }),
      },
    );
    expect(updatesTo('orders')[0]).toMatchObject({ status: 'trialing', amount_cents: 0 });
    expect(rpcsTo('write_solidgate_session_vault_monotonic')).toEqual([
      expect.objectContaining({
        p_source_order_id: 'order-1',
        p_card_token: 'tok_free',
      }),
    ]);
    expect(rpcsTo('grant_solidgate_main_entitlement')[0]).toMatchObject({
      p_amount_cents: 0,
      p_subscription_id: 'sub-free',
    });
    expect(rpcCalls.findIndex((call) => call.name === 'write_solidgate_session_vault_monotonic'))
      .toBeLessThan(rpcCalls.findIndex((call) => call.name === 'grant_solidgate_main_entitlement'));
  });

  it('rejects tokenless special_free before order, account, or entitlement success', async () => {
    const zeroTrialOrder = specialFreeOrder({
      user_id: null,
      solidgate_subscription_id: null,
    });
    const { db, updatesTo, rpcsTo, createUser } = makeDb(
      [zeroTrialOrder],
      [{ id: 'sess-1', email: 'buyer@example.com', locale: 'en', user_id: null }],
      {},
      {},
      { authCreate: { userId: 'free-user' } },
    );

    const response = await serveRequest(
      await makeWebhookRequest(
        'card_gate.order.updated',
        positiveOrderPayload(
          zeroTrialOrder,
          { status: 'auth_ok', amount: 0, settled_amount: 0 },
        ),
        'evt-special-free-tokenless',
      ),
      db,
    );

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain(
      'special_free reusable card authorization is missing',
    );
    expect(updatesTo('orders')).toHaveLength(0);
    expect(rpcsTo('write_solidgate_session_vault_monotonic')).toHaveLength(0);
    expect(rpcsTo('consume_solidgate_intro_offer')).toHaveLength(0);
    expect(rpcsTo('grant_solidgate_main_entitlement')).toHaveLength(0);
    expect(rpcsTo('fail_solidgate_webhook_event_v2')).toHaveLength(1);
    expect(rpcsTo('complete_solidgate_webhook_event_v2')).toHaveLength(0);
    expect(createUser).not.toHaveBeenCalled();
  });

  it.each([
    [
      'click-to-pay',
      webhookTokenAuthorization('free-click-to-pay', {
        amount: 0,
        card_token: {
          token: 'tok_click_to_pay',
          original_payment_method: 'click-to-pay',
        },
      }),
    ],
    [
      'operation/provenance-mismatched wallet',
      webhookTokenAuthorization('free-wallet-mismatch', {
        amount: 0,
        operation: 'auth',
        card_token: {
          token: 'tok_wallet',
          original_payment_method: 'apple-pay',
        },
      }),
    ],
    [
      'malformed provenance',
      webhookTokenAuthorization('free-malformed-origin', {
        amount: 0,
        card_token: {
          token: 'tok_unknown',
          original_payment_method: 'unknown-wallet',
        },
      }),
    ],
  ])(
    'does not create a ghost special_free grant for a %s credential',
    async (_case, transaction) => {
      const zeroTrialOrder = specialFreeOrder({
        user_id: null,
        solidgate_subscription_id: null,
      });
      const { db, updatesTo, rpcsTo, createUser } = makeDb(
        [zeroTrialOrder],
        [{ id: 'sess-1', email: 'buyer@example.com', locale: 'en', user_id: null }],
        {},
        {},
        { authCreate: { userId: 'free-user' } },
      );

      const response = await serveRequest(
        await makeWebhookRequest(
          'card_gate.order.updated',
          {
            ...positiveOrderPayload(
              zeroTrialOrder,
              { status: 'auth_ok', amount: 0, settled_amount: 0 },
            ),
            transaction,
          },
          `evt-special-free-${String(_case).replaceAll(' ', '-')}`,
        ),
        db,
      );

      expect(response.status).toBe(500);
      await expect(response.text()).resolves.toContain(
        'special_free reusable card authorization is missing',
      );
      expect(updatesTo('orders')).toHaveLength(0);
      expect(rpcsTo('write_solidgate_session_vault_with_method')).toHaveLength(0);
      expect(rpcsTo('consume_solidgate_intro_offer')).toHaveLength(0);
      expect(rpcsTo('grant_solidgate_main_entitlement')).toHaveLength(0);
      expect(createUser).not.toHaveBeenCalled();
    },
  );

  it('keeps a durable tokenless special_free replay retryable when card proof is not ready', async () => {
    const durableOrder = specialFreeOrder({
      status: 'trialing',
      solidgate_original_amount_cents: 0,
      solidgate_payment_status: 'auth_ok',
    });
    const { db, updatesTo, rpcsTo, createUser } = makeDb(
      [durableOrder],
      undefined,
      {},
      { solidgate_special_free_card_ready: false },
    );

    const response = await serveRequest(
      await makeWebhookRequest(
        'card_gate.order.updated',
        positiveOrderPayload(
          durableOrder,
          { status: 'auth_ok', amount: 0, settled_amount: 0 },
        ),
        'evt-special-free-durable-tokenless-unready',
      ),
      db,
    );

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain(
      'special_free durable reusable card is not ready',
    );
    expect(rpcsTo('solidgate_special_free_card_ready')).toEqual([
      { p_order_id: 'order-1' },
    ]);
    expect(updatesTo('orders')).toHaveLength(0);
    expect(rpcsTo('write_solidgate_session_vault_monotonic')).toHaveLength(0);
    expect(rpcsTo('consume_solidgate_intro_offer')).toHaveLength(0);
    expect(rpcsTo('grant_solidgate_main_entitlement')).toHaveLength(0);
    expect(rpcsTo('complete_solidgate_webhook_event_v2')).toHaveLength(0);
    expect(rpcsTo('fail_solidgate_webhook_event_v2')).toHaveLength(1);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('recovers a card-ready durable tokenless special_free order with no account or entitlement yet', async () => {
    const durableOrder = specialFreeOrder({
      user_id: null,
      status: 'trialing',
      solidgate_original_amount_cents: 0,
      solidgate_payment_status: 'auth_ok',
    });
    const { db, rpcsTo, createUser } = makeDb(
      [durableOrder],
      [{ id: 'sess-1', email: 'buyer@example.com', locale: 'en', user_id: null }],
      {},
      {},
      { authCreate: { userId: 'free-user' } },
    );

    const response = await serveRequest(
      await makeWebhookRequest(
        'card_gate.order.updated',
        positiveOrderPayload(
          durableOrder,
          { status: 'auth_ok', amount: 0, settled_amount: 0 },
        ),
        'evt-special-free-durable-tokenless-no-entitlement',
      ),
      db,
    );

    expect(response.status).toBe(200);
    expect(rpcsTo('solidgate_special_free_card_ready')).toHaveLength(2);
    expect(rpcsTo('write_solidgate_session_vault_monotonic')).toEqual([
      expect.objectContaining({
        p_source_order_id: 'order-1',
        p_card_token: null,
      }),
    ]);
    expect(rpcsTo('consume_solidgate_intro_offer')).toHaveLength(1);
    expect(rpcsTo('promote_solidgate_session_vault_monotonic')).toHaveLength(1);
    expect(rpcsTo('grant_solidgate_main_entitlement')).toHaveLength(1);
    expect(rpcsTo('complete_solidgate_webhook_event_v2')).toHaveLength(1);
    expect(rpcsTo('fail_solidgate_webhook_event_v2')).toHaveLength(0);
    expect(createUser).toHaveBeenCalledWith(expect.objectContaining({
      email: 'buyer@example.com',
    }));
  });

  it('recovers a card-ready durable tokenless special_free order over an older canceled entitlement', async () => {
    const durableOrder = specialFreeOrder({
      status: 'trialing',
      solidgate_original_amount_cents: 0,
      solidgate_payment_status: 'auth_ok',
    });
    const olderOrder = specialFreeOrder({
      id: 'order-older',
      solidgate_order_id: 'older-session:special_free:1',
      solidgate_subscription_id: 'sub-older',
      status: 'canceled',
      solidgate_original_amount_cents: 0,
      solidgate_payment_status: 'auth_ok',
      created_at: '2026-07-15T08:50:00.000Z',
    });
    const { db, rpcsTo, createUser } = makeDb(
      [durableOrder, olderOrder],
      undefined,
      {
        entitlements: [subscriptionEntitlement(olderOrder, {
          access_level: 'full',
          status: 'canceled',
          revoked_at: '2026-07-15T10:00:00.000Z',
        })],
      },
    );

    const response = await serveRequest(
      await makeWebhookRequest(
        'card_gate.order.updated',
        positiveOrderPayload(
          durableOrder,
          { status: 'auth_ok', amount: 0, settled_amount: 0 },
        ),
        'evt-special-free-durable-tokenless-replaces-older',
      ),
      db,
    );

    expect(response.status).toBe(200);
    expect(rpcsTo('solidgate_special_free_card_ready')).toHaveLength(2);
    expect(rpcsTo('write_solidgate_session_vault_monotonic')).toHaveLength(1);
    expect(rpcsTo('promote_solidgate_session_vault_monotonic')).toHaveLength(1);
    expect(rpcsTo('grant_solidgate_main_entitlement')).toHaveLength(1);
    expect(rpcsTo('complete_solidgate_webhook_event_v2')).toHaveLength(1);
    expect(rpcsTo('fail_solidgate_webhook_event_v2')).toHaveLength(0);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('keeps tokenless special_free recovery retryable when late entitlement arbitration rejects the grant', async () => {
    const durableOrder = specialFreeOrder({
      user_id: null,
      status: 'trialing',
      solidgate_original_amount_cents: 0,
      solidgate_payment_status: 'auth_ok',
    });
    const newerOrder = specialFreeOrder({
      id: 'order-newer',
      user_id: 'free-user',
      solidgate_order_id: 'other-session:special_free:1',
      solidgate_subscription_id: 'sub-newer',
      status: 'trialing',
      solidgate_original_amount_cents: 0,
      solidgate_payment_status: 'auth_ok',
      created_at: '2026-07-17T08:50:00.000Z',
    });
    const { db, rpcsTo, createUser } = makeDb(
      [durableOrder, newerOrder],
      [{ id: 'sess-1', email: 'buyer@example.com', locale: 'en', user_id: null }],
      {
        entitlements: [subscriptionEntitlement(newerOrder, {
          access_level: 'full',
        })],
      },
      { grant_solidgate_main_entitlement: false },
      { authCreate: { userId: 'free-user' } },
    );

    const response = await serveRequest(
      await makeWebhookRequest(
        'card_gate.order.updated',
        positiveOrderPayload(
          durableOrder,
          { status: 'auth_ok', amount: 0, settled_amount: 0 },
        ),
        'evt-special-free-durable-tokenless-late-conflict',
      ),
      db,
    );

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain(
      'special_free tokenless recovery entitlement grant was rejected',
    );
    expect(rpcsTo('solidgate_special_free_card_ready')).toHaveLength(2);
    expect(rpcsTo('write_solidgate_session_vault_monotonic')).toHaveLength(1);
    expect(rpcsTo('promote_solidgate_session_vault_monotonic')).toHaveLength(1);
    expect(rpcsTo('grant_solidgate_main_entitlement')).toHaveLength(1);
    expect(rpcsTo('complete_solidgate_webhook_event_v2')).toHaveLength(0);
    expect(rpcsTo('fail_solidgate_webhook_event_v2')).toHaveLength(1);
    expect(createUser).toHaveBeenCalledWith(expect.objectContaining({
      email: 'buyer@example.com',
    }));
  });

  it('keeps a durable tokenless special_free replay retryable when card readiness errors', async () => {
    const durableOrder = specialFreeOrder({
      status: 'trialing',
      solidgate_original_amount_cents: 0,
      solidgate_payment_status: 'auth_ok',
    });
    const { db, updatesTo, rpcsTo, createUser } = makeDb(
      [durableOrder],
      undefined,
      {},
      {},
      { rpc: { solidgate_special_free_card_ready: 'readiness unavailable' } },
    );

    const response = await serveRequest(
      await makeWebhookRequest(
        'card_gate.order.updated',
        positiveOrderPayload(
          durableOrder,
          { status: 'auth_ok', amount: 0, settled_amount: 0 },
        ),
        'evt-special-free-durable-tokenless-readiness-error',
      ),
      db,
    );

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain(
      'special_free durable card readiness check failed: readiness unavailable',
    );
    expect(updatesTo('orders')).toHaveLength(0);
    expect(rpcsTo('consume_solidgate_intro_offer')).toHaveLength(0);
    expect(rpcsTo('grant_solidgate_main_entitlement')).toHaveLength(0);
    expect(rpcsTo('complete_solidgate_webhook_event_v2')).toHaveLength(0);
    expect(rpcsTo('fail_solidgate_webhook_event_v2')).toHaveLength(1);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('ACKs an already fully granted durable tokenless special_free replay idempotently', async () => {
    const durableOrder = specialFreeOrder({
      status: 'trialing',
      solidgate_original_amount_cents: 0,
      solidgate_payment_status: 'auth_ok',
    });
    const { db, updatesTo, rpcsTo, createUser } = makeDb(
      [durableOrder],
      undefined,
      {
        entitlements: [subscriptionEntitlement(durableOrder, {
          access_level: 'full',
        })],
      },
    );

    const response = await serveRequest(
      await makeWebhookRequest(
        'card_gate.order.updated',
        positiveOrderPayload(
          durableOrder,
          { status: 'auth_ok', amount: 0, settled_amount: 0 },
        ),
        'evt-special-free-durable-tokenless-complete',
      ),
      db,
    );

    expect(response.status).toBe(200);
    expect(rpcsTo('solidgate_special_free_card_ready')).toEqual([
      { p_order_id: 'order-1' },
    ]);
    expect(updatesTo('orders')).toHaveLength(0);
    expect(rpcsTo('write_solidgate_session_vault_monotonic')).toHaveLength(0);
    expect(rpcsTo('consume_solidgate_intro_offer')).toHaveLength(0);
    expect(rpcsTo('grant_solidgate_main_entitlement')).toHaveLength(0);
    expect(rpcsTo('complete_solidgate_webhook_event_v2')).toHaveLength(1);
    expect(rpcsTo('fail_solidgate_webhook_event_v2')).toHaveLength(0);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('keeps a card-ready durable tokenless replay retryable when atomic grant rejects a newer entitlement', async () => {
    const durableOrder = specialFreeOrder({
      status: 'trialing',
      solidgate_original_amount_cents: 0,
      solidgate_payment_status: 'auth_ok',
    });
    const newerOrder = specialFreeOrder({
      id: 'order-newer',
      solidgate_order_id: 'newer-session:special_free:1',
      solidgate_subscription_id: 'sub-newer',
      status: 'trialing',
      solidgate_original_amount_cents: 0,
      solidgate_payment_status: 'auth_ok',
      created_at: '2026-07-17T08:50:00.000Z',
    });
    const { db, rpcsTo, createUser } = makeDb(
      [durableOrder, newerOrder],
      undefined,
      {
        entitlements: [subscriptionEntitlement(newerOrder, {
          access_level: 'full',
        })],
      },
      { grant_solidgate_main_entitlement: false },
    );

    const response = await serveRequest(
      await makeWebhookRequest(
        'card_gate.order.updated',
        positiveOrderPayload(
          durableOrder,
          { status: 'auth_ok', amount: 0, settled_amount: 0 },
        ),
        'evt-special-free-durable-tokenless-conflict',
      ),
      db,
    );

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain(
      'special_free tokenless recovery entitlement grant was rejected',
    );
    expect(rpcsTo('solidgate_special_free_card_ready')).toHaveLength(2);
    expect(rpcsTo('write_solidgate_session_vault_monotonic')).toHaveLength(1);
    expect(rpcsTo('consume_solidgate_intro_offer')).toHaveLength(1);
    expect(rpcsTo('promote_solidgate_session_vault_monotonic')).toHaveLength(1);
    expect(rpcsTo('grant_solidgate_main_entitlement')).toHaveLength(1);
    expect(rpcsTo('complete_solidgate_webhook_event_v2')).toHaveLength(0);
    expect(rpcsTo('fail_solidgate_webhook_event_v2')).toHaveLength(1);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('does not create an account or grant special_free when durable vault persistence fails', async () => {
    const zeroTrialOrder = specialFreeOrder({
      user_id: null,
      solidgate_subscription_id: null,
    });
    const { db, updatesTo, rpcsTo, createUser } = makeDb(
      [zeroTrialOrder],
      [{ id: 'sess-1', email: 'buyer@example.com', locale: 'en', user_id: null }],
      {},
      {},
      {
        authCreate: { userId: 'free-user' },
        rpc: { write_solidgate_session_vault_monotonic: 'vault unavailable' },
      },
    );

    const response = await serveRequest(
      await makeWebhookRequest(
        'card_gate.order.updated',
        {
          ...positiveOrderPayload(
            zeroTrialOrder,
            { status: 'auth_ok', amount: 0, settled_amount: 0 },
          ),
          transaction: webhookTokenAuthorization('free-auth', {
            amount: 0,
            card_token: { token: 'tok_free' },
          }),
        },
        'evt-special-free-vault-outage',
      ),
      db,
    );

    // The provider-success row is retryable, but no customer access side
    // effect happens until the reusable token is durably written.
    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain(
      'session vault source write failed: vault unavailable',
    );
    expect(updatesTo('orders')[0]).toMatchObject({ status: 'trialing' });
    expect(rpcsTo('consume_solidgate_intro_offer')).toHaveLength(0);
    expect(rpcsTo('grant_solidgate_main_entitlement')).toHaveLength(0);
    expect(rpcsTo('fail_solidgate_webhook_event_v2')).toHaveLength(1);
    expect(rpcsTo('complete_solidgate_webhook_event_v2')).toHaveLength(0);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('recovers a stale special_free source only when the DB proves a newer reusable card', async () => {
    const zeroTrialOrder = specialFreeOrder({
      user_id: null,
      solidgate_subscription_id: null,
    });
    const { db, rpcsTo, rpcCalls, createUser } = makeDb(
      [zeroTrialOrder],
      [{ id: 'sess-1', email: 'buyer@example.com', locale: 'en', user_id: null }],
      {},
      {
        write_solidgate_session_vault_monotonic: 'stale',
        solidgate_special_free_card_ready: true,
      },
      { authCreate: { userId: 'free-user' } },
    );

    const response = await serveRequest(
      await makeWebhookRequest(
        'card_gate.order.updated',
        {
          ...positiveOrderPayload(
            zeroTrialOrder,
            { status: 'auth_ok', amount: 0, settled_amount: 0 },
          ),
          transaction: webhookTokenAuthorization('free-auth', {
            amount: 0,
            card_token: { token: 'tok_free' },
          }),
        },
        'evt-special-free-stale-vault',
      ),
      db,
    );

    expect(response.status).toBe(200);
    expect(rpcsTo('write_solidgate_session_vault_monotonic')).toHaveLength(1);
    expect(rpcsTo('solidgate_special_free_card_ready')).toEqual([
      { p_order_id: 'order-1' },
    ]);
    expect(rpcsTo('consume_solidgate_intro_offer')).toHaveLength(1);
    expect(rpcsTo('promote_solidgate_session_vault_monotonic')).toHaveLength(1);
    expect(rpcsTo('grant_solidgate_main_entitlement')).toHaveLength(1);
    expect(rpcCalls.findIndex((call) => call.name === 'solidgate_special_free_card_ready'))
      .toBeLessThan(rpcCalls.findIndex((call) => call.name === 'grant_solidgate_main_entitlement'));
    expect(rpcCalls.findIndex((call) => call.name === 'promote_solidgate_session_vault_monotonic'))
      .toBeLessThan(rpcCalls.findIndex((call) => call.name === 'grant_solidgate_main_entitlement'));
    expect(rpcsTo('complete_solidgate_webhook_event_v2')).toHaveLength(1);
    expect(rpcsTo('fail_solidgate_webhook_event_v2')).toHaveLength(0);
    expect(createUser).toHaveBeenCalledWith(expect.objectContaining({ email: 'buyer@example.com' }));
  });

  it('keeps stale special_free retryable when no reusable-card source is ready', async () => {
    const zeroTrialOrder = specialFreeOrder({
      user_id: null,
      solidgate_subscription_id: null,
    });
    const { db, rpcsTo, createUser } = makeDb(
      [zeroTrialOrder],
      [{ id: 'sess-1', email: 'buyer@example.com', locale: 'en', user_id: null }],
      {},
      {
        write_solidgate_session_vault_monotonic: 'stale',
        solidgate_special_free_card_ready: false,
      },
      { authCreate: { userId: 'free-user' } },
    );

    const response = await serveRequest(
      await makeWebhookRequest(
        'card_gate.order.updated',
        {
          ...positiveOrderPayload(
            zeroTrialOrder,
            { status: 'auth_ok', amount: 0, settled_amount: 0 },
          ),
          transaction: webhookTokenAuthorization('free-auth', {
            amount: 0,
            card_token: { token: 'tok_free' },
          }),
        },
        'evt-special-free-stale-vault-unready',
      ),
      db,
    );

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain(
      'special_free reusable card readiness check failed: false',
    );
    expect(rpcsTo('solidgate_special_free_card_ready')).toEqual([
      { p_order_id: 'order-1' },
    ]);
    expect(rpcsTo('consume_solidgate_intro_offer')).toHaveLength(0);
    expect(rpcsTo('grant_solidgate_main_entitlement')).toHaveLength(0);
    expect(rpcsTo('complete_solidgate_webhook_event_v2')).toHaveLength(0);
    expect(rpcsTo('fail_solidgate_webhook_event_v2')).toHaveLength(1);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('keeps stale special_free retryable when the reusable-card proof RPC errors', async () => {
    const zeroTrialOrder = specialFreeOrder({
      user_id: null,
      solidgate_subscription_id: null,
    });
    const { db, rpcsTo, createUser } = makeDb(
      [zeroTrialOrder],
      [{ id: 'sess-1', email: 'buyer@example.com', locale: 'en', user_id: null }],
      {},
      { write_solidgate_session_vault_monotonic: 'stale' },
      {
        authCreate: { userId: 'free-user' },
        rpc: { solidgate_special_free_card_ready: 'readiness unavailable' },
      },
    );

    const response = await serveRequest(
      await makeWebhookRequest(
        'card_gate.order.updated',
        {
          ...positiveOrderPayload(
            zeroTrialOrder,
            { status: 'auth_ok', amount: 0, settled_amount: 0 },
          ),
          transaction: webhookTokenAuthorization('free-auth', {
            amount: 0,
            card_token: { token: 'tok_free' },
          }),
        },
        'evt-special-free-stale-vault-rpc-error',
      ),
      db,
    );

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain(
      'special_free reusable card readiness check failed: readiness unavailable',
    );
    expect(rpcsTo('consume_solidgate_intro_offer')).toHaveLength(0);
    expect(rpcsTo('grant_solidgate_main_entitlement')).toHaveLength(0);
    expect(rpcsTo('complete_solidgate_webhook_event_v2')).toHaveLength(0);
    expect(rpcsTo('fail_solidgate_webhook_event_v2')).toHaveLength(1);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('accepts same-source special_free vault persistence on an idempotent retry', async () => {
    const zeroTrialOrder = specialFreeOrder({
      status: 'trialing',
      solidgate_original_amount_cents: 0,
      solidgate_payment_status: 'auth_ok',
    });
    const { db, rpcsTo } = makeDb(
      [zeroTrialOrder],
      undefined,
      {},
      { write_solidgate_session_vault_monotonic: 'same' },
    );

    await handleEvent(db, 'card_gate.order.updated', {
      ...positiveOrderPayload(
        zeroTrialOrder,
        { status: 'auth_ok', amount: 0, settled_amount: 0 },
      ),
      transaction: webhookTokenAuthorization('free-auth', {
        amount: 0,
        card_token: { token: 'tok_free' },
      }),
    });

    expect(rpcsTo('write_solidgate_session_vault_monotonic')).toHaveLength(1);
    expect(rpcsTo('grant_solidgate_main_entitlement')).toHaveLength(1);
  });

  it('treats the paid PWA addon first week as full access, not a free trial', async () => {
    const eventCreatedAt = '2026-07-16T08:50:10.000Z';
    const pwaOrder = pwaAddonOrder();
    const { db, updatesTo, rpcsTo, rpcCalls } = makeDb([pwaOrder]);
    await handleEvent(
      db,
      'card_gate.order.updated',
      {
        ...positiveOrderPayload(pwaOrder),
        transaction: webhookTokenAuthorization('pwa-singular-auth', { amount: 5900 }),
      },
      { eventCreatedAt },
    );

    expect(updatesTo('orders')[0]).toMatchObject({
      status: 'active',
      solidgate_verify_url: null,
      solidgate_submission_token: null,
      solidgate_submission_started_at: null,
    });
    expect(rpcsTo('record_solidgate_pwa_confirmed_capture')[0]).toEqual({
      p_payment_environment: 'production',
      p_user_id: 'user-1',
      p_offer_slug: 'oto2_addon_weekly',
      p_product_slug: 'BRANDADDON_000000_SUB',
      p_order_db_id: 'order-1',
      p_solidgate_order_id: 'u-user-1:oto2_addon_weekly:1',
      p_amount_cents: 5900,
      p_currency: 'usd',
      p_provider_status: 'settle_ok',
      p_subscription_id: 'sub-addon-direct',
    });
    expect(rpcsTo('write_solidgate_account_vault_monotonic')[0]).toEqual({
      p_payment_environment: 'production',
      p_user_id: 'user-1',
      p_source_kind: 'pwa_order',
      p_source_id: 'order-1',
      p_source_claim_token: null,
      p_card_token: 'tok_abc',
      p_original_payment_method: 'card',
      p_card_brand: 'VISA',
      p_card_last4: '9265',
    });
    expect(rpcsTo('grant_solidgate_pwa_entitlement')[0]).toMatchObject({
      p_access_level: 'full',
      p_expires_at: '2026-07-23T08:50:10.000Z',
    });
    expect(rpcCalls.findIndex((call) => call.name === 'record_solidgate_pwa_confirmed_capture'))
      .toBeLessThan(rpcCalls.findIndex((call) => call.name === 'grant_solidgate_pwa_entitlement'));
    expect(rpcCalls.findIndex((call) => call.name === 'write_solidgate_account_vault_monotonic'))
      .toBeLessThan(rpcCalls.findIndex((call) => call.name === 'grant_solidgate_pwa_entitlement'));
  });

  it('publishes a tokenless hosted PWA watermark when no exact AUTH is present', async () => {
    const pwaOrder = pwaAddonOrder();
    const { db, rpcsTo } = makeDb([pwaOrder]);

    await handleEvent(db, 'card_gate.order.updated', positiveOrderPayload(pwaOrder));

    expect(rpcsTo('write_solidgate_account_vault_monotonic')).toEqual([
      expect.objectContaining({
        p_source_kind: 'pwa_order',
        p_source_id: 'order-1',
        p_card_token: null,
        p_card_brand: null,
        p_card_last4: null,
      }),
    ]);
    expect(rpcsTo('grant_solidgate_pwa_entitlement')).toHaveLength(1);
  });

  it.each(['saved_card', 'stale'] as const)(
    'grants an exact captured PWA %s result without vaulting webhook AUTH',
    async (captureMode) => {
      const pwaOrder = pwaAddonOrder();
      const { db, rpcsTo, rpcCalls } = makeDb(
        [pwaOrder],
        undefined,
        {},
        { record_solidgate_pwa_confirmed_capture: captureMode },
      );

      await handleEvent(db, 'card_gate.order.updated', {
        ...positiveOrderPayload(pwaOrder),
        transaction: webhookTokenAuthorization('pwa-saved-auth', { amount: 5900 }),
      });

      expect(rpcsTo('write_solidgate_account_vault_monotonic')).toHaveLength(0);
      expect(rpcsTo('grant_solidgate_pwa_entitlement')).toHaveLength(1);
      expect(rpcCalls.findIndex((call) => call.name === 'record_solidgate_pwa_confirmed_capture'))
        .toBeLessThan(rpcCalls.findIndex((call) => call.name === 'grant_solidgate_pwa_entitlement'));
    },
  );

  it('grants paid PWA access before surfacing a hosted account-vault repair failure', async () => {
    const pwaOrder = pwaAddonOrder();
    const { db, rpcsTo, rpcCalls } = makeDb(
      [pwaOrder],
      undefined,
      {},
      { record_solidgate_pwa_confirmed_capture: 'hosted_form' },
      { rpc: { write_solidgate_account_vault_monotonic: 'vault temporarily unavailable' } },
    );

    await expect(handleEvent(db, 'card_gate.order.updated', {
      ...positiveOrderPayload(pwaOrder),
      transaction: webhookTokenAuthorization('pwa-hosted-auth', { amount: 5900 }),
    })).rejects.toThrow('PWA account vault source write failed');

    expect(rpcsTo('grant_solidgate_pwa_entitlement')).toHaveLength(1);
    expect(rpcCalls.findIndex((call) => call.name === 'write_solidgate_account_vault_monotonic'))
      .toBeLessThan(rpcCalls.findIndex((call) => call.name === 'grant_solidgate_pwa_entitlement'));
  });

  it('keeps an under-captured partial settlement pending without access or revenue', async () => {
    const { db, updatesTo, upsertsTo } = makeDb([{ ...ORDER_ROW, amount_cents: 1767 }]);
    await handleEvent(db, 'card_gate.order.updated', {
      order: {
        order_id: 'sess-1:trial4:1',
        status: 'partial_settled',
        amount: 1767,
        settled_amount: 1200,
        currency: 'USD',
        subscription_id: 'sub-uuid-1',
      },
    });

    expect(updatesTo('orders')[0]).toMatchObject({ solidgate_payment_status: 'partial_settled' });
    expect(updatesTo('orders')[0]).not.toHaveProperty('status');
    expect(upsertsTo('entitlements')).toHaveLength(0);
    expect(upsertsTo('solidgate_analytics_outbox')).toHaveLength(0);
  });

  it('does not mistake order.amount for captured money when partial_settled omits settlement fields', async () => {
    const { db, updatesTo, upsertsTo } = makeDb([{ ...ORDER_ROW }]);
    await handleEvent(db, 'card_gate.order.updated', {
      order: {
        order_id: ORDER_ROW.solidgate_order_id,
        status: 'partial_settled',
        amount: 1767,
        currency: 'USD',
      },
      // This mirrors the published card webhook: order.amount is the original
      // authorization and there may be no non-standard settled_amount field.
      transactions: {
        auth: { status: 'success', operation: 'auth', amount: 1767 },
      },
    });

    expect(updatesTo('orders')[0]).toMatchObject({
      solidgate_payment_status: 'partial_settled',
    });
    expect(updatesTo('orders')[0]).not.toHaveProperty('status');
    expect(upsertsTo('entitlements')).toHaveLength(0);
    expect(upsertsTo('solidgate_analytics_outbox')).toHaveLength(0);
    expect(upsertsTo('solidgate_fulfillment_outbox')).toHaveLength(0);
  });

  it('accepts partial_settled only when its settled total covers the expected amount', async () => {
    const { db, updatesTo, upsertsTo, rpcsTo } = makeDb([{ ...ORDER_ROW, amount_cents: 1767 }]);
    await handleEvent(
      db,
      'card_gate.order.updated',
      {
        ...positiveOrderPayload(ORDER_ROW, { status: 'partial_settled' }),
        transactions: {
        'settle-1': {
          id: 'settle-1',
          operation: 'settle',
          status: 'success',
          amount: 1767,
          currency: 'USD',
          },
        },
      },
    );

    expect(updatesTo('orders')[0]).toMatchObject({ status: 'trialing', amount_cents: 1767 });
    expect(rpcsTo('grant_solidgate_main_entitlement')[0]).toMatchObject({
      p_amount_cents: 1767,
      p_subscription_id: 'sub-uuid-1',
    });
    expect(upsertsTo('solidgate_analytics_outbox')[0]).toMatchObject({
      event_name: 'subscription_started',
    });
  });

  it('marks a void failed, zeros net revenue and revokes an accidental grant', async () => {
    const { db, updatesTo } = makeDb([{ ...ORDER_ROW, status: 'trialing' }]);
    await handleEvent(db, 'card_gate.order.updated', {
      order: { order_id: 'sess-1:trial4:1', status: 'void_ok', amount: 1767, currency: 'USD' },
    });
    expect(updatesTo('orders')[0]).toMatchObject({
      status: 'failed',
      amount_cents: 0,
      solidgate_payment_status: 'void_ok',
    });
    expect(updatesTo('entitlements')[0]).toMatchObject({ status: 'canceled' });
  });

  it('revokes an exact browser grant that commits before a void update', async () => {
    const pending = { ...ORDER_ROW, user_id: null, status: 'pending' };
    const browserWinner = capturedSubscriptionOrder({ user_id: 'user-1' });
    const attempt = makeDb(
      [pending],
      undefined,
      { entitlements: [subscriptionEntitlement(browserWinner, { access_level: 'full' })] },
      {},
      {
        updateRaceWinner: {
          orders: {
            user_id: browserWinner.user_id,
            status: browserWinner.status,
            solidgate_original_amount_cents: browserWinner.solidgate_original_amount_cents,
            solidgate_payment_status: browserWinner.solidgate_payment_status,
          },
        },
      },
    );

    await handleEvent(attempt.db, 'card_gate.order.updated', {
      order: {
        order_id: 'sess-1:trial4:1',
        status: 'void_ok',
        amount: 1767,
        currency: 'USD',
      },
    });

    expect(attempt.updatesTo('orders')[0]).toMatchObject({
      status: 'failed',
      solidgate_payment_status: 'void_ok',
    });
    expect(attempt.updatesTo('entitlements')).toHaveLength(1);
    expect(
      attempt.writes.find((write) =>
        write.table === 'entitlements' && write.op === 'update'
      )?.filters,
    ).toContainEqual({ column: 'order_id', value: 'order-1' });
  });

  it('maps a generated renewal order refund back to its invoice ledger', async () => {
    const { db, updatesTo, upsertsTo } = makeDb([], [], {
      solidgate_invoice_orders: [{
        solidgate_order_id: 'sg-generated-order',
        solidgate_invoice_id: 'inv-renewal',
        solidgate_subscription_id: 'sub-uuid-1',
        amount_cents: 5900,
        currency: 'USD',
        refunded_amount_cents: 0,
        status: 'settle_ok',
        product_price_id: 'price-renewal-usd',
        order_metadata: {
          session_id: 'sess-1',
          product_slug: 'trial4',
          product_code: 'BRAND_000000_SUB',
          funnel_code: 'BRAND',
          funnel_variant: 'main',
          utm_source: 'fb',
          utm_campaign: 'Renewal cohort',
        },
      }],
      renewal_events: [{
        solidgate_invoice_id: 'inv-renewal',
        gross_amount_cents: 5900,
        amount_cents: 5900,
      }],
    });
    await handleEvent(db, 'card_gate.order.updated', {
      order: {
        order_id: 'sg-generated-order',
        status: 'refunded',
        amount: 5900,
        refunded_amount: 1200,
        currency: 'USD',
      },
    });
    expect(updatesTo('renewal_events')[0]).toMatchObject({
      amount_cents: 4700,
      refunded_amount_cents: 1200,
      status: 'partially_refunded',
    });
    expect(upsertsTo('solidgate_analytics_outbox')[0]).toMatchObject({
      event_name: 'payment_refunded',
      properties: {
        provider: 'solidgate',
        payment_provider: 'solidgate',
        billing_type: 'subscription_renewal',
        session_id: 'sess-1',
        product_slug: 'trial4',
        product: 'trial4',
        product_code: 'BRAND_000000_SUB',
        price_id: 'price-renewal-usd',
        solidgate_price_id: 'price-renewal-usd',
        funnel_code: 'BRAND',
        utm_source: 'fb',
        utm_campaign: 'Renewal cohort',
        refund_amount_cents: 1200,
      },
    });
  });

  it('ignores an order that is not ours', async () => {
    const { db, writes } = makeDb([]);
    await handleEvent(db, 'card_gate.order.updated', {
      order: { order_id: 'someone-else:x:1', status: 'settle_ok' },
    });
    expect(writes.filter((w) => w.op !== 'select')).toHaveLength(0);
  });
});

describe('durable server-side lifecycle analytics outbox', () => {
  it('reuses the persisted timestamp as well as the uuid when PostHog delivery retries', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    process.env.NEXT_PUBLIC_POSTHOG_HOST = 'https://eu.i.posthog.com';
    configureWebhookRuntime({ analyticsEnabled: true });
    const createdAt = '2026-07-16T08:50:10.000Z';
    const { db } = makeDb([], [], {}, {
      claim_solidgate_analytics_outbox: [{
        id: 'outbox-1',
        event_name: 'subscription_started',
        distinct_id: 'sess-1',
        insert_id: '6669b29c-e485-5a8a-b240-379ee8423448',
        properties: { solidgate_order_id: 'sess-1:trial4:1', revenue: 1767 },
        attempts: 2,
        created_at: createdAt,
      }],
    });

    await drainAnalyticsOutbox(db);

    expect(posthogCapture).toHaveBeenCalledWith(expect.objectContaining({
      event: 'subscription_started',
      uuid: '6669b29c-e485-5a8a-b240-379ee8423448',
      timestamp: new Date(createdAt),
    }));
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
  });

  it('marks analytics failed and throws so Solidgate redelivery retries without new traffic', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    process.env.NEXT_PUBLIC_POSTHOG_HOST = 'https://eu.i.posthog.com';
    configureWebhookRuntime({ analyticsEnabled: true });
    posthogCapture.mockImplementationOnce(() => {
      throw new Error('temporary PostHog failure');
    });
    const { db, updatesTo } = makeDb([], [], {}, {
      claim_solidgate_analytics_outbox: [{
        id: 'outbox-failed',
        event_name: 'purchase_completed',
        distinct_id: 'user-1',
        insert_id: '6669b29c-e485-5a8a-b240-379ee8423448',
        properties: { revenue: 9900 },
        attempts: 1,
        created_at: '2026-07-16T08:50:10.000Z',
      }],
    });

    await expect(drainAnalyticsOutbox(db)).rejects.toThrow(
      'analytics outbox delivery failed: temporary PostHog failure',
    );
    expect(updatesTo('solidgate_analytics_outbox')[0]).toMatchObject({
      status: 'failed',
      processing_started_at: null,
      last_error: 'temporary PostHog failure',
    });
    expect(
      new Date(updatesTo('solidgate_analytics_outbox')[0]!.next_attempt_at as string).getTime(),
    ).toBeLessThanOrEqual(Date.now());
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
  });

  it('queues canonical subscription_started + attribution before delivery', async () => {
    const attributedOrder = {
      ...ORDER_ROW,
      analytics_captured_at: null,
      tracking_metadata: {
        ...ORDER_ROW.tracking_metadata,
        funnel_code: 'TA',
        utm_source: 'fb',
        utm_campaign: 'Creative Testing',
      },
    };
    const { db, upsertsTo } = makeDb([attributedOrder]);
    await handleEvent(db, 'card_gate.order.updated', positiveOrderPayload(attributedOrder));
    expect(upsertsTo('solidgate_analytics_outbox')[0]).toMatchObject({
      event_key: 'order:sess-1:trial4:1:settled',
      event_name: 'subscription_started',
      distinct_id: 'sess-1',
      properties: {
        product_slug: 'trial4',
        product_code: 'BRAND_000000_SUB',
        funnel_code: 'TA',
        funnel_variant: 'main',
        utm_source: 'fb',
        utm_campaign: 'Creative Testing',
        transaction_id: 'sess-1:trial4:1',
        amount_cents: 1767,
        currency: 'USD',
        solidgate_order_id: 'sess-1:trial4:1',
        price_id: ORDER_ROW.tracking_metadata.price_id,
        billing_type: 'subscription_initial',
      },
    });
  });

  it('merges an authoritatively linked funnel UUID into the stable auth UUID exactly once', async () => {
    const sessionId = 'a02abb9d-f287-4ef2-b31c-fe7ef95c6f56';
    const userId = 'b08991b3-ebdc-4f7e-b6c5-e73245323c24';
    const oneTimeOrder = {
      ...ORDER_ROW,
      id: '4b762938-9020-4625-8ae8-7f63d089c2b5',
      session_id: sessionId,
      user_id: userId,
      solidgate_order_id: `${sessionId}:oto3_bundle_all:1`,
      product_name: 'BRANDBUNDLE_000000_PDF',
      product_slug: 'BRANDBUNDLE_000000_PDF',
      solidgate_subscription_id: null,
      amount_cents: 3000,
      currency: 'eur',
      tracking_metadata: {
        funnel_code: 'BRAND',
        funnel_variant: 'oto3',
        session_id: sessionId,
        product_slug: 'oto3_bundle_all',
        utm_source: 'fb',
        utm_campaign: 'Creative Testing',
      },
    };
    const { db, upsertsTo, rpcCalls } = makeDb(
      [oneTimeOrder],
      [{ id: sessionId, user_id: userId, locale: 'lt', email: 'buyer@example.com' }],
    );

    await handleEvent(db, 'card_gate.order.updated', positiveOrderPayload(oneTimeOrder));

    const analytics = upsertsTo('solidgate_analytics_outbox');
    expect(analytics).toHaveLength(2);
    expect(analytics[0]).toMatchObject({
      event_name: 'purchase_completed',
      distinct_id: sessionId,
      properties: { product_name: 'Bundle (all)', revenue: 3000 },
    });
    expect(analytics[1]).toMatchObject({
      event_key: `identity:production:${userId}:${sessionId}`,
      event_name: '$merge_dangerously',
      distinct_id: userId,
      properties: {
        alias: sessionId,
        user_id: userId,
        session_id: sessionId,
        source: 'solidgate_account_link',
        environment: 'production',
      },
    });
    expect(analytics[1]?.properties).not.toHaveProperty('revenue');
    expect(analytics[1]?.properties).not.toHaveProperty('amount_cents');
    expect(analytics[1]?.properties).not.toHaveProperty('currency');
    expect(
      rpcCalls.find((call) => call.name === 'persist_user_acquisition_attribution')?.args,
    ).toMatchObject({
      p_payment_environment: 'production',
      p_user_id: userId,
      p_source_session_id: sessionId,
      p_source_order_id: '4b762938-9020-4625-8ae8-7f63d089c2b5',
      p_utm_source: 'fb',
      p_utm_campaign: 'Creative Testing',
    });
  });

  it('does not queue an identity merge when sandbox analytics are disabled', async () => {
    const sessionId = 'a02abb9d-f287-4ef2-b31c-fe7ef95c6f56';
    const userId = 'b08991b3-ebdc-4f7e-b6c5-e73245323c24';
    configureWebhookRuntime({
      environment: 'sandbox',
      analyticsEnabled: false,
      customerSideEffectsEnabled: false,
    });
    const sandboxOneTimeOrder = {
      ...ORDER_ROW,
      session_id: sessionId,
      user_id: userId,
      payment_environment: 'sandbox',
      solidgate_order_id: `${sessionId}:oto3_bundle_all:1`,
      product_name: 'BRANDBUNDLE_000000_PDF',
      product_slug: 'BRANDBUNDLE_000000_PDF',
      solidgate_subscription_id: null,
      amount_cents: 3000,
      currency: 'eur',
      tracking_metadata: {
        funnel_code: 'BRAND',
        funnel_variant: 'oto3',
        session_id: sessionId,
        product_slug: 'oto3_bundle_all',
      },
    };
    const { db, upsertsTo } = makeDb(
      [sandboxOneTimeOrder],
      [{ id: sessionId, user_id: userId, locale: 'lt', email: 'buyer@example.com' }],
    );
    try {
      await handleEvent(
        db,
        'card_gate.order.updated',
        positiveOrderPayload(sandboxOneTimeOrder),
        { environment: 'sandbox' },
      );
      expect(upsertsTo('solidgate_analytics_outbox')).toHaveLength(0);
    } finally {
      configureWebhookRuntime({
        environment: 'production',
        analyticsEnabled: true,
        customerSideEffectsEnabled: true,
      });
    }
  });

  it('uses the same deterministic outbox key and insert id on a retry', async () => {
    const { db, upsertsTo } = makeDb([{ ...ORDER_ROW }]);
    const payload = positiveOrderPayload(ORDER_ROW);
    await handleEvent(db, 'card_gate.order.updated', payload);
    await handleEvent(db, 'card_gate.order.updated', payload);
    const attempts = upsertsTo('solidgate_analytics_outbox');
    expect(attempts).toHaveLength(2); // the DB UNIQUE(event_key) collapses these
    expect(attempts[0]?.event_key).toBe(attempts[1]?.event_key);
    expect(attempts[0]?.insert_id).toBe(attempts[1]?.insert_id);
  });

  it('queues one-time and zero-trial taxonomy without calling PostHog inline', async () => {
    const oneTimeOrder = {
      ...ORDER_ROW,
      product_name: 'BRANDPDF5_000000_PDF',
      product_slug: 'BRANDPDF5_000000_PDF',
      solidgate_order_id: 'sess-1:oto5_pdf:1',
      solidgate_subscription_id: null,
      amount_cents: 4600,
      tracking_metadata: {
        funnel_code: 'BRAND',
        funnel_variant: 'oto5',
        session_id: 'sess-1',
        product_slug: 'oto5_pdf',
      },
    };
    const oneTime = makeDb([
      oneTimeOrder,
    ]);
    await handleEvent(oneTime.db, 'card_gate.order.updated', positiveOrderPayload(oneTimeOrder));
    expect(oneTime.upsertsTo('solidgate_analytics_outbox')[0]).toMatchObject({ event_name: 'purchase_completed' });

    const addonOrder = {
      ...ORDER_ROW,
      amount_cents: 0,
      product_name: 'BRANDADDON_000000_SUB',
      product_slug: 'BRANDADDON_000000_SUB',
      solidgate_order_id: 'sess-1:oto2_addon_weekly:1',
      solidgate_subscription_id: 'sub-uuid-2',
      tracking_metadata: {
        funnel_code: 'BRAND',
        funnel_variant: 'oto2',
        session_id: 'sess-1',
        product_slug: 'oto2_addon_weekly',
        price_id: '5828b14b-ceee-48b2-86e8-825f2dfdf621',
      },
    };
    const addon = makeDb([addonOrder]);
    await handleEvent(
      addon.db,
      'card_gate.order.updated',
      positiveOrderPayload(addonOrder, { status: 'auth_ok', amount: 0, settled_amount: 0 }),
    );
    expect(addon.upsertsTo('solidgate_analytics_outbox')[0]).toMatchObject({ event_name: 'oto_subscription_started' });
    expect(posthogCapture).not.toHaveBeenCalled();
  });

  it('queues a payment_failed lifecycle event for declines', async () => {
    const { db, upsertsTo } = makeDb([{ ...ORDER_ROW, analytics_captured_at: null }]);
    await handleEvent(db, 'card_gate.order.updated', {
      order: { order_id: 'sess-1:trial4:1', status: 'auth_failed' },
    });
    expect(upsertsTo('solidgate_analytics_outbox')[0]).toMatchObject({ event_name: 'payment_failed' });
    expect(posthogCapture).not.toHaveBeenCalled();
  });
});

describe('subscription.updated.v2', () => {
  it('grants access to the next charge date and records term-1 renewal + generated order mapping', async () => {
    const captured = capturedSubscriptionOrder({ status: 'trialing' });
    const { db, updatesTo, upsertsTo, rpcsTo } = makeDb(
      [captured],
      [{ id: 'sess-1', email: 'buyer@example.com', locale: 'en', user_id: 'user-1' }],
      { entitlements: [subscriptionEntitlement(captured)] },
    );
    await handleEvent(db, 'subscription.updated.v2', {
      callback_type: 'renew',
      subscription: { id: 'sub-uuid-1', status: 'active', next_charge_at: '2026-08-19 20:08:51', trial: false },
      product: { product_id: PRODUCT_IDS.trial4, amount: 5900, currency: 'USD' },
      customer: { customer_account_id: 'sess-1', customer_email: 'buyer@example.com' },
      invoices: {
        'inv-1': {
          id: 'inv-1',
          status: 'success',
          amount: 5900,
          subscription_term_number: 1,
          product_price_id: 'price-renewal-usd',
          order_metadata: {
            session_id: 'sess-1',
            product_slug: 'trial4',
            product_code: 'BRAND_000000_SUB',
            funnel_code: 'BRAND',
            funnel_variant: 'main',
            utm_source: 'fb',
            utm_campaign: 'Renewal cohort',
          },
          orders: {
            'sg-renewal-order-1': {
              id: 'sg-renewal-order-1',
              status: 'settle_ok',
              amount: 5900,
              operation: 'recurring',
            },
          },
        },
      },
    });

    expect(updatesTo('orders')[0]).toMatchObject({ status: 'active' });
    const lifecycle = rpcsTo('apply_solidgate_subscription_entitlement_lifecycle')[0];
    expect(lifecycle).toMatchObject({ p_access_level: 'full', p_status: 'active' });
    // Access expires when the next charge is due: stop paying, stop having it.
    expect(lifecycle.p_expires_at).toBe(new Date('2026-08-19T20:08:51Z').toISOString());
    expect(upsertsTo('renewal_events')[0]).toMatchObject({
      solidgate_invoice_id: 'inv-1',
      solidgate_order_id: 'sg-renewal-order-1',
      subscription_term_number: 1,
      amount_cents: 5900,
    });
    expect(upsertsTo('solidgate_invoice_orders')[0]).toMatchObject({
      solidgate_order_id: 'sg-renewal-order-1',
      solidgate_invoice_id: 'inv-1',
      status: 'settle_ok',
      product_price_id: 'price-renewal-usd',
      order_metadata: expect.objectContaining({ utm_source: 'fb' }),
    });
    expect(upsertsTo('solidgate_analytics_outbox')[0]).toMatchObject({
      event_name: 'subscription_renewed',
      properties: {
        provider: 'solidgate',
        payment_provider: 'solidgate',
        billing_type: 'subscription_renewal',
        session_id: 'sess-1',
        user_id: 'user-1',
        product_slug: 'trial4',
        product: 'trial4',
        product_code: 'BRAND_000000_SUB',
        price_id: 'price-renewal-usd',
        solidgate_price_id: 'price-renewal-usd',
        locale: 'en',
        funnel_code: 'BRAND',
        utm_source: 'fb',
        utm_campaign: 'Renewal cohort',
      },
    });
  });

  it.each([
    ['main monthly', 'BRAND_000000_SUB', 'sub-main-fallback', 30],
    ['weekly add-on', 'BRANDADDON_000000_SUB', 'sub-addon-fallback', 7],
  ] as const)('uses a bounded %s expiry when next_charge_at is missing/invalid', async (
    _label,
    productSlug,
    subscriptionId,
    cadenceDays,
  ) => {
    const row = capturedSubscriptionOrder({
      product_name: productSlug,
      product_slug: productSlug,
      status: 'active',
      solidgate_subscription_id: subscriptionId,
    });
    const { db, rpcsTo } = makeDb(
      [row],
      undefined,
      { entitlements: [subscriptionEntitlement(row)] },
    );
    await handleEvent(
      db,
      'subscription.updated.v2',
      {
        callback_type: 'renew',
        subscription: { id: subscriptionId, status: 'active', next_charge_at: 'not-a-date', trial: false },
        product: {
          product_id: productSlug === 'BRAND_000000_SUB'
            ? PRODUCT_IDS.trial4
            : PRODUCT_IDS.addon_trial,
          amount: 5900,
          currency: 'USD',
        },
        invoices: {
          renewal: {
            id: `invoice-${subscriptionId}`,
            status: 'success',
            amount: 5900,
            subscription_term_number: 1,
          },
        },
      },
      {
        eventId: `event-${subscriptionId}`,
        eventCreatedAt: '2026-07-21T08:50:00.000Z',
        environment: 'production',
      },
    );

    const lifecycle = rpcsTo('apply_solidgate_subscription_entitlement_lifecycle')[0];
    expect(lifecycle.p_expires_at).toBe(
      new Date(Date.parse('2026-07-21T08:50:00.000Z') + cadenceDays * 24 * 60 * 60 * 1000)
        .toISOString(),
    );
    expect(lifecycle.p_expires_at).not.toBeNull();
  });

  it('does not count the initial term-0 active invoice as renewal revenue', async () => {
    const captured = {
      ...ORDER_ROW,
      status: 'trialing',
      solidgate_original_amount_cents: 1767,
      solidgate_payment_status: 'settle_ok',
    };
    const { db, updatesTo, upsertsTo } = makeDb(
      [captured],
      [{ id: 'sess-1', email: 'buyer@example.com', locale: 'en', user_id: 'user-1' }],
      {
        entitlements: [{
          order_id: 'order-1',
          payment_environment: 'production',
          user_id: 'user-1',
          product_slug: 'BRAND_000000_SUB',
          solidgate_subscription_id: 'sub-uuid-1',
          status: 'active',
          revoked_at: null,
        }],
      },
    );
    await handleEvent(db, 'subscription.updated.v2', initialSubscriptionPayload(captured, {
      subscriptionId: 'sub-uuid-1',
      subscription: { next_charge_at: '2026-07-23 10:00:00' },
    }));

    expect(updatesTo('orders')[0]).toMatchObject({ status: 'trialing' });
    expect(upsertsTo('renewal_events')).toHaveLength(0);
    expect(upsertsTo('solidgate_invoice_orders')).toHaveLength(1);
  });

  it('retries active-before-card without mutation, then lets the card finalizer create the user and grant', async () => {
    const pending = {
      ...ORDER_ROW,
      user_id: null,
      solidgate_subscription_id: null,
      psp: 'solidgate',
      status: 'pending',
    };
    const activeFirst = makeDb(
      [pending],
      [{ id: 'sess-1', email: 'buyer@example.com', locale: 'en', user_id: null }],
    );
    const activePayload = initialSubscriptionPayload(pending, { subscriptionId: 'sub-raced' });
    await expect(
      handleEvent(activeFirst.db, 'subscription.updated.v2', activePayload),
    ).rejects.toThrow('waiting for card settlement finalization');
    expect(activeFirst.writes.filter((write) =>
      write.table === 'orders'
      || write.table === 'entitlements'
      || write.table === 'solidgate_fulfillment_outbox'
      || write.table === 'solidgate_analytics_outbox'
    )).toHaveLength(0);

    const card = makeDb(
      [pending],
      [{ id: 'sess-1', email: 'buyer@example.com', locale: 'en', user_id: null }],
      {},
      {},
      { authCreate: { userId: 'user-raced' } },
    );
    await handleEvent(card.db, 'card_gate.order.updated', positiveOrderPayload(pending, {
      subscription_id: 'sub-raced',
    }));

    expect(card.updatesTo('orders')).toContainEqual(expect.objectContaining({
      status: 'trialing',
      solidgate_subscription_id: 'sub-raced',
      solidgate_payment_status: 'settle_ok',
    }));
    expect(card.updatesTo('orders')).toContainEqual(expect.objectContaining({ user_id: 'user-raced' }));
    expect(card.rpcsTo('grant_solidgate_main_entitlement')).toContainEqual(expect.objectContaining({
      p_user_id: 'user-raced',
      p_order_id: 'order-1',
      p_subscription_id: 'sub-raced',
    }));
    expect(card.upsertsTo('solidgate_fulfillment_outbox')).toContainEqual([
      expect.objectContaining({ effect_type: 'enrich_main_profile' }),
      expect.objectContaining({ effect_type: 'send_welcome_email' }),
      expect.objectContaining({ effect_type: 'send_meta_capi_purchase' }),
    ]);
  });

  it.each([
    ['cancel', 'cancelled', 'fail', 'auth_failed'],
    ['expire', 'expired', 'fail', 'auth_failed'],
    ['redemption', 'redemption', 'fail', 'auth_failed'],
  ] as const)(
    'keeps subscription-first %s read-only until the exact card settlement and entitlement are durable',
    async (callbackType, subscriptionStatus, invoiceStatus, orderStatus) => {
      const pending = {
        ...ORDER_ROW,
        solidgate_subscription_id: null,
        status: 'pending',
      };
      const attempt = makeDb(
        [pending],
        [{ id: 'sess-1', email: 'buyer@example.com', locale: 'en', user_id: 'user-1' }],
      );
      const payload = initialSubscriptionPayload(pending, {
        callbackType,
        subscriptionId: 'sub-before-card',
        subscription: { status: subscriptionStatus, trial: false },
        invoice: { status: invoiceStatus },
        invoiceOrder: { status: orderStatus },
      });

      await expect(
        handleEvent(attempt.db, 'subscription.updated.v2', payload),
      ).rejects.toThrow('waiting for card settlement finalization');
      expect(attempt.writes.filter((write) =>
        write.table === 'orders'
        || write.table === 'entitlements'
        || write.table === 'solidgate_invoice_orders'
        || write.table === 'renewal_events'
        || write.table === 'solidgate_analytics_outbox'
        || write.table === 'solidgate_fulfillment_outbox'
      )).toHaveLength(0);
    },
  );

  it('returns a retryable 5xx for cancel-before-card without acknowledging a business mutation', async () => {
    const pending = {
      ...ORDER_ROW,
      solidgate_subscription_id: null,
      status: 'pending',
    };
    const attempt = makeDb([pending]);
    const response = await serveRequest(
      await makeWebhookRequest(
        'subscription.updated.v2',
        initialSubscriptionPayload(pending, {
          callbackType: 'cancel',
          subscriptionId: 'sub-cancel-before-card',
          subscription: { status: 'cancelled', trial: false },
          invoice: { status: 'fail' },
          invoiceOrder: { status: 'auth_failed' },
        }),
        'evt-cancel-before-card',
      ),
      attempt.db,
    );

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain('waiting for card settlement finalization');
    expect(attempt.updatesTo('solidgate_webhook_events')).toContainEqual(
      expect.objectContaining({ status: 'failed' }),
    );
    expect(attempt.writes.filter((write) =>
      write.table !== 'solidgate_webhook_events'
    )).toHaveLength(0);
  });

  it.each([
    ['cancel', 'cancelled'],
    ['expire', 'expired'],
    ['redemption', 'redemption'],
  ] as const)(
    'ACKs %s after an exact durable terminal initial-card failure without mutating money or access',
    async (callbackType, subscriptionStatus) => {
      const failedInitial = {
        ...ORDER_ROW,
        status: 'failed',
        amount_cents: 0,
        solidgate_original_amount_cents: ORDER_ROW.amount_cents,
        solidgate_payment_status: 'auth_failed',
        solidgate_subscription_id: null,
      };
      const attempt = makeDb([failedInitial]);
      const response = await serveRequest(
        await makeWebhookRequest(
          'subscription.updated.v2',
          initialSubscriptionPayload(failedInitial, {
            callbackType,
            subscriptionId: 'sub-terminal-card-failure',
            subscription: { status: subscriptionStatus, trial: false },
            invoice: { status: 'fail' },
            invoiceOrder: { status: 'auth_failed' },
          }),
          `evt-terminal-card-failure-${callbackType}`,
        ),
        attempt.db,
      );

      expect(response.status).toBe(200);
      expect(attempt.updatesTo('solidgate_webhook_events')).toContainEqual(
        expect.objectContaining({ status: 'completed' }),
      );
      expect(attempt.writes.filter((write) =>
        write.table === 'orders'
        || write.table === 'entitlements'
        || write.table === 'solidgate_invoice_orders'
        || write.table === 'renewal_events'
        || write.table === 'solidgate_analytics_outbox'
        || write.table === 'solidgate_fulfillment_outbox'
      )).toHaveLength(0);
    },
  );

  it.each([
    ['create', 'pending', 'processing'],
    ['expire', 'expired', 'auth_failed'],
  ] as const)(
    'ACKs metadata-less %s after the exact initial card failure is durable',
    async (callbackType, subscriptionStatus, invoiceOrderStatus) => {
      const failedInitial = {
        ...ORDER_ROW,
        status: 'failed',
        amount_cents: 0,
        solidgate_original_amount_cents: ORDER_ROW.amount_cents,
        solidgate_payment_status: 'auth_failed',
        solidgate_subscription_id: null,
      };
      const payload = initialSubscriptionPayload(failedInitial, {
        callbackType,
        subscriptionId: 'sub-metadata-less-failure',
        subscription: { status: subscriptionStatus, trial: false },
        invoice: { status: callbackType === 'create' ? 'processing' : 'fail' },
        invoiceOrder: { status: invoiceOrderStatus },
      });
      delete (payload.invoices.initial as Row).order_metadata;
      const attempt = makeDb([failedInitial]);

      const response = await serveRequest(
        await makeWebhookRequest(
          'subscription.updated.v2',
          payload,
          `evt-metadata-less-failure-${callbackType}`,
        ),
        attempt.db,
      );

      expect(response.status).toBe(200);
      expect(attempt.updatesTo('solidgate_webhook_events')).toContainEqual(
        expect.objectContaining({ status: 'completed' }),
      );
      expect(attempt.writes.filter((write) =>
        write.table === 'orders'
        || write.table === 'entitlements'
        || write.table === 'solidgate_invoice_orders'
        || write.table === 'renewal_events'
        || write.table === 'solidgate_analytics_outbox'
        || write.table === 'solidgate_fulfillment_outbox'
      )).toHaveLength(0);
    },
  );

  it('keeps a metadata-less initial subscription callback retryable while the card result is pending', async () => {
    const pending = {
      ...ORDER_ROW,
      status: 'pending',
      solidgate_subscription_id: null,
    };
    const payload = initialSubscriptionPayload(pending, {
      callbackType: 'create',
      subscriptionId: 'sub-metadata-less-pending',
      subscription: { status: 'pending', trial: false },
      invoice: { status: 'processing' },
      invoiceOrder: { status: 'processing' },
    });
    delete (payload.invoices.initial as Row).order_metadata;
    const attempt = makeDb([pending]);

    const response = await serveRequest(
      await makeWebhookRequest(
        'subscription.updated.v2',
        payload,
        'evt-metadata-less-pending',
      ),
      attempt.db,
    );

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain(
      'initial subscription callback metadata is missing',
    );
    expect(attempt.updatesTo('solidgate_webhook_events')).toContainEqual(
      expect.objectContaining({ status: 'failed' }),
    );
    expect(attempt.writes.filter((write) =>
      write.table !== 'solidgate_webhook_events'
    )).toHaveLength(0);
  });

  it('still retries a claimed card failure that lacks the durable original-amount proof', async () => {
    const incompleteFailure = {
      ...ORDER_ROW,
      status: 'failed',
      amount_cents: 0,
      solidgate_original_amount_cents: null,
      solidgate_payment_status: 'auth_failed',
      solidgate_subscription_id: null,
    };
    const attempt = makeDb([incompleteFailure]);

    await expect(handleEvent(attempt.db, 'subscription.updated.v2',
      initialSubscriptionPayload(incompleteFailure, {
        callbackType: 'cancel',
        subscriptionId: 'sub-incomplete-card-failure',
        subscription: { status: 'cancelled', trial: false },
        invoice: { status: 'fail' },
        invoiceOrder: { status: 'auth_failed' },
      }))).rejects.toThrow('waiting for card settlement finalization');
    expect(attempt.writes.filter((write) =>
      write.table === 'orders' || write.table === 'entitlements'
    )).toHaveLength(0);
  });

  it.each([
    ['cancel', 'cancelled', 'canceled'],
    ['redemption', 'redemption', 'past_due'],
  ] as const)(
    'applies a retried pre-card %s monotonically after the exact card winner becomes durable',
    async (callbackType, subscriptionStatus, expectedOrderStatus) => {
      const pending = {
        ...ORDER_ROW,
        solidgate_subscription_id: null,
        status: 'pending',
      };
      const payload = initialSubscriptionPayload(pending, {
        callbackType,
        subscriptionId: 'sub-redelivered',
        subscription: { status: subscriptionStatus, trial: false },
        invoice: { status: 'fail' },
        invoiceOrder: { status: 'auth_failed' },
      });
      if (callbackType === 'redemption') {
        // Keep term zero solely as the immutable initial-order binding. The
        // actionable dunning belongs to term one; a failed callback for the
        // already captured term-zero invoice is correctly dominated by that
        // exact durable success.
        Object.assign(payload.invoices, {
          dunning: {
            id: 'inv-redelivered-dunning',
            status: 'fail',
            amount: 5900,
            subscription_term_number: 1,
            order_metadata: { ...pending.tracking_metadata },
            orders: {
              retry: {
                id: 'order-redelivered-dunning',
                status: 'auth_failed',
                amount: 5900,
              },
            },
          },
        });
      }
      const beforeCard = makeDb([pending]);
      await expect(
        handleEvent(beforeCard.db, 'subscription.updated.v2', payload),
      ).rejects.toThrow('waiting for card settlement finalization');

      const captured = capturedSubscriptionOrder({
        solidgate_subscription_id: 'sub-redelivered',
      });
      const redelivery = makeDb(
        [captured],
        undefined,
        { entitlements: [subscriptionEntitlement(captured)] },
      );
      await expect(
        handleEvent(redelivery.db, 'subscription.updated.v2', payload),
      ).resolves.toBeUndefined();

      expect(redelivery.updatesTo('orders')).toContainEqual(
        expect.objectContaining({ status: expectedOrderStatus }),
      );
      if (callbackType === 'cancel') {
        expect(redelivery.updatesTo('entitlements')).toContainEqual(
          expect.objectContaining({ status: 'canceled' }),
        );
      } else {
        expect(redelivery.rpcsTo('apply_solidgate_subscription_entitlement_lifecycle')).toContainEqual(
          expect.objectContaining({ p_status: 'past_due' }),
        );
      }
    },
  );

  it('accepts the exact card finalizer that wins while a cancellation is resolving', async () => {
    const pending = {
      ...ORDER_ROW,
      solidgate_subscription_id: null,
      status: 'pending',
    };
    const durableWinner = capturedSubscriptionOrder({
      solidgate_subscription_id: 'sub-concurrent-winner',
    });
    const attempt = makeDb(
      [pending],
      undefined,
      { entitlements: [subscriptionEntitlement(durableWinner)] },
      {},
      {
        readRaceWinner: {
          orders: {
            onMaybeSingle: 2,
            patch: {
              status: durableWinner.status,
              user_id: durableWinner.user_id,
              solidgate_subscription_id: durableWinner.solidgate_subscription_id,
              solidgate_original_amount_cents: durableWinner.solidgate_original_amount_cents,
              solidgate_payment_status: durableWinner.solidgate_payment_status,
            },
          },
        },
      },
    );

    await expect(handleEvent(
      attempt.db,
      'subscription.updated.v2',
      initialSubscriptionPayload(pending, {
        callbackType: 'cancel',
        subscriptionId: 'sub-concurrent-winner',
        subscription: { status: 'cancelled', trial: false },
        invoice: { status: 'fail' },
        invoiceOrder: { status: 'auth_failed' },
      }),
    )).resolves.toBeUndefined();

    expect(attempt.updatesTo('orders')).toContainEqual(
      expect.objectContaining({ status: 'canceled' }),
    );
    expect(attempt.updatesTo('orders')).not.toContainEqual(
      expect.objectContaining({ solidgate_subscription_id: 'sub-concurrent-winner' }),
    );
    expect(attempt.updatesTo('entitlements')).toContainEqual(
      expect.objectContaining({ status: 'canceled' }),
    );
  });

  it('keeps an expired pre-card subscription read-only and never cross-links a newer retry order', async () => {
    // Regression (2026-07-17, found live via 3DS-after-decline): a declined
    // attempt's dead subscription used to re-bind to the RETRY's fresh order
    // via the newest-order-for-session fallback, then its 'expire' canceled the
    // paid order — buyer settled but got no entitlement and no refund.
    const deadAttempt = {
      ...ORDER_ROW,
      id: 'order-dead',
      solidgate_order_id: 'sess-1:trial4:1',
      solidgate_subscription_id: null,
      psp: 'solidgate',
      status: 'failed',
      created_at: '2026-07-16T08:50:00.000Z',
    };
    const liveRetry = {
      ...ORDER_ROW,
      id: 'order-live',
      solidgate_order_id: 'sess-1:trial4:2',
      solidgate_subscription_id: null,
      psp: 'solidgate',
      status: 'trialing',
      created_at: '2026-07-16T09:00:00.000Z', // newer — the old fallback would pick this for BOTH subs
    };
    const { db, writes } = makeDb(
      [deadAttempt, liveRetry],
      [{ id: 'sess-1', email: 'buyer@example.com', locale: 'en', user_id: 'user-1' }],
    );

    // The DEAD subscription's expire event names the FAILED order in its
    // invoice. It is exact enough to identify our attempt, but not capture
    // evidence, so it must request redelivery without binding or canceling
    // either local order.
    await expect(handleEvent(
      db,
      'subscription.updated.v2',
      initialSubscriptionPayload(deadAttempt, {
        callbackType: 'expire',
        subscriptionId: 'sub-dead',
        subscription: { status: 'expired', trial: false },
        invoice: { id: 'inv-dead', status: 'fail' },
        invoiceOrder: { status: 'auth_failed' },
      }),
    )).rejects.toThrow('waiting for card settlement finalization');

    expect(writes.filter((write) =>
      write.table === 'orders'
      || write.table === 'entitlements'
      || write.table === 'solidgate_invoice_orders'
      || write.table === 'solidgate_analytics_outbox'
    )).toHaveLength(0);

    // The card finalizer owns the REAL binding. Its active callback then grants
    // only that exact captured retry and never touches the dead attempt.
    const capturedLiveRetry = {
      ...liveRetry,
      solidgate_subscription_id: 'sub-live',
      solidgate_original_amount_cents: 1767,
      solidgate_payment_status: 'settle_ok',
    };
    const { db: db2, updatesTo: updatesTo2, rpcsTo: rpcsTo2 } = makeDb(
      [deadAttempt, capturedLiveRetry],
      [{ id: 'sess-1', email: 'buyer@example.com', locale: 'en', user_id: 'user-1' }],
      {
        entitlements: [{
          order_id: 'order-live',
          payment_environment: 'production',
          user_id: 'user-1',
          product_slug: 'BRAND_000000_SUB',
          solidgate_subscription_id: 'sub-live',
          status: 'active',
          revoked_at: null,
        }],
      },
    );
    await handleEvent(db2, 'subscription.updated.v2', initialSubscriptionPayload(capturedLiveRetry, {
      subscriptionId: 'sub-live',
      invoice: { id: 'inv-live' },
    }));
    expect(updatesTo2('orders')).not.toContainEqual(
      expect.objectContaining({ solidgate_subscription_id: 'sub-live' }),
    );
    // The real subscription grants an ACTIVE trial entitlement atomically —
    // the whole point of the fix: before it, this buyer got no entitlement.
    expect(rpcsTo2('apply_solidgate_subscription_entitlement_lifecycle')[0]).toMatchObject({
      p_order_db_id: 'order-live',
      p_access_level: 'trial',
      p_status: 'active',
      p_solidgate_subscription_id: 'sub-live',
    });
  });

  it.each(['active', 'cancel'] as const)(
    'ACKs a late S1 %s lifecycle after the canonical entitlement moved to newer S2',
    async (callbackType) => {
      const older = capturedSubscriptionOrder({
        id: 'order-s1',
        solidgate_order_id: 'sess-1:trial4:1',
        solidgate_subscription_id: 'sub-s1',
        created_at: '2026-07-16T08:50:00.000Z',
      });
      const newer = capturedSubscriptionOrder({
        id: 'order-s2',
        solidgate_order_id: 'sess-1:trial4:2',
        solidgate_subscription_id: 'sub-s2',
        created_at: '2026-07-16T09:00:00.000Z',
      });
      const attempt = makeDb(
        [older, newer],
        undefined,
        { entitlements: [subscriptionEntitlement(newer)] },
      );
      const payload = initialSubscriptionPayload(older, {
        callbackType,
        subscriptionId: 'sub-s1',
        subscription: {
          status: callbackType === 'cancel' ? 'cancelled' : 'active',
          trial: false,
        },
      });

      await expect(handleEvent(
        attempt.db,
        'subscription.updated.v2',
        payload,
      )).resolves.toBeUndefined();

      expect(attempt.writes.filter((write) =>
        write.table === 'orders'
        || write.table === 'entitlements'
        || write.table === 'renewal_events'
        || write.table === 'solidgate_invoice_orders'
        || write.table === 'solidgate_analytics_outbox'
      )).toHaveLength(0);
      expect(attempt.rpcsTo('apply_solidgate_subscription_entitlement_lifecycle')).toHaveLength(0);
    },
  );

  it('keeps an unexplained older entitlement owner retryable', async () => {
    const current = capturedSubscriptionOrder({
      id: 'order-current',
      solidgate_order_id: 'sess-1:trial4:2',
      solidgate_subscription_id: 'sub-current',
      created_at: '2026-07-16T09:00:00.000Z',
    });
    const unexplainedOlderOwner = capturedSubscriptionOrder({
      id: 'order-unexplained-older',
      solidgate_order_id: 'sess-1:trial4:1',
      solidgate_subscription_id: 'sub-unexplained-older',
      created_at: '2026-07-16T08:50:00.000Z',
    });
    const attempt = makeDb(
      [current, unexplainedOlderOwner],
      undefined,
      { entitlements: [subscriptionEntitlement(unexplainedOlderOwner)] },
    );

    await expect(handleEvent(
      attempt.db,
      'subscription.updated.v2',
      initialSubscriptionPayload(current, {
        callbackType: 'active',
        subscriptionId: 'sub-current',
      }),
    )).rejects.toThrow('entitlement has an unexplained owner');
    expect(attempt.writes.filter((write) =>
      write.table === 'orders'
      || write.table === 'entitlements'
      || write.table === 'renewal_events'
      || write.table === 'solidgate_invoice_orders'
    )).toHaveLength(0);
    expect(attempt.rpcsTo('apply_solidgate_subscription_entitlement_lifecycle')).toHaveLength(0);
  });

  it('binds a PWA u-<user UUID> account only through its exact term-0 order id', async () => {
    const userId = '123e4567-e89b-42d3-a456-426614174000';
    const pending = {
      ...ORDER_ROW,
      session_id: null,
      user_id: userId,
      product_name: 'BRANDADDON_000000_SUB',
      product_slug: 'BRANDADDON_000000_SUB',
      amount_cents: 5900,
      solidgate_order_id: `u-${userId}:oto2_addon_weekly:1`,
      solidgate_subscription_id: null,
      psp: 'solidgate',
      payment_environment: 'production',
      status: 'pending',
      tracking_metadata: {
        funnel_code: 'PWA',
        funnel_variant: 'member_area',
        session_id: `u-${userId}`,
        product_slug: 'oto2_addon_weekly',
        price_id: 'c7099f1a-f012-4cef-b2f4-d78a7b686742',
      },
    };
    const { db, updatesTo } = makeDb([pending]);
    await handleEvent(db, 'subscription.updated.v2', initialSubscriptionPayload(pending, {
      callbackType: 'create',
      subscriptionId: 'sub-pwa-raced',
      invoice: { id: 'inv-pwa', status: 'processing' },
      invoiceOrder: { status: 'created' },
    }));

    expect(updatesTo('orders')).toContainEqual(expect.objectContaining({
      solidgate_subscription_id: 'sub-pwa-raced',
    }));
  });

  it('never falls back to the newest session order when the provider order id is absent or misses', async () => {
    const pending = {
      ...ORDER_ROW,
      solidgate_subscription_id: null,
      psp: 'solidgate',
      status: 'pending',
    };
    const newerAttempt = {
      ...pending,
      id: 'newer-order',
      solidgate_order_id: 'sess-1:trial4:2',
      created_at: '2026-07-16T09:00:00.000Z',
    };
    const { db, writes } = makeDb(
      [newerAttempt, pending],
      [{ id: 'sess-1', email: 'buyer@example.com', locale: 'en', user_id: 'user-1' }],
    );
    const payload = initialSubscriptionPayload(pending, {
      callbackType: 'redemption',
      subscriptionId: 'sub-raced',
      subscription: { status: 'redemption', trial: false },
      invoice: {
        orders: {
          missing: {
            id: 'sess-1:trial4:999',
            status: 'auth_failed',
            amount: 1767,
          },
        },
      },
    });
    await expect(handleEvent(db, 'subscription.updated.v2', payload)).rejects.toThrow(
      'exact term-0 order is not ready',
    );
    expect(writes.filter((write) =>
      write.table === 'orders'
      || write.table === 'entitlements'
      || write.table === 'solidgate_fulfillment_outbox'
      || write.table === 'solidgate_analytics_outbox'
    )).toHaveLength(0);
  });

  it('rejects an owned unbound subscription when term-0 contains no provider order id', async () => {
    const pending = { ...ORDER_ROW, solidgate_subscription_id: null };
    const attempt = makeDb([pending]);
    const payload = initialSubscriptionPayload(pending, {
      callbackType: 'create',
      subscriptionId: 'sub-no-order-id',
      invoice: { status: 'processing', orders: {} },
    });

    await expect(handleEvent(attempt.db, 'subscription.updated.v2', payload)).rejects.toThrow(
      'has no exact term-0 order binding',
    );
    expect(attempt.writes.filter((write) =>
      write.table === 'orders'
      || write.table === 'entitlements'
      || write.table === 'solidgate_invoice_orders'
      || write.table === 'solidgate_fulfillment_outbox'
      || write.table === 'solidgate_analytics_outbox'
    )).toHaveLength(0);
  });

  // Renewal/dunning callbacks for subscriptions whose initial order lives
  // outside this database (a pre-cutover cohort on the same Solidgate merchant)
  // carry no term-0 invoice at all, so no redelivery can ever bind them.
  // Retrying forever buried the failures that can still heal — ACK instead.
  it('acknowledges an unbindable subscription whose callback carries no term-0 invoice', async () => {
    const attempt = makeDb([]);
    const payload = {
      callback_type: 'order_update',
      subscription: {
        id: 'sub-foreign-renewal',
        status: 'active',
        started_at: '2026-07-24 11:10:16',
      },
      product: { product_id: PRODUCT_IDS.trial1, amount: 5900, currency: 'USD' },
      customer: { customer_account_id: '2434b61c-b898-4182-802a-462cbb3cd60f' },
      invoices: {
        renewal: {
          id: 'inv-term-1',
          status: 'success',
          amount: 5900,
          subscription_term_number: 1,
          orders: { renewal: { id: 'foreign-renewal-order', status: 'settle_ok', amount: 5900 } },
        },
      },
    };

    await expect(handleEvent(attempt.db, 'subscription.updated.v2', payload)).resolves.toBeUndefined();
    expect(attempt.writes.filter((write) =>
      write.table === 'orders'
      || write.table === 'entitlements'
      || write.table === 'renewal_events'
      || write.table === 'solidgate_invoice_orders'
      || write.table === 'solidgate_fulfillment_outbox'
      || write.table === 'solidgate_analytics_outbox'
    )).toHaveLength(0);
  });

  it('still rejects a term-0-less callback when a local session anchors it', async () => {
    const pending = { ...ORDER_ROW, solidgate_subscription_id: null };
    const attempt = makeDb([pending]);
    const payload = {
      callback_type: 'order_update',
      subscription: { id: 'sub-anchored-renewal', status: 'active' },
      product: { product_id: PRODUCT_IDS.trial1, amount: 5900, currency: 'USD' },
      // A session we own — a local order should exist, so a callback with no
      // term-0 invoice is contract drift, not a foreign subscription.
      customer: { customer_account_id: pending.session_id },
      invoices: {
        renewal: {
          id: 'inv-term-1',
          status: 'success',
          amount: 5900,
          subscription_term_number: 1,
          orders: { renewal: { id: 'anchored-renewal-order', status: 'settle_ok', amount: 5900 } },
        },
      },
    };

    await expect(handleEvent(attempt.db, 'subscription.updated.v2', payload)).rejects.toThrow(
      'has no exact term-0 order binding',
    );
  });

  it('still retries when a term-0 invoice is present but its order row has not landed', async () => {
    const pending = { ...ORDER_ROW, solidgate_subscription_id: null };
    const attempt = makeDb([]);
    const payload = initialSubscriptionPayload(pending, {
      callbackType: 'create',
      subscriptionId: 'sub-term0-not-ready',
    });

    await expect(handleEvent(attempt.db, 'subscription.updated.v2', payload)).rejects.toThrow(
      'exact term-0 order is not ready',
    );
  });

  it('accepts a lost binding CAS only when the reread has the exact same subscription', async () => {
    const pending = { ...ORDER_ROW, solidgate_subscription_id: null };
    const exactWinner = makeDb(
      [pending],
      undefined,
      {},
      {},
      {
        emptyUpdateSelect: { orders: true },
        updateRaceWinner: { orders: { solidgate_subscription_id: 'sub-race' } },
      },
    );
    await expect(handleEvent(
      exactWinner.db,
      'subscription.updated.v2',
      initialSubscriptionPayload(pending, {
        callbackType: 'create',
        subscriptionId: 'sub-race',
        invoice: { status: 'processing' },
        invoiceOrder: { status: 'created' },
      }),
    )).resolves.toBeUndefined();

    const wrongPending = { ...ORDER_ROW, solidgate_subscription_id: null };
    const wrongWinner = makeDb(
      [wrongPending],
      undefined,
      {},
      {},
      {
        emptyUpdateSelect: { orders: true },
        updateRaceWinner: { orders: { solidgate_subscription_id: 'sub-other' } },
      },
    );
    await expect(handleEvent(
      wrongWinner.db,
      'subscription.updated.v2',
      initialSubscriptionPayload(wrongPending, {
        callbackType: 'create',
        subscriptionId: 'sub-race',
        invoice: { status: 'processing' },
        invoiceOrder: { status: 'created' },
      }),
    )).rejects.toThrow('lost without an exact durable winner');
    expect(wrongWinner.upsertsTo('entitlements')).toHaveLength(0);
    expect(wrongWinner.upsertsTo('solidgate_fulfillment_outbox')).toHaveLength(0);
    expect(wrongWinner.upsertsTo('solidgate_analytics_outbox')).toHaveLength(0);
  });

  it.each([
    ['customer account', { customer: { customer_account_id: 'other-session' } }],
    ['customer email', { customer: { customer_email: 'attacker@example.com' } }],
    ['catalog product', { product: { product_id: PRODUCT_IDS.trial1 } }],
    ['currency', { product: { currency: 'EUR' } }],
    ['invoice amount', { invoice: { amount: 999 } }],
    ['invoice order amount', { invoiceOrder: { amount: 999 } }],
    ['catalog price', { invoice: { product_price_id: '11111111-1111-4111-8111-111111111111' } }],
    ['trusted metadata', { metadata: { ...(ORDER_ROW.tracking_metadata as Record<string, string>), funnel_variant: 'attacker' } }],
    ['initial term', { invoice: { subscription_term_number: 1 } }],
  ] as const)('rejects initial subscription %s mismatch before business mutation', async (_label, override) => {
    const pending = { ...ORDER_ROW, solidgate_subscription_id: null };
    const attempt = makeDb([pending]);
    const mutation = override as InitialSubscriptionPayloadOptions;
    const payload = initialSubscriptionPayload(pending, {
      callbackType: 'create',
      subscriptionId: 'sub-mismatch',
      invoice: { status: 'processing', ...(mutation.invoice ?? {}) },
      invoiceOrder: { status: 'created', ...(mutation.invoiceOrder ?? {}) },
      ...(mutation.customer && { customer: mutation.customer }),
      ...(mutation.product && { product: mutation.product }),
      ...(mutation.metadata && { metadata: mutation.metadata }),
    });

    await expect(handleEvent(attempt.db, 'subscription.updated.v2', payload)).rejects.toThrow();
    expect(attempt.writes.filter((write) =>
      write.table === 'orders'
      || write.table === 'entitlements'
      || write.table === 'solidgate_invoice_orders'
      || write.table === 'solidgate_fulfillment_outbox'
      || write.table === 'solidgate_analytics_outbox'
    )).toHaveLength(0);
  });

  it('KEEPS access during dunning (redemption) — Solidgate is still retrying', async () => {
    const captured = capturedSubscriptionOrder();
    const { db, updatesTo, rpcsTo } = makeDb(
      [captured],
      [{ id: 'sess-1', email: 'b@e.com', locale: 'en', user_id: 'user-1' }],
      { entitlements: [subscriptionEntitlement(captured)] },
    );
    await handleEvent(db, 'subscription.updated.v2', {
      callback_type: 'redemption',
      subscription: { id: 'sub-uuid-1', status: 'redemption', trial: false },
      product: {},
      customer: {},
    });

    expect(updatesTo('orders')[0]).toMatchObject({ status: 'past_due' });
    expect(rpcsTo('apply_solidgate_subscription_entitlement_lifecycle')[0]).toMatchObject({
      p_access_level: 'grace',
      p_status: 'past_due',
    });
  });

  it('does not resurrect a canceled subscription from a same-time late dunning callback', async () => {
    const timestamp = '2026-07-21T09:15:00.000Z';
    const captured = capturedSubscriptionOrder();
    const canceled = makeDb(
      [captured],
      [{ id: 'sess-1', email: 'buyer@example.com', locale: 'en', user_id: 'user-1' }],
      { entitlements: [subscriptionEntitlement(captured)] },
    );
    await handleEvent(
      canceled.db,
      'subscription.updated.v2',
      {
        callback_type: 'cancel',
        subscription: { id: 'sub-uuid-1', status: 'cancelled', trial: false },
      },
      { eventId: 'cancel-first', eventCreatedAt: timestamp, environment: 'production' },
    );
    expect(canceled.updatesTo('orders')).toContainEqual(expect.objectContaining({ status: 'canceled' }));
    expect(canceled.updatesTo('entitlements')).toContainEqual(expect.objectContaining({ status: 'canceled' }));

    const canceledRow = capturedSubscriptionOrder({ status: 'canceled' });
    const lateDunning = makeDb(
      [canceledRow],
      [{ id: 'sess-1', email: 'buyer@example.com', locale: 'en', user_id: 'user-1' }],
      {
        entitlements: [subscriptionEntitlement(canceledRow, {
          status: 'canceled',
          revoked_at: timestamp,
        })],
      },
    );
    await handleEvent(
      lateDunning.db,
      'subscription.updated.v2',
      {
        callback_type: 'redemption',
        subscription: { id: 'sub-uuid-1', status: 'redemption', trial: false },
      },
      { eventId: 'dunning-late', eventCreatedAt: timestamp, environment: 'production' },
    );
    expect(lateDunning.updatesTo('orders')).toHaveLength(0);
    expect(lateDunning.upsertsTo('entitlements')).toHaveLength(0);
    expect(lateDunning.upsertsTo('solidgate_analytics_outbox')).toHaveLength(0);
  });

  it('lets a same-time terminal callback monotonically win after dunning', async () => {
    const timestamp = '2026-07-21T09:15:00.000Z';
    const pastDue = capturedSubscriptionOrder({ status: 'past_due' });
    const terminal = makeDb(
      [pastDue],
      undefined,
      { entitlements: [subscriptionEntitlement(pastDue, { status: 'past_due' })] },
    );

    await handleEvent(
      terminal.db,
      'subscription.updated.v2',
      {
        callback_type: 'cancel',
        subscription: { id: 'sub-uuid-1', status: 'cancelled', trial: false },
      },
      { eventId: 'cancel-equal-time-late', eventCreatedAt: timestamp, environment: 'production' },
    );

    expect(terminal.updatesTo('orders')).toContainEqual(
      expect.objectContaining({ status: 'canceled' }),
    );
    expect(terminal.updatesTo('entitlements')).toContainEqual(
      expect.objectContaining({ status: 'canceled' }),
    );
  });

  it('gives an exact paid invoice/term deterministic precedence over equal-time dunning in either arrival order', async () => {
    const timestamp = '2026-07-21T09:30:00.000Z';
    const active = capturedSubscriptionOrder();
    const invoiceId = 'inv-equal-time-renewal';
    const successPayload = initialSubscriptionPayload(active, {
      callbackType: 'renew',
      subscription: { status: 'active', trial: false },
      invoice: {
        id: invoiceId,
        status: 'success',
        amount: 5900,
        subscription_term_number: 1,
        created_at: timestamp,
        orders: {
          renewal: {
            id: 'renewal-order-equal-time',
            status: 'settle_ok',
            amount: 5900,
          },
        },
      },
    });
    const dunningPayload = initialSubscriptionPayload(active, {
      callbackType: 'redemption',
      subscription: { status: 'redemption', trial: false },
      invoice: {
        id: invoiceId,
        status: 'fail',
        amount: 5900,
        subscription_term_number: 1,
        created_at: timestamp,
        orders: {
          renewal: {
            id: 'renewal-order-equal-time',
            status: 'auth_failed',
            amount: 5900,
          },
        },
      },
    });

    // Success first: its durable invoice marker makes a lexically earlier,
    // equal-time dunning event a no-op.
    const successFirst = makeDb(
      [active],
      undefined,
      { entitlements: [subscriptionEntitlement(active)] },
    );
    await handleEvent(
      successFirst.db,
      'subscription.updated.v2',
      successPayload,
      { eventId: 'zzz-success-first', eventCreatedAt: timestamp, environment: 'production' },
    );
    const paidMarker = successFirst.upsertsTo('renewal_events')[0];
    expect(paidMarker).toMatchObject({
      solidgate_invoice_id: invoiceId,
      solidgate_subscription_id: 'sub-uuid-1',
      subscription_term_number: 1,
      status: 'paid',
    });

    const dunningAfterSuccess = makeDb(
      [active],
      undefined,
      {
        entitlements: [subscriptionEntitlement(active)],
        renewal_events: [paidMarker],
      },
    );
    await handleEvent(
      dunningAfterSuccess.db,
      'subscription.updated.v2',
      dunningPayload,
      { eventId: 'aaa-dunning-late', eventCreatedAt: timestamp, environment: 'production' },
    );
    expect(dunningAfterSuccess.updatesTo('orders')).toHaveLength(0);
    expect(dunningAfterSuccess.updatesTo('entitlements')).toHaveLength(0);
    expect(dunningAfterSuccess.upsertsTo('entitlements')).toHaveLength(0);
    expect(dunningAfterSuccess.upsertsTo('solidgate_analytics_outbox')).toHaveLength(0);

    // Dunning first: it may enter past_due, but the equal-time paid callback
    // deterministically restores the order and exact entitlement.
    const dunningFirst = makeDb(
      [active],
      undefined,
      { entitlements: [subscriptionEntitlement(active)] },
    );
    await handleEvent(
      dunningFirst.db,
      'subscription.updated.v2',
      dunningPayload,
      { eventId: 'zzz-dunning-first', eventCreatedAt: timestamp, environment: 'production' },
    );
    expect(dunningFirst.updatesTo('orders')).toContainEqual(
      expect.objectContaining({ status: 'past_due' }),
    );

    const pastDue = capturedSubscriptionOrder({ status: 'past_due' });
    const successAfterDunning = makeDb(
      [pastDue],
      undefined,
      {
        entitlements: [subscriptionEntitlement(pastDue, {
          status: 'past_due',
          access_level: 'grace',
        })],
      },
    );
    await handleEvent(
      successAfterDunning.db,
      'subscription.updated.v2',
      successPayload,
      { eventId: 'aaa-success-late', eventCreatedAt: timestamp, environment: 'production' },
    );
    expect(successAfterDunning.updatesTo('orders')).toContainEqual(
      expect.objectContaining({ status: 'active' }),
    );
    expect(successAfterDunning.rpcsTo('apply_solidgate_subscription_entitlement_lifecycle')).toContainEqual(
      expect.objectContaining({ p_status: 'active', p_access_level: 'full' }),
    );
  });

  it.each([
    ['cancel', 'canceled', 'canceled'],
    ['redemption', 'past_due', 'past_due'],
  ] as const)(
    'ACKs an already-applied %s replay without extending or rewriting lifecycle state',
    async (callbackType, orderStatus, entitlementStatus) => {
      const durable = capturedSubscriptionOrder({ status: orderStatus });
      const attempt = makeDb(
        [durable],
        undefined,
        {
          entitlements: [subscriptionEntitlement(durable, {
            status: entitlementStatus,
            revoked_at: entitlementStatus === 'canceled'
              ? '2026-07-21T09:15:00.000Z'
              : null,
          })],
        },
      );

      await expect(handleEvent(attempt.db, 'subscription.updated.v2', {
        callback_type: callbackType,
        subscription: {
          id: 'sub-uuid-1',
          status: callbackType === 'cancel' ? 'cancelled' : 'redemption',
          trial: false,
        },
      })).resolves.toBeUndefined();

      expect(attempt.updatesTo('orders')).toHaveLength(0);
      expect(attempt.updatesTo('entitlements')).toHaveLength(0);
      expect(attempt.upsertsTo('entitlements')).toHaveLength(0);
      expect(attempt.upsertsTo('solidgate_analytics_outbox')).toContainEqual(
        expect.objectContaining({
          event_name: callbackType === 'cancel'
            ? 'subscription_cancelled'
            : 'subscription_payment_failed',
        }),
      );
    },
  );

  it('does not restore access when a restore callback carries a failed invoice', async () => {
    const pastDue = capturedSubscriptionOrder({ status: 'past_due' });
    const { db, updatesTo, upsertsTo } = makeDb(
      [pastDue],
      [{ id: 'sess-1', email: 'b@e.com', locale: 'en', user_id: 'user-1' }],
      { entitlements: [subscriptionEntitlement(pastDue, { status: 'past_due' })] },
    );
    await handleEvent(db, 'subscription.updated.v2', {
      callback_type: 'restore',
      subscription: { id: 'sub-uuid-1', status: 'active', trial: false },
      product: { currency: 'USD' },
      invoices: {
        failed: {
          id: 'inv-failed-restore',
          status: 'fail',
          amount: 5900,
          subscription_term_number: 1,
        },
      },
    });

    expect(updatesTo('orders')).toHaveLength(0);
    expect(upsertsTo('entitlements')).toHaveLength(0);
    expect(upsertsTo('renewal_events')).toHaveLength(0);
  });

  it('cuts addon access on dunning without writing a terminal revocation tombstone', async () => {
    const addon = capturedSubscriptionOrder({
      product_name: 'BRANDADDON_000000_SUB',
      product_slug: 'BRANDADDON_000000_SUB',
      solidgate_subscription_id: 'sub-adv',
    });
    const { db, updatesTo, rpcsTo } = makeDb(
      [addon],
      [{ id: 'sess-1', email: 'b@e.com', locale: 'en', user_id: 'user-1' }],
      { entitlements: [subscriptionEntitlement(addon)] },
    );
    await handleEvent(db, 'subscription.updated.v2', {
      callback_type: 'redemption',
      subscription: { id: 'sub-adv', status: 'redemption', trial: false },
      product: {},
      customer: {},
    });
    expect(updatesTo('orders')).toContainEqual(expect.objectContaining({ status: 'past_due' }));
    expect(rpcsTo('apply_solidgate_subscription_entitlement_lifecycle')).toContainEqual(expect.objectContaining({
      p_status: 'past_due',
      p_access_level: 'full',
    }));
    expect(updatesTo('entitlements')).toHaveLength(0);
  });

  it.each(['restore', 'renew', 'recurring'] as const)(
    'reactivates addon after a later exact paid %s callback',
    async (callbackType) => {
      const addon = capturedSubscriptionOrder({
        status: 'past_due',
        product_name: 'BRANDADDON_000000_SUB',
        product_slug: 'BRANDADDON_000000_SUB',
        solidgate_subscription_id: 'sub-adv-recoverable',
      });
      const attempt = makeDb(
        [addon],
        [{ id: 'sess-1', email: 'b@e.com', locale: 'en', user_id: 'user-1' }],
        {
          entitlements: [subscriptionEntitlement(addon, {
            status: 'past_due',
            access_level: 'full',
            revoked_at: null,
          })],
        },
      );
      const payload = initialSubscriptionPayload(addon, {
        callbackType,
        subscriptionId: 'sub-adv-recoverable',
        subscription: { status: 'active', trial: false },
        invoice: {
          id: `inv-adv-recoverable-${callbackType}`,
          status: 'success',
          amount: 4900,
          subscription_term_number: 1,
          orders: {
            renewal: {
              id: `order-adv-recoverable-${callbackType}`,
              status: 'settle_ok',
              amount: 4900,
            },
          },
        },
      });

      await handleEvent(attempt.db, 'subscription.updated.v2', payload);

      expect(attempt.updatesTo('orders')).toContainEqual(
        expect.objectContaining({ status: 'active' }),
      );
      expect(attempt.rpcsTo('apply_solidgate_subscription_entitlement_lifecycle')).toContainEqual(expect.objectContaining({
        p_order_db_id: addon.id,
        p_solidgate_subscription_id: 'sub-adv-recoverable',
        p_status: 'active',
        p_access_level: 'full',
      }));
    },
  );

  it('revokes on cancel and on expire', async () => {
    for (const callbackType of ['cancel', 'expire']) {
      const captured = capturedSubscriptionOrder();
      const { db, updatesTo } = makeDb(
        [captured],
        [{ id: 'sess-1', email: 'b@e.com', locale: 'en', user_id: 'user-1' }],
        { entitlements: [subscriptionEntitlement(captured)] },
      );
      await handleEvent(db, 'subscription.updated.v2', {
        callback_type: callbackType,
        subscription: { id: 'sub-uuid-1', status: 'cancelled', trial: false },
        product: {},
        customer: {},
      });
      expect(updatesTo('orders')[0], callbackType).toMatchObject({ status: 'canceled' });
      expect(updatesTo('entitlements')[0], callbackType).toMatchObject({ status: 'canceled' });
    }
  });

  it('ignores a subscription belonging to another brand', async () => {
    const { db, writes } = makeDb([{ ...ORDER_ROW, product_slug: 'EN_OTHERBRAND_000000_SUB' }]);
    await handleEvent(db, 'subscription.updated.v2', {
      callback_type: 'cancel',
      subscription: { id: 'sub-uuid-1', status: 'cancelled', trial: false },
      product: {},
      customer: {},
    });
    expect(writes.filter((w) => w.op === 'update' || w.op === 'upsert')).toHaveLength(0);
  });

  it('drops a stale subscription event before it can reopen cancelled access', async () => {
    const { db, writes, rpcCalls } = makeDb(
      [{ ...ORDER_ROW, status: 'canceled' }],
      [{ id: 'sess-1', email: 'b@e.com', locale: 'en', user_id: 'user-1' }],
      {},
      { claim_solidgate_entity_event: 'stale' },
    );
    await handleEvent(
      db,
      'subscription.updated.v2',
      {
        callback_type: 'active',
        subscription: { id: 'sub-uuid-1', status: 'active', trial: false },
        product: { amount: 5900, currency: 'USD' },
        customer: {},
      },
      {
        eventId: 'older-active',
        eventCreatedAt: '2026-07-15T10:00:00.000Z',
        environment: 'production',
      },
    );
    expect(rpcCalls[0]).toMatchObject({ name: 'claim_solidgate_entity_event' });
    expect(writes.filter((w) => w.op === 'update' || w.op === 'upsert')).toHaveLength(0);
  });

  it('does not reopen canceled access even when a positive callback is newer', async () => {
    const canceled = capturedSubscriptionOrder({ status: 'canceled' });
    const { db, updatesTo, upsertsTo } = makeDb(
      [canceled],
      [{ id: 'sess-1', email: 'b@e.com', locale: 'en', user_id: 'user-1' }],
      {
        entitlements: [subscriptionEntitlement(canceled, {
          status: 'canceled',
          revoked_at: '2026-07-16T10:00:00.000Z',
        })],
      },
    );

    await handleEvent(db, 'subscription.updated.v2', {
      callback_type: 'active',
      subscription: { id: 'sub-uuid-1', status: 'active', trial: false },
      product: { amount: 5900, currency: 'USD' },
      customer: {},
      invoices: {
        newer: {
          id: 'newer',
          status: 'success',
          amount: 5900,
          subscription_term_number: 1,
        },
      },
    });

    expect(updatesTo('orders')).toHaveLength(0);
    expect(upsertsTo('entitlements')).toHaveLength(0);
  });
});

describe('card_gate.chargeback.received', () => {
  it('marks the order disputed and pulls access immediately', async () => {
    const { db, updatesTo } = makeDb([{ ...ORDER_ROW, status: 'completed' }]);
    await handleEvent(db, 'card_gate.chargeback.received', {
      order: { order_id: 'sess-1:trial4:1', amount: 1767, currency: 'USD' },
      chargeback: { id: 'cb-1', status: 'in_progress', type: '1st_chb', reason_description: 'Fraud' },
    });
    expect(updatesTo('orders')[0]).toMatchObject({ status: 'disputed' });
    expect(updatesTo('entitlements')[0]).toMatchObject({ status: 'canceled' });
  });

  it('retries the status CAS, records the browser winner, and revokes its exact chargeback grant', async () => {
    const pending = { ...ORDER_ROW, user_id: null, status: 'pending' };
    const browserWinner = capturedSubscriptionOrder({
      user_id: 'user-1',
      status: 'trialing',
    });
    const attempt = makeDb(
      [pending],
      undefined,
      { entitlements: [subscriptionEntitlement(browserWinner, { access_level: 'full' })] },
      {},
      {
        emptyUpdateSelectOn: { orders: [1] },
        updateRaceWinner: {
          orders: {
            user_id: browserWinner.user_id,
            status: browserWinner.status,
            solidgate_original_amount_cents: browserWinner.solidgate_original_amount_cents,
            solidgate_payment_status: browserWinner.solidgate_payment_status,
          },
        },
      },
    );

    await handleEvent(attempt.db, 'card_gate.chargeback.received', {
      order: { order_id: 'sess-1:trial4:1', amount: 1767, currency: 'USD' },
      chargeback: {
        id: 'cb-browser-race',
        amount: 1767,
        status: 'in_progress',
        reason_description: 'Fraud',
      },
    });

    expect(attempt.updatesTo('orders')).toHaveLength(2);
    expect(attempt.updatesTo('orders')[1]).toMatchObject({
      status: 'disputed',
      solidgate_pre_dispute_status: 'trialing',
    });
    expect(attempt.updatesTo('entitlements')).toHaveLength(1);
    expect(
      attempt.writes.find((write) =>
        write.table === 'entitlements' && write.op === 'update'
      )?.filters,
    ).toContainEqual({ column: 'order_id', value: 'order-1' });
  });

  it('does not restore access when a chargeback is reversed', async () => {
    const disputed = {
      ...capturedSubscriptionOrder({ status: 'disputed' }),
      solidgate_pre_dispute_status: 'trialing',
      solidgate_chargeback_id: 'cb-reversed',
      solidgate_chargeback_status: 'in_progress',
      solidgate_chargeback_amount_cents: 1767,
    };
    const attempt = makeDb(
      [disputed],
      undefined,
      {
        entitlements: [subscriptionEntitlement(disputed, {
          access_level: 'full',
          status: 'canceled',
          revoked_at: '2026-07-22T08:00:00.000Z',
        })],
      },
    );

    await handleEvent(attempt.db, 'card_gate.chargeback.received', {
      order: { order_id: 'sess-1:trial4:1', amount: 1767, currency: 'USD' },
      chargeback: {
        id: 'cb-reversed',
        amount: 1767,
        status: 'reversed',
        reason_description: 'Reversed',
      },
    });

    expect(attempt.updatesTo('orders')[0]).toMatchObject({ status: 'trialing' });
    expect(attempt.updatesTo('entitlements')).toHaveLength(0);
    expect(attempt.upsertsTo('entitlements')).toHaveLength(0);
  });

  it('maps a generated renewal chargeback to the invoice and subscription', async () => {
    const { db, updatesTo } = makeDb([], [], {
      solidgate_invoice_orders: [{
        solidgate_order_id: 'sg-renewal-order',
        solidgate_invoice_id: 'inv-renewal',
        solidgate_subscription_id: 'sub-renewal',
        amount_cents: 5900,
        refunded_amount_cents: 0,
        currency: 'usd',
      }],
      renewal_events: [{
        solidgate_invoice_id: 'inv-renewal',
        gross_amount_cents: 5900,
        amount_cents: 5900,
        refunded_amount_cents: 0,
      }],
    });
    await handleEvent(db, 'card_gate.chargeback.received', {
      order: { order_id: 'sg-renewal-order', amount: 5900, currency: 'USD' },
      chargeback: { id: 42, amount: 5900, status: 'in_progress', reason_description: 'Fraud' },
    });
    expect(updatesTo('renewal_events')[0]).toMatchObject({
      amount_cents: 0,
      status: 'disputed',
      chargeback_id: '42',
      chargeback_amount_cents: 5900,
    });
    expect(updatesTo('entitlements')[0]).toMatchObject({ status: 'canceled' });
  });
});
