import { createClient as createDbClient } from '@/lib/db/client';
import type { NeonDatabaseClient } from '@/lib/db/neon-client';

export type SupabaseClient = NeonDatabaseClient;

export function createClient() {
  return createDbClient();
}
