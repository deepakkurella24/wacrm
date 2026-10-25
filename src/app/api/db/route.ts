import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { executeNeonQuery, runNeonQuery, type QueryPayload } from '@/lib/db/neon-client';
import { neon } from '@neondatabase/serverless';

/**
 * Internal DB query proxy for authenticated browser components.
 * Enforces Clerk session authentication and multi-tenant account isolation.
 */
export async function POST(request: Request) {
  try {
    const clerk = await auth();
    const userId = clerk?.userId;

    if (!userId) {
      return NextResponse.json({ error: { message: 'Unauthorized' } }, { status: 401 });
    }

    const body = (await request.json().catch(() => null)) as { payload?: QueryPayload } | null;
    const payload = body?.payload;

    if (!payload || !payload.table || !payload.action) {
      return NextResponse.json({ error: { message: 'Invalid query payload' } }, { status: 400 });
    }

    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      return NextResponse.json({
        data: payload.isSingle || payload.isMaybeSingle ? null : [],
        error: null,
      });
    }

    const sql = neon(dbUrl);

    // Resolve caller's account_id from profiles
    let accountId: string | null = null;
    const profileRows = (await runNeonQuery(
      sql,
      'SELECT account_id FROM profiles WHERE user_id = $1 LIMIT 1',
      [userId],
    )) as { account_id: string }[];

    if (profileRows && profileRows.length > 0 && profileRows[0].account_id) {
      accountId = profileRows[0].account_id;
    } else {
      // First-time Clerk login: provision default account & profile
      const newAccount = (await runNeonQuery(
        sql,
        `INSERT INTO accounts (name, owner_user_id, default_currency)
         VALUES ($1, $2, 'INR')
         ON CONFLICT (owner_user_id) DO UPDATE SET updated_at = NOW()
         RETURNING id`,
        ['Personal Account', userId],
      )) as { id: string }[];

      accountId = newAccount[0]?.id;

      if (accountId) {
        await runNeonQuery(
          sql,
          `INSERT INTO profiles (user_id, account_id, account_role, full_name, email)
           VALUES ($1, $2, 'owner', $3, $4)
           ON CONFLICT (user_id) DO NOTHING`,
          [userId, accountId, 'Agent', 'agent@insurance.local'],
        );
      }
    }

    // Tables requiring account isolation
    const tenantTables = [
      'contacts',
      'conversations',
      'whatsapp_config',
      'tags',
      'custom_fields',
      'flows',
      'flow_runs',
      'quick_replies',
      'api_keys',
      'message_templates',
    ];

    if (accountId && tenantTables.includes(payload.table)) {
      if (['select', 'update', 'delete'].includes(payload.action)) {
        const hasAccountFilter = payload.filters.some((f) => f.column === 'account_id');
        if (!hasAccountFilter) {
          payload.filters.push({ column: 'account_id', op: '=', value: accountId });
        }
      } else if (payload.action === 'insert' || payload.action === 'upsert') {
        if (Array.isArray(payload.values)) {
          payload.values = payload.values.map((v) => ({ ...v, account_id: accountId }));
        } else if (payload.values && typeof payload.values === 'object') {
          payload.values = { ...(payload.values as Record<string, unknown>), account_id: accountId };
        }
      }
    }

    // Execute query via Neon client
    const result = await executeNeonQuery(payload, dbUrl);
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/db] error:', message);
    return NextResponse.json({ error: { message } }, { status: 500 });
  }
}
