import { neon, Pool } from '@neondatabase/serverless';

/**
 * Neon Serverless SQL Client
 * Uses DATABASE_URL environment variable to connect to Neon PostgreSQL Project B.
 */
export function getDbUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('DATABASE_URL environment variable is not defined.');
    }
    return '';
  }
  return url;
}

/**
 * HTTP query runner for single SQL queries in serverless functions.
 */
export const sql = neon(getDbUrl());

let _pool: Pool | null = null;

/**
 * Connection pool for multi-query transactions or persistent sessions.
 */
export function getDbPool(): Pool {
  if (!_pool) {
    const connectionString = getDbUrl();
    _pool = new Pool({ connectionString });
  }
  return _pool;
}
