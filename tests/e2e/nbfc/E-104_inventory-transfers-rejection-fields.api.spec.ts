/**
 * E-104 — inventory_transfers bundled spec (BRD §6.S.5 / Sync Audit G-06).
 *
 * Schema-only unit. The four ACs all verify migration result by introspecting
 * `information_schema` and exercising the constraints via raw INSERTs. No
 * application code (route, page, job) is part of this unit — the
 * reject-transfer API itself is owned by Sec6.S.5 and ships separately.
 *
 *   AC1: inventory_transfers exists with the full BRD column set
 *        (id, transfer_id, source_dealer_id, target_dealer_id, serials,
 *         reason, status, initiated_by, initiated_at, acknowledged_by,
 *         acknowledged_at, rejected_by, rejected_at, rejection_reason).
 *   AC2: status accepts each of the four BRD-defined values
 *        ('pending_acknowledgement', 'completed', 'rejected_by_target',
 *         'cancelled_by_admin'); INSERTs with each succeed; INSERT with an
 *        unknown value is rejected by the CHECK constraint.
 *   AC3: rejection columns enforced as a triplet — INSERTs with any partial
 *        subset of (rejected_by, rejected_at, rejection_reason) populated
 *        violate the all-or-nothing CHECK constraint (SQLSTATE 23514).
 *   AC4: transfer_id UNIQUE constraint — inserting two rows with the same
 *        transfer_id raises Postgres error 23505 (unique violation).
 *
 * Re-uses the same DATABASE_URL pattern as E-047/E-091 — talks straight to
 * Postgres via postgres-js, not through any HTTP route.
 */
import { test, expect } from '@playwright/test';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  throw new Error('DATABASE_URL must be set for E-104 schema tests');
}

const sql = postgres(DB_URL, { ssl: 'require', prepare: false });

const REQUIRED_COLUMNS = [
  'id',
  'transfer_id',
  'source_dealer_id',
  'target_dealer_id',
  'serials',
  'reason',
  'status',
  'initiated_by',
  'initiated_at',
  'acknowledged_by',
  'acknowledged_at',
  'rejected_by',
  'rejected_at',
  'rejection_reason',
] as const;

// transfer_id column is VARCHAR(50). We pack into < 50 chars.
// Format: TRF-<8hex>-<2digit-seq><6prefixchars> ≈ 4+1+8+1+2+6 = 22 chars max.
const RUN_ID = randomUUID().replace(/-/g, '').slice(0, 8);
const seededTransferIds: string[] = [];

function seedTransferId(prefix: string): string {
  const seq = String(seededTransferIds.length).padStart(2, '0');
  const safePrefix = prefix.replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
  const tid = `TRF-${RUN_ID}-${seq}${safePrefix}`;
  if (tid.length > 50) {
    throw new Error(`transfer_id "${tid}" longer than 50 chars`);
  }
  seededTransferIds.push(tid);
  return tid;
}

test.afterAll(async () => {
  for (const tid of seededTransferIds) {
    await sql`DELETE FROM inventory_transfers WHERE transfer_id = ${tid}`.catch(
      () => {},
    );
  }
  await sql.end({ timeout: 5 }).catch(() => {});
});

