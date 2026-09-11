import type { Json } from '../types/database';
import { getSupabaseAdminClient } from '../supabase/admin';

export type AnalyticsSourceApp = 'funnel' | 'pwa' | 'system';
export type AnalyticsSourceChannel = 'client' | 'server' | 'webhook';

export const ANALYTICS_EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,79}$/;
export const ANALYTICS_EVENT_KEY_PATTERN = /^[\s\S]{1,240}$/;
export const ANALYTICS_PROJECT_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;

const MAX_PROPERTIES_BYTES = 65_536;

export function analyticsProjectKey(): string {
  const configured = process.env.ANALYTICS_PROJECT_KEY?.trim().toLowerCase();
  if (configured && ANALYTICS_PROJECT_KEY_PATTERN.test(configured)) return configured;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ANALYTICS_PROJECT_KEY must be a lowercase project identifier');
  }
  return 'local';
}

export function analyticsDeploymentEnvironment():
  | 'production'
  | 'preview'
  | 'development'
  | 'test'
  | 'sandbox' {
  const value = process.env.VERCEL_ENV ?? process.env.NODE_ENV;
  if (value === 'production' || value === 'preview' || value === 'test') return value;
  return 'development';
}

export function sanitizeAnalyticsProperties(input: unknown): Json {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('analytics properties must be an object');
  }

  let encoded: string;
  try {
    encoded = JSON.stringify(input);
  } catch {
    throw new Error('analytics properties must be JSON serializable');
  }
  if (new TextEncoder().encode(encoded).byteLength > MAX_PROPERTIES_BYTES) {
    throw new Error('analytics properties exceed 64 KiB');
  }
  return JSON.parse(encoded) as Json;
}

export async function recordAnalyticsEvent(params: {
  sourceApp: AnalyticsSourceApp;
  sourceChannel: AnalyticsSourceChannel;
  eventKey: string;
  eventName: string;
  distinctId: string;
  userId?: string | null;
  sessionId?: string | null;
  properties?: unknown;
  insertId?: string;
  occurredAt?: string;
}): Promise<void> {
  if (!ANALYTICS_EVENT_NAME_PATTERN.test(params.eventName)) {
    throw new Error('invalid analytics event name');
  }
  if (!ANALYTICS_EVENT_KEY_PATTERN.test(params.eventKey.trim())) {
    throw new Error('invalid analytics event key');
  }
  const distinctId = params.distinctId.trim();
  if (!distinctId || distinctId.length > 240) {
    throw new Error('invalid analytics distinct id');
  }

  const admin = getSupabaseAdminClient();
  const { error } = await admin.from('analytics_events').upsert(
    {
      project_key: analyticsProjectKey(),
      deployment_environment: analyticsDeploymentEnvironment(),
      source_app: params.sourceApp,
      source_channel: params.sourceChannel,
      event_key: params.eventKey.trim(),
      event_name: params.eventName,
      distinct_id: distinctId,
      ...(params.insertId ? { insert_id: params.insertId } : {}),
      user_id: params.userId ?? null,
      session_id: params.sessionId ?? null,
      properties: sanitizeAnalyticsProperties(params.properties),
      schema_version: 1,
      occurred_at: params.occurredAt ?? new Date().toISOString(),
    },
    {
      onConflict: 'project_key,deployment_environment,source_app,event_key',
      ignoreDuplicates: true,
    },
  );
  if (error) throw new Error(`analytics event insert failed: ${error.message}`);
}
