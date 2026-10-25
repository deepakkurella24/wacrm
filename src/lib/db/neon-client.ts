import { neon } from '@neondatabase/serverless';

export interface QueryFilter {
  column: string;
  op: '=' | '!=' | 'IN' | 'IS' | 'LIKE' | 'ILIKE' | '>' | '>=' | '<' | '<=' | 'contains' | 'raw';
  value: unknown;
}

export interface QueryOrder {
  column: string;
  ascending: boolean;
  nullsFirst?: boolean;
}

export interface QueryPayload {
  table: string;
  action: 'select' | 'insert' | 'update' | 'upsert' | 'delete';
  columns?: string;
  values?: unknown;
  filters: QueryFilter[];
  orders: QueryOrder[];
  limitCount?: number;
  offsetCount?: number;
  isSingle?: boolean;
  isMaybeSingle?: boolean;
  onConflict?: string;
  ignoreDuplicates?: boolean;
}

export interface QueryResult<T = any> {
  data: T;
  error: { message: string; code?: string; details?: string; hint?: string } | null;
  count?: number | null;
}

/**
 * Builds and executes parameterized SQL against Neon PostgreSQL.
 */
export function buildSqlQuery(payload: QueryPayload): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  let paramIndex = 1;

  function addParam(val: unknown): string {
    params.push(val);
    return `$${paramIndex++}`;
  }

  const { table, action, columns, values, filters, orders, limitCount, offsetCount } = payload;

  function buildWhere(): string {
    if (!filters || filters.length === 0) return '';
    const clauses = filters.map((f) => {
      if (f.op === 'raw') {
        return `(${String(f.value)})`;
      }
      const col = f.column.includes('.') ? f.column.split('.').pop()! : f.column;
      const safeCol = `"${col}"`;

      if (f.op === 'IS') {
        if (f.value === null) return `${safeCol} IS NULL`;
        if (f.value === true) return `${safeCol} IS TRUE`;
        if (f.value === false) return `${safeCol} IS FALSE`;
        return `${safeCol} IS NOT NULL`;
      }
      if (f.op === 'IN') {
        const arr = Array.isArray(f.value) ? f.value : [f.value];
        if (arr.length === 0) return 'FALSE';
        const placeholders = arr.map((item) => addParam(item)).join(', ');
        return `${safeCol} IN (${placeholders})`;
      }
      if (f.op === 'contains') {
        return `${safeCol} @> ${addParam(f.value)}`;
      }
      return `${safeCol} ${f.op} ${addParam(f.value)}`;
    });
    return ` WHERE ${clauses.join(' AND ')}`;
  }

  if (action === 'select') {
    const rawCols = columns ?? '*';
    let selectClause = '*';
    let fromClause = `"${table}"`;

    if (table === 'conversations' && rawCols.includes('contact:contacts')) {
      fromClause = `"${table}" c LEFT JOIN "contacts" ct ON ct.id = c.contact_id`;
      selectClause = `c.*, row_to_json(ct.*) AS contact`;
    } else if (table === 'contact_tags' && (rawCols.includes('tags(*)') || rawCols.includes('tag:tags'))) {
      fromClause = `"${table}" ct LEFT JOIN "tags" t ON t.id = ct.tag_id`;
      selectClause = `ct.id, ct.contact_id, ct.tag_id, ct.created_at, row_to_json(t.*) AS tags, row_to_json(t.*) AS tag`;
    } else if (table === 'messages' && rawCols.includes('conversations!inner')) {
      fromClause = `"${table}" m INNER JOIN "conversations" c ON c.id = m.conversation_id`;
      selectClause = `m.id, m.conversation_id, m.status, json_build_object('account_id', c.account_id) AS conversations`;
    } else if (rawCols !== '*') {
      if (!rawCols.includes('(')) {
        selectClause = rawCols
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean)
          .map((c) => (c.includes('"') ? c : `"${c}"`))
          .join(', ');
      }
    }

    let sql = `SELECT ${selectClause} FROM ${fromClause}${buildWhere()}`;

    if (orders && orders.length > 0) {
      const orderClauses = orders.map((o) => {
        const dir = o.ascending ? 'ASC' : 'DESC';
        const nulls = o.nullsFirst !== undefined ? (o.nullsFirst ? ' NULLS FIRST' : ' NULLS LAST') : '';
        return `"${o.column}" ${dir}${nulls}`;
      });
      sql += ` ORDER BY ${orderClauses.join(', ')}`;
    }

    if (limitCount !== undefined) {
      sql += ` LIMIT ${limitCount}`;
    }
    if (offsetCount !== undefined) {
      sql += ` OFFSET ${offsetCount}`;
    }

    return { sql, params };
  }

  if (action === 'insert') {
    const rows = Array.isArray(values) ? values : [values];
    if (rows.length === 0 || !rows[0]) {
      return { sql: `SELECT 1 WHERE FALSE`, params: [] };
    }
    const cols = Object.keys(rows[0]);
    const safeCols = cols.map((c) => `"${c}"`).join(', ');

    const valueRows = rows.map((row) => {
      const ph = cols.map((c) => addParam(row[c]));
      return `(${ph.join(', ')})`;
    });

    const returning = columns ? (columns === '*' ? '*' : columns) : '*';
    const sql = `INSERT INTO "${table}" (${safeCols}) VALUES ${valueRows.join(', ')} RETURNING ${returning}`;
    return { sql, params };
  }

  if (action === 'update') {
    const valObj = (values ?? {}) as Record<string, unknown>;
    const keys = Object.keys(valObj);
    if (keys.length === 0) {
      return { sql: `SELECT 1 WHERE FALSE`, params: [] };
    }
    const setClauses = keys.map((k) => `"${k}" = ${addParam(valObj[k])}`).join(', ');
    const returning = columns ? (columns === '*' ? '*' : columns) : '*';
    const sql = `UPDATE "${table}" SET ${setClauses}${buildWhere()} RETURNING ${returning}`;
    return { sql, params };
  }

  if (action === 'upsert') {
    const rows = Array.isArray(values) ? values : [values];
    if (rows.length === 0 || !rows[0]) {
      return { sql: `SELECT 1 WHERE FALSE`, params: [] };
    }
    const cols = Object.keys(rows[0]);
    const safeCols = cols.map((c) => `"${c}"`).join(', ');

    const valueRows = rows.map((row) => {
      const ph = cols.map((c) => addParam(row[c]));
      return `(${ph.join(', ')})`;
    });

    let conflictTarget = payload.onConflict;
    if (!conflictTarget) {
      if (table === 'messages') conflictTarget = 'conversation_id, message_id';
      else if (table === 'whatsapp_config') conflictTarget = 'account_id';
      else if (table === 'profiles') conflictTarget = 'user_id';
      else if (table === 'accounts') conflictTarget = 'owner_user_id';
      else conflictTarget = 'id';
    }

    let conflictAction = 'DO NOTHING';
    if (!payload.ignoreDuplicates) {
      const updateCols = cols.filter((c) => !conflictTarget?.includes(c));
      if (updateCols.length > 0) {
        const setList = updateCols.map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ');
        conflictAction = `DO UPDATE SET ${setList}`;
      }
    }

    const returning = columns ? (columns === '*' ? '*' : columns) : '*';
    const sql = `INSERT INTO "${table}" (${safeCols}) VALUES ${valueRows.join(', ')} ON CONFLICT (${conflictTarget}) ${conflictAction} RETURNING ${returning}`;
    return { sql, params };
  }

  if (action === 'delete') {
    const returning = columns ? (columns === '*' ? '*' : columns) : '*';
    const sql = `DELETE FROM "${table}"${buildWhere()} RETURNING ${returning}`;
    return { sql, params };
  }

  throw new Error(`Unsupported query action: ${action}`);
}

