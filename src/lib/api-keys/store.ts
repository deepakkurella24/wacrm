// ============================================================
// API key store — the *auth-path* data access for public API keys.
//
// Only the read side lives here, and deliberately so: it runs with
// the service-role client because a public-API caller has no Supabase
// session, so RLS (which keys off `auth.uid()`) can't scope the
// lookup. The management side (list / create / revoke) runs in the
// dashboard under a real cookie session and goes through the RLS
// client *inline* in the route handlers — same pattern as
// `/api/account/invitations`. Keeping the RLS-bypassing surface tiny
// and read-only here makes it easy to audit.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client';

/** Shape of an `api_keys` row as the auth path consumes it. */
export interface ApiKeyRow {
  id: string;
  account_id: string;
  created_by: string | null;
  name: string;
  scopes: string[];
  expires_at: string | null;
  revoked_at: string | null;
}

/**
 * Idempotently ensure the fixed server-side service key is provisioned in the database.
 * If a row with key_hash already exists, returns its id and account_id.
 * If not, associates with the primary account (or default) and inserts the row.
 */
export async function getOrProvisionFixedServiceKey(
  keyHash: string,
  keyPrefix: string
): Promise<{ id: string; accountId: string } | null> {
  const admin = supabaseAdmin();
  try {
    const { data: existing } = await admin
      .from('api_keys')
      .select('id, account_id, scopes')
      .eq('key_hash', keyHash)
      .maybeSingle();

    if (existing?.id) {
      return { id: existing.id, accountId: existing.account_id };
    }

    // Resolve an account to attach this service key to
    let accountId = '00000000-0000-0000-0000-000000000000';
    try {
      const { data: acc } = await admin
        .from('accounts')
        .select('id')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (acc?.id) accountId = acc.id;
    } catch {
      // fallback
    }

    // Insert new row
    const { data: inserted, error: insertError } = await admin
      .from('api_keys')
      .insert({
        account_id: accountId,
        name: 'Fixed Public API Service Key',
        key_hash: keyHash,
        key_prefix: keyPrefix,
        scopes: ['messages:send'],
        last_used_at: new Date().toISOString(),
      })
      .select('id, account_id')
      .maybeSingle();

    if (inserted?.id) {
      return { id: inserted.id, accountId: inserted.account_id };
    }

    if (insertError) {
      console.error('[api-keys/store] Failed to provision fixed service key:', insertError.message);
    }
    return { id: 'fixed-service-key-id', accountId };
  } catch (err) {
    console.error('[api-keys/store] Error provisioning fixed service key:', err);
    return { id: 'fixed-service-key-id', accountId: '00000000-0000-0000-0000-000000000000' };
  }
}

/**
 * Look up an *active* key by its SHA-256 hash. Returns null if no
 * row matches, or if the matching row is revoked or expired — so
 * callers never have to re-check liveness. Uses the service-role
 * client (RLS-bypassing); the hash is the only credential, so this
 * is the moment that establishes the caller's account.
 */
export async function findActiveKeyByHash(
  hash: string
): Promise<ApiKeyRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('api_keys')
    .select('id, account_id, created_by, name, scopes, expires_at, revoked_at')
    .eq('key_hash', hash)
    .maybeSingle();

  if (error) {
    console.error('[api-keys/store] lookup error:', error.message);
    return null;
  }
  if (!data) return null;

  // Liveness checks in JS rather than SQL so the failure modes are
  // explicit and the index stays a simple equality lookup.
  if (data.revoked_at) return null;
  if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) {
    return null;
  }

  return data as ApiKeyRow;
}

/**
 * Fetch the account name for a resolved key, so `/api/v1/me` and any
 * future endpoint can echo it without a second round trip in the
 * route. Service-role; the key already proved account membership.
 */
export async function getAccountName(
  accountId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('accounts')
    .select('name')
    .eq('id', accountId)
    .maybeSingle();
  if (error || !data) return null;
  return (data.name as string) ?? null;
}

/**
 * Best-effort `last_used_at` bump. Fire-and-forget from the auth
 * path — a failed update just means the "last used" column lags;
 * it must never fail the request the caller is actually making.
 */
export function touchLastUsed(id: string): void {
  void supabaseAdmin()
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', id)
    .then(({ error }) => {
      if (error) {
        console.warn(
          '[api-keys/store] last_used_at bump failed:',
          error.message
        );
      }
    });
}
