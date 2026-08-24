/**
 * E-232 — the battery master (Battery Auction BRD §3).
 *
 * `nbfc_recovery_pipeline` stores a serial string and a stage. The BRD wants
 * serial, images, model, capacity, condition, location and recovery date per
 * recovered battery, and it wants them to survive the workflow row: a battery
 * is recovered, refurbished, auctioned, refinanced, and can come back through
 * recovery again. One battery, many pipeline passes.
 *
 * So `recovery_batteries` is the asset and `nbfc_recovery_pipeline` remains the
 * workflow position, linked by `nbfc_recovery_pipeline.battery_id`.
 */
import { db } from "@/lib/db";
import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { recoveryBatteries, nbfcRecoveryPipeline } from "@/lib/db/schema";

/**
 * Where a battery is in its own life, independent of any pipeline row.
 *
 * No pgEnum and no CHECK constraint — every status column in this family is a
 * bare varchar whose vocabulary lives in TypeScript, so it can move without a
 * migration against a drifting database. See the E-232 migration header.
 */
export const BATTERY_STATES = [
  "draft",
  "intaken",
  "inspected",
  "refurbishing",
  "ready",
  "lotted",
  "sold",
  "scrapped",
] as const;
export type BatteryState = (typeof BATTERY_STATES)[number];

/**
 * Per-item condition, carried onto the lot item at composition time.
 * `partial_working` is BRD §6's third grade. EVs slot into this same list
 * later with no schema change.
 */
export const BATTERY_CONDITIONS = [
  "new",
  "refurbished",
  "partial_working",
] as const;
export type BatteryCondition = (typeof BATTERY_CONDITIONS)[number];

/**
 * A drizzle handle or an open transaction. Callers that need this write to sit
 * inside a wider unit of work — the recovery-agent approve step writes the
 * battery, its photos and the assignment together — pass their `tx` in. Mirrors
 * `DbLike` in `auction/createLot.ts`, which solved the same problem first.
 */
export type DbLike = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface CreateBatteryInput {
  tenant_id: string;
  serial: string;
  model?: string | null;
  capacity?: string | null;
  manufacturing_date?: string | null;
  recovery_date?: string | null;
  warehouse?: string | null;
  lat?: number | null;
  lng?: number | null;
  city?: string | null;
  state?: string | null;
  loan_sanction_id?: string | null;
  recovery_pipeline_id?: string | null;
  notes?: string | null;
  /** Drizzle handle or transaction. Defaults to the singleton `db`. */
  executor?: DbLike;
}

