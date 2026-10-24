export * from './neon-client';
export { createClient as createBrowserDbClient } from './client';
export { createClient as createServerDbClient, getDb } from './server';

// Compatibility alias for codebase
export type SupabaseClient = import('./neon-client').NeonDatabaseClient;
