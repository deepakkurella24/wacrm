import { describe, expect, it } from 'vitest';
import { buildSqlQuery, NeonQueryBuilder } from './neon-client';

describe('Neon Query Builder — SQL Translation', () => {
  it('translates simple SELECT with eq filter', () => {
    const { sql, params } = buildSqlQuery({
      table: 'contacts',
      action: 'select',
      columns: '*',
      filters: [{ column: 'phone', op: '=', value: '919876543210' }],
      orders: [],
    });

    expect(sql).toBe('SELECT * FROM "contacts" WHERE "phone" = $1');
    expect(params).toEqual(['919876543210']);
  });

  it('translates SELECT with multiple filters, ordering, and limit', () => {
    const { sql, params } = buildSqlQuery({
      table: 'messages',
      action: 'select',
      columns: 'id, conversation_id, content_text',
      filters: [
        { column: 'account_id', op: '=', value: 'acc-1' },
        { column: 'status', op: '!=', value: 'failed' },
      ],
      orders: [{ column: 'created_at', ascending: false }],
      limitCount: 50,
      offsetCount: 0,
    });

    expect(sql).toBe(
      'SELECT "id", "conversation_id", "content_text" FROM "messages" WHERE "account_id" = $1 AND "status" != $2 ORDER BY "created_at" DESC LIMIT 50 OFFSET 0',
    );
    expect(params).toEqual(['acc-1', 'failed']);
  });

  it('translates IN and IS NULL filters', () => {
    const { sql, params } = buildSqlQuery({
      table: 'contacts',
      action: 'select',
      columns: '*',
      filters: [
        { column: 'id', op: 'IN', value: ['id-1', 'id-2'] },
        { column: 'archived_at', op: 'IS', value: null },
      ],
      orders: [],
    });

    expect(sql).toBe('SELECT * FROM "contacts" WHERE "id" IN ($1, $2) AND "archived_at" IS NULL');
    expect(params).toEqual(['id-1', 'id-2']);
  });

  it('translates INSERT with RETURNING *', () => {
    const { sql, params } = buildSqlQuery({
      table: 'tags',
      action: 'insert',
      columns: '*',
      values: { name: 'VIP', color: '#ff0000', account_id: 'acc-1' },
      filters: [],
      orders: [],
    });

    expect(sql).toBe(
      'INSERT INTO "tags" ("name", "color", "account_id") VALUES ($1, $2, $3) RETURNING *',
    );
    expect(params).toEqual(['VIP', '#ff0000', 'acc-1']);
  });

  it('translates UPDATE with WHERE and RETURNING', () => {
    const { sql, params } = buildSqlQuery({
      table: 'conversations',
      action: 'update',
      columns: 'id, status',
      values: { status: 'closed' },
      filters: [{ column: 'id', op: '=', value: 'conv-123' }],
      orders: [],
    });

    expect(sql).toBe('UPDATE "conversations" SET "status" = $1 WHERE "id" = $2 RETURNING id, status');
    expect(params).toEqual(['closed', 'conv-123']);
  });

  it('translates UPSERT with conflict target', () => {
    const { sql, params } = buildSqlQuery({
      table: 'whatsapp_config',
      action: 'upsert',
      columns: '*',
      values: { account_id: 'acc-1', phone_number_id: '12345' },
      filters: [],
      orders: [],
      onConflict: 'account_id',
    });

    expect(sql).toContain('ON CONFLICT (account_id) DO UPDATE SET');
    expect(params).toEqual(['acc-1', '12345']);
  });

  it('translates DELETE with WHERE', () => {
    const { sql, params } = buildSqlQuery({
      table: 'contact_tags',
      action: 'delete',
      columns: '*',
      filters: [
        { column: 'contact_id', op: '=', value: 'c-1' },
        { column: 'tag_id', op: '=', value: 't-1' },
      ],
      orders: [],
    });

    expect(sql).toBe('DELETE FROM "contact_tags" WHERE "contact_id" = $1 AND "tag_id" = $2 RETURNING *');
    expect(params).toEqual(['c-1', 't-1']);
  });

  it('supports nested contacts join on conversations table', () => {
    const { sql } = buildSqlQuery({
      table: 'conversations',
      action: 'select',
      columns: '*, contact:contacts(*)',
      filters: [{ column: 'id', op: '=', value: 'conv-1' }],
      orders: [],
    });

    expect(sql).toContain('LEFT JOIN "contacts" ct ON ct.id = c.contact_id');
    expect(sql).toContain('row_to_json(ct.*) AS contact');
  });
});
