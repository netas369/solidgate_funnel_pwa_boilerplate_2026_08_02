import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdminClient } from "@repo/shared/supabase/admin";

export interface CronRunStats {
  job: string;
  ok: boolean;
  total: number;
  generated: number;
  cached: number;
  failed: number;
  failures: unknown[];
  durationMs: number;
}

/**
 * Records one cron run into the `cron_runs` table (internal job observability).
 * Query `select * from cron_runs where ok = false order by ran_at desc` to
 * surface failures — a cron response's `{ ok: false }` is read by nothing
 * otherwise, so without this a scheduled job can fail silently for weeks.
 *
 * Best-effort: never throws, never blocks the cron response.
 *
 * NOTE: currently UNREFERENCED — the boilerplate ships no cron (vercel.json
 * `crons` is []). It is kept, with its table, because the first scheduled job
 * any product adds needs exactly this and it is cheaper to keep 40 lines than
 * to rediscover the pattern. Delete both if you are sure you will never add
 * one.
 */
export async function recordCronRun(stats: CronRunStats): Promise<void> {
  try {
    // `cron_runs` is not in the generated Database types, so the admin client
    // is used untyped for this insert.
    const admin = getSupabaseAdminClient() as unknown as SupabaseClient;
    const { error } = await admin.from("cron_runs").insert({
      job: stats.job,
      ok: stats.ok,
      total: stats.total,
      generated: stats.generated,
      cached: stats.cached,
      failed: stats.failed,
      failures: stats.failures.slice(0, 30),
      duration_ms: stats.durationMs,
    });
    if (error) {
      console.error(`[cron-runs] insert failed for ${stats.job}:`, error.message);
    }
  } catch (err) {
    console.error(`[cron-runs] insert error for ${stats.job}:`, err);
  }
}
