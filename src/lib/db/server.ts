import { createNeonClient, type NeonDatabaseClient } from './neon-client';

let serverDbClient: NeonDatabaseClient | undefined;

/**
 * Server-side database client.
 * Connects directly to Neon PostgreSQL using DATABASE_URL.
 */
export async function createClient(): Promise<NeonDatabaseClient> {
  if (!serverDbClient) {
    serverDbClient = createNeonClient(process.env.DATABASE_URL);
  }
  return serverDbClient;
}

export function getDb(): NeonDatabaseClient {
  if (!serverDbClient) {
    serverDbClient = createNeonClient(process.env.DATABASE_URL);
  }
  return serverDbClient;
}
