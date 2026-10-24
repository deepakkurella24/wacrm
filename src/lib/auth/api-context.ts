// ============================================================
// Public API authentication — resolve a request's API key into an
// account context.
//
// Machine-to-machine counterpart of human session authentication:
// authenticates a caller via `Authorization: Bearer <key>`.
//
// Calling convention — every `/api/v1` route does:
//
//   try {
//     const ctx = await requireApiKey(request, "messages:send");
//     // ctx.supabase   — service-role client (no user session exists)
//     // ctx.accountId  — the key's account; scope every query by it
//     // ctx.scopes     — granted scopes
//     // ctx.keyId      — for logging / the rate-limit bucket
//   } catch (err) {
//     return toApiErrorResponse(err);   // maps ApiError → envelope
//   }
// ============================================================

import type { SupabaseClient } from '@/lib/db';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  findActiveKeyByHash,
  getOrProvisionFixedServiceKey,
  touchLastUsed,
} from '@/lib/api-keys/store';
import {
  hashApiKey,
  looksLikeApiKey,
  timingSafeHexEqual,
} from '@/lib/api-keys/keys';
import { hasScope, type ApiScope } from '@/lib/api-keys/scopes';
import { forbidden, rateLimited, unauthorized } from '@/lib/api/v1/respond';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';

export interface ApiKeyContext {
  /** Discriminant — lets shared logic tell key auth from cookie auth. */
  authType: 'api_key';
  /** Service-role Supabase client. RLS-bypassing; scope by accountId. */
  supabase: SupabaseClient;
  /** The account this key belongs to. */
  accountId: string;
  /** The key row id — for audit logging and the rate-limit bucket. */
  keyId: string;
  /** Scopes granted to this key. */
  scopes: string[];
  /** Who minted the key (null if that user was later removed). */
  createdBy: string | null;
}

let fixedKeyCache: {
  keyHash: string;
  id: string;
  accountId: string;
} | null = null;

export function __resetFixedKeyCacheForTests(): void {
  fixedKeyCache = null;
}

/**
 * Extract the bearer token from the `Authorization` header.
 * Tolerates the `Bearer ` prefix being absent (some clients send the bare key).
 */
function extractKey(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const value = header.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim()
    : header.trim();
  return value.length > 0 ? value : null;
}

/**
 * Authenticate a public-API request and (optionally) enforce a
 * single scope. Throws an `ApiError` (mapped to the envelope by
 * `toApiErrorResponse`) on any failure:
 *
 *   401 unauthorized — no key, malformed, unknown, revoked, expired
 *   403 forbidden    — valid key without the required scope
 *   429 rate_limited — per-key budget exhausted
 *
 * On success, bumps `last_used_at` (fire-and-forget) and returns the
 * account context.
 */
export async function requireApiKey(
  request: Request,
  scope?: ApiScope
): Promise<ApiKeyContext> {
  const presented = extractKey(request);
  if (!presented) {
    throw unauthorized();
  }

  // Support server-side service credential configured via environment variables
  // (WACRM_SERVICE_API_KEY or WACRM_API_KEY).
  const serverApiKey =
    process.env.WACRM_SERVICE_API_KEY || process.env.WACRM_API_KEY;

  if (serverApiKey) {
    const presentedHash = hashApiKey(presented);
    const serverKeyHash = hashApiKey(serverApiKey);

    // Constant-time comparison between hashes
    if (timingSafeHexEqual(presentedHash, serverKeyHash)) {
      // Least-privilege: the fixed service key is strictly provisioned with 'messages:send'
      const serviceScopes = ['messages:send'];
      if (scope && !hasScope(serviceScopes, scope)) {
        throw forbidden(`This API key is missing the '${scope}' scope`);
      }

      // Retrieve or idempotently provision database record and account ID
      let cached = fixedKeyCache;
      if (!cached || cached.keyHash !== serverKeyHash) {
        const prefix =
          serverApiKey.length >= 8 ? serverApiKey.slice(0, 8) : 'wacrm_fix';
        const provisioned = await getOrProvisionFixedServiceKey(
          serverKeyHash,
          prefix
        );
        cached = {
          keyHash: serverKeyHash,
          id: provisioned?.id || 'fixed-service-key-id',
          accountId:
            provisioned?.accountId || '00000000-0000-0000-0000-000000000000',
        };
        fixedKeyCache = cached;
      }

      // Check per-key rate limit
      const limit = checkRateLimit(
        `apikey:${cached.id}`,
        RATE_LIMITS.publicApi
      );
      if (!limit.success) {
        throw rateLimited(limit);
      }

      // Touch last_used_at
      touchLastUsed(cached.id);

      return {
        authType: 'api_key',
        supabase: supabaseAdmin(),
        accountId: cached.accountId,
        keyId: cached.id,
        scopes: serviceScopes,
        createdBy: null,
      };
    }
  }

  if (!looksLikeApiKey(presented)) {
    throw unauthorized();
  }

  const row = await findActiveKeyByHash(hashApiKey(presented));
  if (!row) {
    // Covers unknown, revoked, and expired keys alike
    throw unauthorized();
  }

  // Rate-limit per key, before the scope check
  const limit = checkRateLimit(`apikey:${row.id}`, RATE_LIMITS.publicApi);
  if (!limit.success) {
    throw rateLimited(limit);
  }

  if (scope && !hasScope(row.scopes, scope)) {
    throw forbidden(`This API key is missing the '${scope}' scope`);
  }

  touchLastUsed(row.id);

  return {
    authType: 'api_key',
    supabase: supabaseAdmin(),
    accountId: row.account_id,
    keyId: row.id,
    scopes: row.scopes,
    createdBy: row.created_by,
  };
}