/**
 * Executes a query payload using a Neon client.
 */
export async function executeNeonQuery(
  payload: QueryPayload,
  connectionString?: string,
): Promise<QueryResult> {
  const dbUrl = connectionString || process.env.DATABASE_URL;

  if (!dbUrl) {
    console.warn('[neon-client] DATABASE_URL is not configured; returning empty dataset');
    return {
      data: payload.isSingle || payload.isMaybeSingle ? null : [],
      error: null,
      count: 0,
    };
  }

  try {
    const sql = neon(dbUrl);
    const { sql: querySql, params } = buildSqlQuery(payload);

    const rows = ((await (sql as any)(querySql, params)) ?? []) as Record<string, unknown>[];

    if (payload.isSingle) {
      if (!rows || rows.length === 0) {
        return { data: null, error: { message: 'Row not found', code: 'PGRST116' } };
      }
      return { data: rows[0], error: null, count: 1 };
    }

    if (payload.isMaybeSingle) {
      return { data: rows && rows.length > 0 ? rows[0] : null, error: null, count: rows.length };
    }

    return { data: rows, error: null, count: rows.length };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[neon-client] query error on ${payload.table}:`, message);
    return { data: null, error: { message } };
  }
}

/**
 * Chainable query builder mirroring PostgREST / Supabase Client API.
 */
export class NeonQueryBuilder<T = any> implements PromiseLike<QueryResult<T>> {
  private payload: QueryPayload;
  private connectionString?: string;
  private executor?: (payload: QueryPayload) => Promise<QueryResult<T>>;

  constructor(
    table: string,
    connectionString?: string,
    executor?: (payload: QueryPayload) => Promise<QueryResult<T>>,
  ) {
    this.connectionString = connectionString;
    this.executor = executor;
    this.payload = {
      table,
      action: 'select',
      columns: '*',
      filters: [],
      orders: [],
    };
  }

  select(columns = '*', _options?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }): this {
    this.payload.columns = columns;
    return this;
  }

  insert(values: unknown): this {
    this.payload.action = 'insert';
    this.payload.values = values;
    return this;
  }

  update(values: unknown): this {
    this.payload.action = 'update';
    this.payload.values = values;
    return this;
  }

  upsert(values: unknown, options?: { onConflict?: string; ignoreDuplicates?: boolean }): this {
    this.payload.action = 'upsert';
    this.payload.values = values;
    if (options?.onConflict) this.payload.onConflict = options.onConflict;
    if (options?.ignoreDuplicates) this.payload.ignoreDuplicates = options.ignoreDuplicates;
    return this;
  }

  delete(): this {
    this.payload.action = 'delete';
    return this;
  }

  eq(column: string, value: unknown): this {
    this.payload.filters.push({ column, op: '=', value });
    return this;
  }

  neq(column: string, value: unknown): this {
    this.payload.filters.push({ column, op: '!=', value });
    return this;
  }

  gt(column: string, value: unknown): this {
    this.payload.filters.push({ column, op: '>', value });
    return this;
  }

  gte(column: string, value: unknown): this {
    this.payload.filters.push({ column, op: '>=', value });
    return this;
  }

  lt(column: string, value: unknown): this {
    this.payload.filters.push({ column, op: '<', value });
    return this;
  }

  lte(column: string, value: unknown): this {
    this.payload.filters.push({ column, op: '<=', value });
    return this;
  }

  like(column: string, pattern: string): this {
    this.payload.filters.push({ column, op: 'LIKE', value: pattern });
    return this;
  }

  ilike(column: string, pattern: string): this {
    this.payload.filters.push({ column, op: 'ILIKE', value: pattern });
    return this;
  }

  is(column: string, value: unknown): this {
    this.payload.filters.push({ column, op: 'IS', value });
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.payload.filters.push({ column, op: 'IN', value: values });
    return this;
  }

  contains(column: string, value: unknown): this {
    this.payload.filters.push({ column, op: 'contains', value });
    return this;
  }

  filter(column: string, op: string, value: unknown): this {
    const validOp = (['=', '!=', '>', '>=', '<', '<=', 'LIKE', 'ILIKE', 'IN', 'IS'] as const).find(
      (o) => o.toLowerCase() === op.toLowerCase(),
    );
    this.payload.filters.push({ column, op: validOp ?? '=', value });
    return this;
  }

  or(condition: string): this {
    // Basic support for OR expressions: e.g. "phone.ilike.%9198%,name.ilike.%test%"
    // Translate to raw SQL snippet
    const parts = condition.split(',').map((part) => {
      const match = part.trim().match(/^([a-zA-Z0-9_]+)\.(ilike|like|eq)\.(.*)$/i);
      if (match) {
        const [, col, op, val] = match;
        const safeCol = `"${col}"`;
        if (op.toLowerCase() === 'ilike') return `${safeCol} ILIKE '${val.replace(/'/g, "''")}'`;
        if (op.toLowerCase() === 'like') return `${safeCol} LIKE '${val.replace(/'/g, "''")}'`;
        if (op.toLowerCase() === 'eq') return `${safeCol} = '${val.replace(/'/g, "''")}'`;
      }
      return part;
    });
    this.payload.filters.push({ column: '', op: 'raw', value: parts.join(' OR ') });
    return this;
  }

  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): this {
    this.payload.orders.push({
      column,
      ascending: options?.ascending ?? true,
      nullsFirst: options?.nullsFirst,
    });
    return this;
  }

  limit(count: number): this {
    this.payload.limitCount = count;
    return this;
  }

  range(from: number, to: number): this {
    this.payload.offsetCount = from;
    this.payload.limitCount = to - from + 1;
    return this;
  }

  single(): this {
    this.payload.isSingle = true;
    return this;
  }

  maybeSingle(): this {
    this.payload.isMaybeSingle = true;
    return this;
  }

  async execute(): Promise<QueryResult<T>> {
    if (this.executor) {
      return this.executor(this.payload);
    }
    return executeNeonQuery(this.payload, this.connectionString) as Promise<QueryResult<T>>;
  }

  then<TResult1 = QueryResult<T>, TResult2 = never>(
    onfulfilled?: ((value: QueryResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

/**
 * Database client interface compatible with both Neon and previous Supabase patterns.
 */
export interface NeonDatabaseClient {
  from<T = any>(table: string): NeonQueryBuilder<T>;
  rpc<T = any>(name: string, args?: Record<string, unknown>): Promise<{ data: T | null; error: { message: string } | null }>;
  channel(name: string): {
    on(_event: string, _filter: unknown, _callback: (payload: any) => void): any;
    subscribe(_callback?: (status: string) => void): any;
  };
  removeChannel(_channel: unknown): Promise<void>;
  storage: {
    from(bucket: string): {
      upload(
        path: string,
        file: unknown,
        options?: { contentType?: string; upsert?: boolean; cacheControl?: string },
      ): Promise<{ error: { message: string } | null }>;
      getPublicUrl(path: string): { data: { publicUrl: string } };
      remove(paths: string[]): Promise<{ error: { message: string } | null }>;
    };
  };
  auth: {
    getUser(): Promise<{ data: { user: { id: string; email?: string; [key: string]: any } | null }; error: { message: string } | null }>;
    getSession(): Promise<{ data: { session: { user: { id: string; email?: string; [key: string]: any } | null; [key: string]: any } | null }; error: { message: string } | null }>;
    signOut(): Promise<{ error: { message: string } | null }>;
    updateUser(attributes: Record<string, unknown>): Promise<{ data: { user: unknown }; error: { message: string } | null }>;
    onAuthStateChange(_callback: (_event: string, session: any) => void): { data: { subscription: { unsubscribe: () => void } } };
  };
}

/**
 * Creates a server-side Neon database client.
 */
export function createNeonClient(connectionString?: string): NeonDatabaseClient {
  const dbUrl = connectionString || process.env.DATABASE_URL;

  return {
    from<T = any>(table: string): NeonQueryBuilder<T> {
      return new NeonQueryBuilder<T>(table, dbUrl);
    },
    async rpc<T = any>(name: string, args?: Record<string, unknown>): Promise<{ data: T | null; error: { message: string } | null }> {
      if (!dbUrl) return { data: null, error: null };
      try {
        const sql = neon(dbUrl);
        const params: unknown[] = [];
        let call = `"${name}"()`;
        if (args && Object.keys(args).length > 0) {
          const keys = Object.keys(args);
          const ph = keys.map((k, i) => {
            params.push(args[k]);
            return `$${i + 1}`;
          });
          call = `"${name}"(${ph.join(', ')})`;
        }
        const result = (await (sql as any)(`SELECT * FROM ${call}`, params)) as unknown as T;
        return { data: result, error: null };
      } catch (err: unknown) {
        return { data: null, error: { message: err instanceof Error ? err.message : String(err) } };
      }
    },
    channel() {
      return {
        on() {
          return this;
        },
        subscribe(cb?: (status: string) => void) {
          cb?.('SUBSCRIBED');
          return this;
        },
      };
    },
    async removeChannel() {},
    storage: {
      from(bucket: string) {
        return {
          async upload(path: string) {
            return { error: null };
          },
          getPublicUrl(path: string) {
            const base = process.env.WACRM_APP_URL || '';
            return { data: { publicUrl: `${base}/api/whatsapp/media/${path}` } };
          },
          async remove() {
            return { error: null };
          },
        };
      },
    },
    auth: {
      async getUser() {
        if (typeof window === 'undefined' && process.env.CLERK_SECRET_KEY) {
          try {
            const { auth } = await import('@clerk/nextjs/server');
            const clerk = await auth();
            if (clerk?.userId) {
              return {
                data: {
                  user: {
                    id: clerk.userId,
                    email: '',
                    user_metadata: {},
                  },
                },
                error: null,
              };
            }
          } catch {
            // Not in request context or auth() failed
          }
        }
        return { data: { user: null as any }, error: null as any };
      },
      async getSession() {
        return { data: { session: null as any }, error: null as any };
      },
      async signOut() {
        return { error: null as any };
      },
      async updateUser(attributes: any) {
        return { data: { user: attributes as any }, error: null as any };
      },
      onAuthStateChange(_callback?: any) {
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
  };
}
