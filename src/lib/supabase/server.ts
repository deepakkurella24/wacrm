import { createClient as createServerDbClient } from '@/lib/db/server';
import type { NeonDatabaseClient } from '@/lib/db/neon-client';

export type SupabaseClient = NeonDatabaseClient;

export async function createClient() {
  return createServerDbClient();
}
