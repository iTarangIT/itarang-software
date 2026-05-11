/**
 * E-103 — product_selections.sub_category → model_number rename + widen to
 * VARCHAR(100). Sync Audit G-05.
 *
 * AC1: After migration, product_selections has column 'model_number'
 *      (VARCHAR 100) and no 'sub_category' column.
 * AC2: Existing row data is preserved across the rename.
 * AC3: GET /api/product-selections/{id} returns the value under JSON key
 *      'modelNumber' and not 'subCategory'.
 * AC4: A 100-char string can be written to product_selections.model_number
 *      without truncation.
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, sql as dsql } from 'drizzle-orm';
import * as schema from '../../../src/lib/db/schema';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  throw new Error('DATABASE_URL must be set for E-103 API tests');
}
const sql = postgres(DB_URL, { ssl: 'require', prepare: false });
const db = drizzle(sql, { schema });

const cleanup: Array<() => Promise<void>> = [];

test.afterAll(async () => {
  for (const fn of cleanup.reverse()) {
    try {
      await fn();
    } catch (e) {
      console.error('[E-103] cleanup failed:', e);
    }
  }
  await sql.end({ timeout: 5 });
});

test('AC1 — product_selections has column model_number VARCHAR(100) and no sub_category', async () => {
  const cols = await sql<{ column_name: string; data_type: string; character_maximum_length: number | null }[]>`
    SELECT column_name, data_type, character_maximum_length
    FROM information_schema.columns
    WHERE table_name = 'product_selections'
      AND column_name IN ('sub_category', 'model_number')
  `;
  const names = cols.map((c) => c.column_name);
  expect(names).toContain('model_number');
  expect(names).not.toContain('sub_category');

  const modelCol = cols.find((c) => c.column_name === 'model_number');
  expect(modelCol?.data_type).toMatch(/character varying|varchar/i);
  expect(modelCol?.character_maximum_length).toBe(100);
});

test('AC4 — model_number accepts a 100-char string without truncation', async () => {
  // Build a minimal lead + product_selection so we can exercise insert/read.
  // Both rows clean up on teardown.
  const leadId = `E103-LEAD-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  await sql`
    INSERT INTO leads (id, dealer_id, name, phone, kyc_status)
    VALUES (${leadId}, ${'E103-DEALER'}, ${'E-103 Test'}, ${'+910000000000'}, ${'pending'})
  `;
  cleanup.push(async () => {
    await sql`DELETE FROM leads WHERE id = ${leadId}`;
  });

  const psId = `PS-E103-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const hundred = 'm'.repeat(100);
  await sql`
    INSERT INTO product_selections (id, lead_id, model_number)
    VALUES (${psId}, ${leadId}, ${hundred})
  `;
  cleanup.push(async () => {
    await sql`DELETE FROM product_selections WHERE id = ${psId}`;
  });

  const [row] = await sql<{ model_number: string }[]>`
    SELECT model_number FROM product_selections WHERE id = ${psId}
  `;
  expect(row.model_number).toBe(hundred);
  expect(row.model_number.length).toBe(100);
});
