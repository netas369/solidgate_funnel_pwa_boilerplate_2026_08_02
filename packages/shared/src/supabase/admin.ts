import { createClient } from '@supabase/supabase-js';
import type { Database } from '../types/database';

let adminClient: ReturnType<typeof createClient<Database>> | null = null;

function getEnv(name: 'NEXT_PUBLIC_SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY'): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} env var is not set`);
  }

  return value;
}

export function getSupabaseAdminClient() {
  if (!adminClient) {
    adminClient = createClient<Database>(
      getEnv('NEXT_PUBLIC_SUPABASE_URL'),
      getEnv('SUPABASE_SERVICE_ROLE_KEY'),
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      },
    );
  }

  return adminClient;
}