export interface BatteryRow {
  id: string;
  tenant_id: string;
  serial: string;
  model: string | null;
  capacity: string | null;
  manufacturing_date: string | null;
  condition_grade: string | null;
  recovery_date: string | null;
  warehouse: string | null;
  lat: number | null;
  lng: number | null;
  city: string | null;
  state: string | null;
  loan_sanction_id: string | null;
  recovery_pipeline_id: string | null;
  image_urls: string[];
  state_code: string;
  notes: string | null;
  created_at: string;
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function iso(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function shape(row: typeof recoveryBatteries.$inferSelect): BatteryRow {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    serial: row.serial,
    model: row.model ?? null,
    capacity: row.capacity ?? null,
    manufacturing_date: row.manufacturing_date ?? null,
    condition_grade: row.condition_grade ?? null,
    recovery_date: iso(row.recovery_date),
    warehouse: row.warehouse ?? null,
    lat: toNum(row.lat),
    lng: toNum(row.lng),
    city: row.city ?? null,
    state: row.state ?? null,
    loan_sanction_id: row.loan_sanction_id ?? null,
    recovery_pipeline_id: row.recovery_pipeline_id ?? null,
    image_urls: row.image_urls ?? [],
    state_code: row.state_code,
    notes: row.notes ?? null,
    created_at: iso(row.created_at) ?? "",
  };
}

/**
 * Creates the battery row for a physical unit arriving at a collection centre.
 *
 * The serial is globally unique, so a re-intake of a battery that has been
 * through recovery before must NOT insert a second row — it re-uses the
 * existing asset and moves it back to `intaken`. That is the whole reason this
 * table is separate from the pipeline: the second recovery of one battery is a
 * new workflow, not a new asset.
 */
export async function createRecoveryBattery(
  input: CreateBatteryInput,
): Promise<{ battery: BatteryRow; reused: boolean }> {
  const x = input.executor ?? db;
  const serial = input.serial.trim();
  if (!serial) throw new Error("BAD_REQUEST: serial must not be empty");

  const existing = await x
    .select()
    .from(recoveryBatteries)
    .where(eq(recoveryBatteries.serial, serial))
    .limit(1);

  let battery: typeof recoveryBatteries.$inferSelect;
  let reused: boolean;

  if (existing.length > 0) {
    const prior = existing[0];
    // A battery that belongs to another NBFC is not ours to re-intake. Saying
    // so plainly beats a unique-violation stack trace, which is what the caller
    // would otherwise see and would read as a bug rather than a rule.
    if (prior.tenant_id !== input.tenant_id) {
      throw new Error(
        `CONFLICT: battery ${serial} is already registered to another NBFC`,
      );
    }
    // [FIX] And a battery already tied to a DIFFERENT loan is not ours to move
    // either. This used to overwrite `loan_sanction_id` with whatever arrived,
    // which was harmless while the only caller was the recovery flag — the
    // serial came off the loan record itself and could not disagree. It stops
    // being harmless the moment a serial is TYPED: a recovery agent standing in
    // front of a battery, entering it on their phone, is one transposed digit
    // away from silently re-registering another borrower's asset against this
    // loan. Re-intake of the SAME loan is still the normal path and still works.
    if (
      input.loan_sanction_id &&
      prior.loan_sanction_id &&
      prior.loan_sanction_id !== input.loan_sanction_id
    ) {
      throw new Error(
        `CONFLICT: battery ${serial} is already registered against loan ${prior.loan_sanction_id}`,
      );
    }
    const [updated] = await x
      .update(recoveryBatteries)
      .set({
        state_code: "intaken",
        recovery_date: input.recovery_date ? new Date(input.recovery_date) : new Date(),
        recovery_pipeline_id: input.recovery_pipeline_id ?? prior.recovery_pipeline_id,
        loan_sanction_id: input.loan_sanction_id ?? prior.loan_sanction_id,
        warehouse: input.warehouse ?? prior.warehouse,
        lat: input.lat != null ? String(input.lat) : prior.lat,
        lng: input.lng != null ? String(input.lng) : prior.lng,
        city: input.city ?? prior.city,
        state: input.state ?? prior.state,
        updated_at: new Date(),
      })
      .where(eq(recoveryBatteries.id, prior.id))
      .returning();
    battery = updated;
    reused = true;
  } else {
    const [created] = await x
      .insert(recoveryBatteries)
      .values({
        tenant_id: input.tenant_id,
        serial,
        model: input.model ?? null,
        capacity: input.capacity ?? null,
        manufacturing_date: input.manufacturing_date ?? null,
        recovery_date: input.recovery_date ? new Date(input.recovery_date) : new Date(),
        warehouse: input.warehouse ?? null,
        lat: input.lat != null ? String(input.lat) : null,
        lng: input.lng != null ? String(input.lng) : null,
        city: input.city ?? null,
        state: input.state ?? null,
        loan_sanction_id: input.loan_sanction_id ?? null,
        recovery_pipeline_id: input.recovery_pipeline_id ?? null,
        notes: input.notes ?? null,
        state_code: "intaken",
      })
      .returning();
    battery = created;
    reused = false;
  }

  // Keep the two sides of the link in step. The pipeline row is the workflow
  // position and it needs to point at the asset for the settlement join that
  // replaced the old battery_serial == lot_code string match.
  //
  // [FIX] This used to sit inside the INSERT branch only, so a battery that
  // came back through recovery a second time — the exact case the reuse branch
  // exists for — left `nbfc_recovery_pipeline.battery_id` NULL. Two things
  // downstream read that column and quietly do nothing without it:
  // `recordEvaluation` only updates the battery master `if (batteryId)`, and
  // `publishLotFromRecovery` builds the lot item from `pipeline.battery_id`. A
  // re-recovered battery could therefore be inspected and photographed and then
  // never be sellable, with no error anywhere to explain why.
  if (input.recovery_pipeline_id) {
    await x
      .update(nbfcRecoveryPipeline)
      .set({ battery_id: battery.id, updated_at: new Date() })
      .where(eq(nbfcRecoveryPipeline.id, input.recovery_pipeline_id));
  }

  return { battery: shape(battery), reused };
}

export async function getBattery(
  tenant_id: string,
  battery_id: string,
  executor?: DbLike,
): Promise<BatteryRow | null> {
  const rows = await (executor ?? db)
    .select()
    .from(recoveryBatteries)
    .where(
      and(
        eq(recoveryBatteries.id, battery_id),
        eq(recoveryBatteries.tenant_id, tenant_id),
      ),
    )
    .limit(1);
  return rows.length ? shape(rows[0]) : null;
}

export interface ListBatteriesInput {
  tenant_id: string;
  state_code?: BatteryState | "all";
  warehouse?: string;
  /** Free text over serial and model. */
  q?: string;
  page?: number;
  pageSize?: number;
}

export async function listBatteries(input: ListBatteriesInput): Promise<{
  items: BatteryRow[];
  page: number;
  total: number;
}> {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 50;

  const conditions = [
    eq(recoveryBatteries.tenant_id, input.tenant_id),
    input.state_code && input.state_code !== "all"
      ? eq(recoveryBatteries.state_code, input.state_code)
      : undefined,
    input.warehouse ? eq(recoveryBatteries.warehouse, input.warehouse) : undefined,
    input.q
      ? or(
          ilike(recoveryBatteries.serial, `%${input.q}%`),
          ilike(recoveryBatteries.model, `%${input.q}%`),
        )
      : undefined,
  ].filter(Boolean);

  const where = and(...conditions);

  const rows = await db
    .select()
    .from(recoveryBatteries)
    .where(where)
    .orderBy(desc(recoveryBatteries.created_at))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const [{ c }] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(recoveryBatteries)
    .where(where);

  return { items: rows.map(shape), page, total: Number(c ?? 0) };
}

/**
 * Tenant-wide tallies for the register's summary strip.
 *
 * Deliberately IGNORES the caller's state/search filters: these are the "how
 * much stock do I hold" numbers, and a count that shrank every time someone
 * typed in the search box would be answering a different question. One
 * grouped scan rather than nine `count(*)` round trips.
 *
 * `awaiting_photos` counts the batteries a dealer could not bid on today —
 * the photographs are the whole auction listing, so a battery without them is
 * stock that cannot be sold, which is the one number worth alarming on.
 */
export async function batteryCounts(tenant_id: string): Promise<{
  total: number;
  awaiting_photos: number;
  by_state: Record<string, number>;
}> {
  const rows = await db
    .select({
      state_code: recoveryBatteries.state_code,
      c: sql<number>`count(*)::int`,
      no_photos: sql<number>`count(*) filter (where coalesce(array_length(${recoveryBatteries.image_urls}, 1), 0) = 0)::int`,
    })
    .from(recoveryBatteries)
    .where(eq(recoveryBatteries.tenant_id, tenant_id))
    .groupBy(recoveryBatteries.state_code);

  const by_state: Record<string, number> = {};
  let total = 0;
  let awaiting_photos = 0;
  for (const r of rows) {
    const n = Number(r.c ?? 0);
    by_state[r.state_code] = n;
    total += n;
    awaiting_photos += Number(r.no_photos ?? 0);
  }
  return { total, awaiting_photos, by_state };
}

/**
 * Appends photo paths to the battery.
 *
 * APPENDS, never replaces. Photos arrive one request per file from the intake
 * and inspection screens, and a replacing write would mean the last upload of a
 * five-shot set silently discarded the other four. The array is deduplicated
 * because a retried upload is a normal event, not an error.
 *
 * The values stored are RELATIVE `/api/files/<bucket>/<key>` paths. Never an
 * absolute URL: the storage backend flips between Supabase and S3 behind
 * STORAGE_BACKEND, and a signed or bucket-specific URL would rot.
 */
export async function attachBatteryPhotos(
  tenant_id: string,
  battery_id: string,
  paths: string[],
  executor?: DbLike,
): Promise<BatteryRow> {
  const x = executor ?? db;
  if (paths.length === 0) {
    const current = await getBattery(tenant_id, battery_id, executor);
    if (!current) throw new Error("NOT_FOUND: battery not found");
    return current;
  }

  // NOTE ON THE ARRAY LITERAL: drizzle's `sql` template expands a JS array into
  // a record tuple `($1,$2,$3)`, NOT a Postgres array, and `(...)::text[]`
  // fails with `42846 cannot cast type record to text[]`. Each element is
  // therefore parameterised individually and joined into an explicit
  // ARRAY[...] — still fully parameterised, no interpolation.
  const pathsArray = sql`ARRAY[${sql.join(
    paths.map((p) => sql`${p}`),
    sql`, `,
  )}]::text[]`;

  const [updated] = await x
    .update(recoveryBatteries)
    .set({
      image_urls: sql`(
        SELECT COALESCE(array_agg(DISTINCT u), '{}')
          FROM unnest(${recoveryBatteries.image_urls} || ${pathsArray}) AS u
      )`,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(recoveryBatteries.id, battery_id),
        eq(recoveryBatteries.tenant_id, tenant_id),
      ),
    )
    .returning();

  if (!updated) throw new Error("NOT_FOUND: battery not found");
  return shape(updated);
}

/**
 * Moves a battery to a new state. Deliberately permissive about ordering — the
 * ordering rules live in the recovery stage machine (`stages.ts`), which is the
 * one place they are enforced, and duplicating them here would create a second
 * disagreeing copy. This repo already has one of those: `RecoveryKanban.tsx`
 * and the deleted `RecoveryPipelineBoard.tsx` shipped contradicting transition
 * maps.
 */
export async function setBatteryState(
  tenant_id: string,
  battery_id: string,
  state_code: BatteryState,
  condition_grade?: BatteryCondition | null,
): Promise<BatteryRow> {
  const [updated] = await db
    .update(recoveryBatteries)
    .set({
      state_code,
      ...(condition_grade !== undefined ? { condition_grade } : {}),
      updated_at: new Date(),
    })
    .where(
      and(
        eq(recoveryBatteries.id, battery_id),
        eq(recoveryBatteries.tenant_id, tenant_id),
      ),
    )
    .returning();

  if (!updated) throw new Error("NOT_FOUND: battery not found");
  return shape(updated);
}

/**
 * Batteries eligible to be put into a lot, for the lot-composition picker.
 *
 * Two conditions, not one. The state check is the obvious half: only inspected
 * or ready stock can be sold. The NOT EXISTS is the half that was missing, and
 * without it the picker offered batteries that are already on a live auction.
 *
 * `state_code = 'lotted'` was doing that job alone, on the assumption that
 * everything which reaches a lot passes through composeLot/addLotItems, which
 * set it. `publishLotFromRecovery()` does not — a battery dragged to
 * `ready_for_auction` on the recovery board gets an auto-seeded draft lot while
 * its own row stays `inspected`. Asking `auction_lot_items` directly is the
 * answer that does not depend on every writer remembering to flip a flag, and
 * it is the same rule composeLot enforces when the operator finally clicks Add,
 * so the picker no longer offers something the server will refuse.
 *
 * A lot the operator is editing right now is caught by this too; the composer
 * merges its own items back in from the lot detail (see LotComposer).
 */
export async function listLottableBatteries(
  tenant_id: string,
): Promise<BatteryRow[]> {
  const rows = await db
    .select()
    .from(recoveryBatteries)
    .where(
      and(
        eq(recoveryBatteries.tenant_id, tenant_id),
        inArray(recoveryBatteries.state_code, ["ready", "inspected"]),
        sql`NOT EXISTS (
          SELECT 1
            FROM auction_lot_items ali
            JOIN auction_lots al ON al.id = ali.lot_id
           WHERE ali.battery_id = ${recoveryBatteries.id}
             AND al.status IN ('draft', 'scheduled', 'live', 'paused')
        )`,
      ),
    )
    .orderBy(desc(recoveryBatteries.updated_at));
  return rows.map(shape);
}