test.describe('E-104 — inventory_transfers bundled schema', () => {
  test('AC1: inventory_transfers exists with full BRD column set', async () => {
    const cols = await sql<{ column_name: string; data_type: string; is_nullable: string }[]>`
      SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'inventory_transfers'
    `;
    expect(cols.length).toBeGreaterThan(0);
    const found = new Set(cols.map((c) => c.column_name));
    for (const col of REQUIRED_COLUMNS) {
      expect(
        found.has(col),
        `expected inventory_transfers.${col} to exist`,
      ).toBe(true);
    }

    // The three rejection columns must be NULLABLE (so existing rows in the
    // non-rejected states satisfy the all-or-nothing triplet CHECK).
    const byName = new Map(cols.map((c) => [c.column_name, c]));
    expect(byName.get('rejected_by')!.is_nullable).toBe('YES');
    expect(byName.get('rejected_at')!.is_nullable).toBe('YES');
    expect(byName.get('rejection_reason')!.is_nullable).toBe('YES');

    // status / transfer_id / source_dealer_id / target_dealer_id / serials /
    // initiated_by / initiated_at must be NOT NULL.
    expect(byName.get('status')!.is_nullable).toBe('NO');
    expect(byName.get('transfer_id')!.is_nullable).toBe('NO');
    expect(byName.get('source_dealer_id')!.is_nullable).toBe('NO');
    expect(byName.get('target_dealer_id')!.is_nullable).toBe('NO');
    expect(byName.get('serials')!.is_nullable).toBe('NO');
    expect(byName.get('initiated_by')!.is_nullable).toBe('NO');
    expect(byName.get('initiated_at')!.is_nullable).toBe('NO');
  });

  test('AC2: status accepts all four BRD states', async () => {
    const states = [
      'pending_acknowledgement',
      'completed',
      'rejected_by_target',
      'cancelled_by_admin',
    ] as const;
    for (const s of states) {
      const tid = seedTransferId(`s-${s}`);
      // For 'rejected_by_target' the triplet must be populated (AC3 covers
      // this); for the other three states the triplet must be NULL.
      if (s === 'rejected_by_target') {
        await sql`
          INSERT INTO inventory_transfers (
            transfer_id, source_dealer_id, target_dealer_id, serials,
            status, initiated_by, rejected_by, rejected_at, rejection_reason
          ) VALUES (
            ${tid}, 1, 2, ${sql.json(['SN-A'])},
            ${s}, 1, 99, NOW(), ${'auto-test rejection reason'}
          )
        `;
      } else {
        await sql`
          INSERT INTO inventory_transfers (
            transfer_id, source_dealer_id, target_dealer_id, serials,
            status, initiated_by
          ) VALUES (
            ${tid}, 1, 2, ${sql.json(['SN-A'])},
            ${s}, 1
          )
        `;
      }
      const row = await sql<{ status: string }[]>`
        SELECT status FROM inventory_transfers WHERE transfer_id = ${tid}
      `;
      expect(row[0]?.status).toBe(s);
    }

    // An unknown status value must be rejected by the CHECK constraint
    // (23514 = check_violation).
    const badTid = seedTransferId('s-bogus');
    let caught: { code?: string } | null = null;
    try {
      await sql`
        INSERT INTO inventory_transfers (
          transfer_id, source_dealer_id, target_dealer_id, serials,
          status, initiated_by
        ) VALUES (
          ${badTid}, 1, 2, ${sql.json(['SN-A'])},
          ${'NOT_A_REAL_STATE'}, 1
        )
      `;
    } catch (e) {
      caught = e as { code?: string };
    }
    expect(caught, 'expected unknown status to violate CHECK').not.toBeNull();
    expect(caught!.code).toBe('23514');
  });

  test('AC3: rejection columns enforced as an all-or-nothing triplet', async () => {
    // Three partial-subset cases: only rejected_by, only rejected_at, two of three.
    const cases: Array<{
      label: string;
      rejected_by: number | null;
      rejected_at: 'now' | null;
      rejection_reason: string | null;
    }> = [
      {
        label: 'only-rejected_by',
        rejected_by: 1,
        rejected_at: null,
        rejection_reason: null,
      },
      {
        label: 'only-rejected_at',
        rejected_by: null,
        rejected_at: 'now',
        rejection_reason: null,
      },
      {
        label: 'two-of-three',
        rejected_by: 1,
        rejected_at: 'now',
        rejection_reason: null,
      },
    ];

    for (const c of cases) {
      const tid = seedTransferId(`t-${c.label}`);
      let caught: { code?: string } | null = null;
      try {
        // Use raw text expressions so we can pass NULL/NOW() literally.
        const ra =
          c.rejected_at === 'now'
            ? sql`NOW()`
            : sql`NULL::timestamptz`;
        await sql`
          INSERT INTO inventory_transfers (
            transfer_id, source_dealer_id, target_dealer_id, serials,
            status, initiated_by,
            rejected_by, rejected_at, rejection_reason
          ) VALUES (
            ${tid}, 1, 2, ${sql.json(['SN-A'])},
            ${'pending_acknowledgement'}, 1,
            ${c.rejected_by}, ${ra}, ${c.rejection_reason}
          )
        `;
      } catch (e) {
        caught = e as { code?: string };
      }
      expect(
        caught,
        `expected partial triplet "${c.label}" to violate CHECK`,
      ).not.toBeNull();
      expect(caught!.code).toBe('23514');
    }

    // Sanity: all-three-NULL succeeds.
    const ok1 = seedTransferId('t-all-null');
    await sql`
      INSERT INTO inventory_transfers (
        transfer_id, source_dealer_id, target_dealer_id, serials,
        status, initiated_by
      ) VALUES (
        ${ok1}, 1, 2, ${sql.json(['SN-A'])},
        ${'pending_acknowledgement'}, 1
      )
    `;
    // Sanity: all-three-non-null succeeds.
    const ok2 = seedTransferId('t-all-set');
    await sql`
      INSERT INTO inventory_transfers (
        transfer_id, source_dealer_id, target_dealer_id, serials,
        status, initiated_by, rejected_by, rejected_at, rejection_reason
      ) VALUES (
        ${ok2}, 1, 2, ${sql.json(['SN-A'])},
        ${'rejected_by_target'}, 1, 7, NOW(), ${'damaged on arrival'}
      )
    `;
    const rows = await sql`
      SELECT transfer_id FROM inventory_transfers
      WHERE transfer_id IN (${ok1}, ${ok2})
    `;
    expect(rows.length).toBe(2);
  });

  test('AC4: transfer_id UNIQUE constraint enforced', async () => {
    const tid = seedTransferId('u-dupe');
    await sql`
      INSERT INTO inventory_transfers (
        transfer_id, source_dealer_id, target_dealer_id, serials,
        status, initiated_by
      ) VALUES (
        ${tid}, 1, 2, ${sql.json(['SN-A'])},
        ${'pending_acknowledgement'}, 1
      )
    `;
    let caught: { code?: string } | null = null;
    try {
      await sql`
        INSERT INTO inventory_transfers (
          transfer_id, source_dealer_id, target_dealer_id, serials,
          status, initiated_by
        ) VALUES (
          ${tid}, 1, 2, ${sql.json(['SN-A'])},
          ${'pending_acknowledgement'}, 1
        )
      `;
    } catch (e) {
      caught = e as { code?: string };
    }
    expect(caught, 'expected duplicate transfer_id insert to throw').not.toBeNull();
    // 23505 = unique_violation.
    expect(caught!.code).toBe('23505');
  });
});
