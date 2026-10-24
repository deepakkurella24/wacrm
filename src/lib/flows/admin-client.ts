import { getDb } from '@/lib/db';
import type { NeonDatabaseClient } from '@/lib/db/neon-client';

export type SupabaseClient = NeonDatabaseClient;

export function supabaseAdmin(): NeonDatabaseClient {
  return getDb();
}
