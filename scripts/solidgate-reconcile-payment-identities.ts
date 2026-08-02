// Provider-evidence cutover for migration 20260721124000.
//
//   npx tsx scripts/solidgate-reconcile-payment-identities.ts
//   npx tsx scripts/solidgate-reconcile-payment-identities.ts --apply
//
// Dry-run is the default. The script never prints customer email or card data.
// It reads every legacy-marked merchant order from the environment selected by
// SOLIDGATE_ENVIRONMENT, verifies its exact authenticated Solidgate status response,
// and only then invokes operator-only SQL to bind the full snapshot. PostgreSQL repeats
// all order/account/description/gross/currency checks inside the row lock.

import dotenv from 'dotenv';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { SolidgateClient } from '../packages/shared/src/solidgate/client';
import {
  orderFingerprint,
  providerEvidence,
  providerThrottleMs,
  type LegacyOrder,
  type ProviderStatus,
  validateOperatorDatabaseUrl,
} from './solidgate-reconciliation-evidence';

dotenv.config({ path: path.resolve(process.cwd(), 'apps/funnel/.env.local') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const APPLY = process.argv.includes('--apply');
const PAYMENT_ENVIRONMENT = process.env.SOLIDGATE_ENVIRONMENT;
if (PAYMENT_ENVIRONMENT !== 'production' && PAYMENT_ENVIRONMENT !== 'sandbox') {
  throw new Error('SOLIDGATE_ENVIRONMENT must be exactly production or sandbox');
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const publicKey = process.env.SOLIDGATE_API_PUBLIC_KEY;
const secretKey = process.env.SOLIDGATE_API_SECRET_KEY;
const operatorDatabaseUrl = process.env.SUPABASE_DB_URL;
if (!supabaseUrl || !serviceRoleKey || !publicKey || !secretKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and Solidgate API keys are required',
  );
}
if (APPLY && !operatorDatabaseUrl) {
  throw new Error('SUPABASE_DB_URL with an operator/postgres role is required for --apply');
}

// Validate operator authority/project affinity before the first provider call.
// A typo must not spend API quota and then fail halfway through reconciliation.
const validatedOperatorDatabaseUrl = APPLY
  ? validateOperatorDatabaseUrl(operatorDatabaseUrl!, supabaseUrl)
  : null;

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const solidgate = new SolidgateClient({ publicKey, secretKey });
const PROVIDER_THROTTLE_MS = providerThrottleMs(PAYMENT_ENVIRONMENT);

async function loadLegacyOrders(): Promise<LegacyOrder[]> {
  const rows: LegacyOrder[] = [];
  const pageSize = 500;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('orders')
      .select(
        'id,solidgate_order_id,session_id,user_id,product_name,amount_cents,currency,solidgate_original_amount_cents,tracking_metadata',
      )
      .eq('psp', 'solidgate')
      .eq('payment_environment', PAYMENT_ENVIRONMENT)
      .eq('solidgate_checkout_identity_legacy', true)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`legacy order read failed: ${error.message}`);
    const page = (data ?? []) as LegacyOrder[];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

function sqlLiteral(value: string | null): string {
  return value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`;
}

function applyOperatorReconciliation(order: LegacyOrder, evidence: ReturnType<typeof providerEvidence>) {
  if (!evidence || !validatedOperatorDatabaseUrl) return false;
  const databaseUrl = validatedOperatorDatabaseUrl;
  const sql = `SELECT public.reconcile_solidgate_legacy_order_identity(` +
    `${sqlLiteral(PAYMENT_ENVIRONMENT)},` +
    `${sqlLiteral(order.solidgate_order_id)},` +
    `${sqlLiteral(evidence.email)},` +
    `${sqlLiteral(evidence.accountId)},` +
    `${sqlLiteral(evidence.description)},` +
    `${sqlLiteral(evidence.productId)},` +
    `${evidence.amountCents},` +
    `${sqlLiteral(evidence.currency)},` +
    `${sqlLiteral(JSON.stringify(evidence.orderMetadata))}::jsonb,` +
    `${sqlLiteral(evidence.cardToken)},` +
    `${sqlLiteral(evidence.cardBrand)},` +
    `${sqlLiteral(evidence.cardLast4)}` +
    `);`;
  try {
    const sslMode = databaseUrl.searchParams.get('sslmode')
      ?? (databaseUrl.hostname === 'localhost' || databaseUrl.hostname === '127.0.0.1'
        ? 'disable'
        : 'require');
    const output = execFileSync(
      'psql',
      [
        '--no-psqlrc',
        '--set', 'ON_ERROR_STOP=1',
        '--tuples-only',
        '--no-align',
        '--file=-',
      ],
      {
        encoding: 'utf8',
        input: sql,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PGHOST: databaseUrl.hostname,
          PGPORT: databaseUrl.port || '5432',
          PGUSER: decodeURIComponent(databaseUrl.username),
          PGPASSWORD: decodeURIComponent(databaseUrl.password),
          PGDATABASE: databaseUrl.pathname.replace(/^\//, '') || 'postgres',
          PGSSLMODE: sslMode,
        },
      },
    );
    return output.trim() === 't';
  } catch {
    return false;
  }
}

async function main() {
  const orders = await loadLegacyOrders();
  console.log(
    `${APPLY ? 'APPLY' : 'DRY RUN'} ${PAYMENT_ENVIRONMENT}: ${orders.length} legacy order(s)`,
  );
  let ready = 0;
  let applied = 0;
  const blocked: string[] = [];

  for (const [index, order] of orders.entries()) {
    const orderRef = orderFingerprint(order.solidgate_order_id);
    try {
      let status: ProviderStatus;
      try {
        status = await solidgate.status<ProviderStatus>({ order_id: order.solidgate_order_id });
      } catch (error) {
        blocked.push(`${orderRef}: provider status unavailable`);
        console.error(
          `[${index + 1}/${orders.length}] blocked ${orderRef}: ` +
            `provider status unavailable (${error instanceof Error ? error.name : 'unknown'})`,
        );
        continue;
      }
      const evidence = providerEvidence(order, status);
      if (!evidence) {
        blocked.push(`${orderRef}: provider evidence mismatch`);
        console.error(`[${index + 1}/${orders.length}] blocked ${orderRef}: mismatch`);
        continue;
      }
      ready += 1;

      if (APPLY) {
        if (!applyOperatorReconciliation(order, evidence)) {
          blocked.push(`${orderRef}: database reconciliation failed`);
          console.error(`[${index + 1}/${orders.length}] blocked ${orderRef}: operator SQL failed`);
          continue;
        }
        applied += 1;
      }
      console.log(`[${index + 1}/${orders.length}] ${APPLY ? 'reconciled' : 'ready'} ${orderRef}`);
    } finally {
      // Solidgate limits sandbox to 10 rps and live traffic to 25 rps. Every
      // provider attempt, including all blocked/error paths, is throttled.
      await new Promise((resolve) => setTimeout(resolve, PROVIDER_THROTTLE_MS));
    }
  }

  const { count, error: countError } = await supabase
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('psp', 'solidgate')
    .eq('payment_environment', PAYMENT_ENVIRONMENT)
    .eq('solidgate_checkout_identity_legacy', true);
  if (countError) throw new Error(`post-reconciliation count failed: ${countError.message}`);

  const { count: legacyVaultCount, error: legacyVaultCountError } = await supabase
    .from('solidgate_session_vault')
    .select('session_id', { count: 'exact', head: true })
    .eq('payment_environment', PAYMENT_ENVIRONMENT)
    .eq('card_source_legacy', true)
    .not('card_token', 'is', null);
  if (legacyVaultCountError) {
    throw new Error(`legacy session-vault count failed: ${legacyVaultCountError.message}`);
  }

  console.log(
    `ready=${ready} applied=${applied} blocked=${blocked.length} ` +
      `remaining=${count ?? 'unknown'} legacy_session_tokens=${legacyVaultCount ?? 'unknown'}`,
  );
  if (
    blocked.length > 0
    || (APPLY && (count !== 0 || legacyVaultCount !== 0))
  ) process.exitCode = 1;
}

await main();
