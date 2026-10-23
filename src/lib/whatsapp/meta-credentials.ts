import { decrypt } from './encryption';

export interface MetaCredentials {
  phoneNumberId: string;
  accessToken: string;
  wabaId?: string;
  verifyToken?: string;
  appSecret?: string;
  source: 'env' | 'database';
}

/**
 * Returns server-side Meta credentials if configured in environment variables.
 * Environment variables take precedence over database-stored credentials.
 */
export function getEnvMetaCredentials(): MetaCredentials | null {
  const accessToken = process.env.META_ACCESS_TOKEN?.trim();
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID?.trim();
  const wabaId = process.env.META_WABA_ID?.trim();
  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN?.trim();
  const appSecret = process.env.META_APP_SECRET?.trim();

  if (accessToken && phoneNumberId) {
    return {
      phoneNumberId,
      accessToken,
      wabaId: wabaId || undefined,
      verifyToken: verifyToken || undefined,
      appSecret: appSecret || undefined,
      source: 'env',
    };
  }

  return null;
}

/**
 * Resolve Meta credentials for an account. Checks environment variables first.
 * If not set, queries the `whatsapp_config` table on the provided database client.
 */
export async function resolveMetaCredentials(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db?: any,
  accountId?: string,
): Promise<MetaCredentials | null> {
  const envCreds = getEnvMetaCredentials();
  if (envCreds) {
    return envCreds;
  }

  if (!db || !accountId) {
    return null;
  }

  const query = db
    .from('whatsapp_config')
    .select('phone_number_id, access_token, waba_id, verify_token')
    .eq('account_id', accountId);

  const { data: config, error } = typeof query.single === 'function'
    ? await query.single()
    : await query.maybeSingle();

  if (error || !config || !config.phone_number_id || !config.access_token) {
    return null;
  }

  try {
    const accessToken = decrypt(config.access_token);
    const verifyToken = config.verify_token ? decrypt(config.verify_token) : undefined;
    return {
      phoneNumberId: config.phone_number_id,
      accessToken,
      wabaId: config.waba_id || undefined,
      verifyToken,
      source: 'database',
    };
  } catch {
    return null;
  }
}
