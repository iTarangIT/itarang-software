/**
 * E-270 / E-271 — refurbishment LOTS: the NBFC ⇄ iTarang workshop loop, as writes.
 *
 * Every function here is one MOVE on a lot: it loads the lot, asserts the move
 * is legal from its status (refurbishment-lot-status.ts), and then, in ONE
 * transaction, updates the lot header, the jobs it carries, the batteries and
 * pipeline rows behind them, writes an nbfc_audit_log row, and appends the
 * move to refurbishment_lot_events. The route that called it then sends the
 * notification (refurbish-notify.ts) — outside the transaction, same as scrap.
 *
 * WHAT THE BATTERY DOES AT EACH MOVE
 *   createLot          inspected -> refurbishing, pipeline -> refurbishable
 *   decline / cancel   -> inspected, pipeline -> needs_inspection
 *   money / pickup / dispatch / arrive / receipt / work / ready   (no change)
 *   NBFC receipt `received`       -> ready + grade refurbished,
 *                                    pipeline -> ready_for_auction
 *
 * The last row is the whole point: the NBFC signing for the battery is what
 * sets the job `returned`, and `returned` is the only status
 * refurbishmentCostForBatteries() counts — so the repair cost rolls into the
 * auction base price at exactly the moment the battery is back in the NBFC's
 * hands and eligible for a lot.
 *
 * E-271 added the money legs (advance / balance — see refurb-payments.ts for
 * the Razorpay + offline write path), the pickup / arrival steps, the frozen
 * approved quote with its revision round, and derived custody per battery.
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  refurbishmentLots,
  refurbishmentLotEvents,
  refurbishmentJobs,
  recoveryBatteries,
  nbfcRecoveryPipeline,
  nbfcBatteryEvaluations,
  nbfcAuditLog,
  nbfcTenants,
} from "@/lib/db/schema";
import { assertSohAllowsStage, SOH_REFURBISHABLE_MIN } from "@/lib/nbfc/recovery/stages";
import {
  REQUIRED_ACCESSORIES,
  OPEN_STATUSES,
  accessoriesTotal,
  num,
  iso,
  shapeJob,
  type AccessoryLine,
  type ChecklistItem,
  type RefurbishmentJobRow,
} from "@/lib/nbfc/recovery/refurbishment";
import {
  assertLotMove,
  awaitingParty,
  allOpenItemsReady,
  custodyForItem,
  nextAfterAgreed,
  nextAfterAdvance,
  nextAfterReceipt,
  withinApprovedQuote,
  CANCELLABLE_LOT_STATUSES,
  OPEN_LOT_STATUSES,
  LOT_STATUSES,
  PICKUP_MODES,
  type Custody,
  type LotStatus,
  type Party,
  type PickupMode,
  type EventKind,
  type ReceiptCondition,
} from "@/lib/nbfc/recovery/refurbishment-lot-status";

export type LotRow = typeof refurbishmentLots.$inferSelect;
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ---------------------------------------------------------------------------
// Shapes the API returns
// ---------------------------------------------------------------------------
export interface LotEvent {
  id: string;
  seq: number;
  party: "nbfc" | "admin" | "system";
  kind: EventKind | string;
  message: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface LotItem extends RefurbishmentJobRow {
  model: string | null;
  capacity: string | null;
  condition_grade: string | null;
  soh_pct: number | null;
  image_urls: string[];
  battery_state: string | null;
  /** [E-271] Where this battery physically is, derived. */
  custody: Custody;
}

export interface Leg {
  carrier: string | null;
  vehicle_no: string | null;
  docket_no: string | null;
  eway_bill_no: string | null;
  eway_bill_url: string | null;
  dispatched_on: string | null;
  dispatch_note: string | null;
  photo_urls: string[];
  dispatched_at: string | null;
  picked_up_at: string | null;
  delivered_at: string | null;
  received_at: string | null;
  receipt_note: string | null;
  receipt_photo_urls: string[];
  has_mismatch: boolean;
}

export interface MoneyLeg {
  amount: number | null;
  /** not_required|pending|recorded|confirmed (advance) · not_due|pending|recorded|confirmed (balance) */
  status: string;
  provider: string | null;
  order_id: string | null;
  payment_id: string | null;
  reference: string | null;
  recorded_at: string | null;
  confirmed_at: string | null;
}

export interface Lot {
  id: string;
  ref_code: string;
  tenant_id: string;
  tenant_name: string | null;
  status: LotStatus;
  /** Who owes the next move. */
  awaiting: Party | null;
  battery_count: number;
  note: string | null;
  current_round: number;
  last_party: Party | null;
  expected_receipt_date: string | null;
  expected_return_date: string | null;
  estimated_labour_total: number | null;
  estimated_accessories_total: number | null;
  estimated_total: number | null;
  proposal_note: string | null;
  agreed_at: string | null;
  // E-271
  pickup_mode: PickupMode;
  pickup_address: string | null;
  workshop_address: string | null;
  scheduled_pickup_date: string | null;
  quote_approved_total: number | null;
  quote_approved_at: string | null;
  revised_total: number | null;
  revision_note: string | null;
  revision_round: number;
  advance_pct: number;
  advance: MoneyLeg;
  final_total: number | null;
  balance: MoneyLeg;
  settled_at: string | null;
  out: Leg;
  ret: Leg;
  work_started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancelled_by_party: Party | null;
  cancel_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface LotDetail extends Lot {
  items: LotItem[];
  events: LotEvent[];
  /** Sum of actual (or estimated) labour + included accessories over live items. */
  actual_total: number | null;
  /** [E-271] actual_total > quote_approved_total → admin must send a revision. */
  over_approved_quote: boolean;
}

function leg(row: LotRow, p: "out" | "ret"): Leg {
  const r = row as unknown as Record<string, unknown>;
  return {
    carrier: (r[`${p}_carrier`] as string | null) ?? null,
    vehicle_no: (r[`${p}_vehicle_no`] as string | null) ?? null,
    docket_no: (r[`${p}_docket_no`] as string | null) ?? null,
    eway_bill_no: (r[`${p}_eway_bill_no`] as string | null) ?? null,
    eway_bill_url: (r[`${p}_eway_bill_url`] as string | null) ?? null,
    dispatched_on: iso(r[`${p}_dispatched_on`]),
    dispatch_note: (r[`${p}_dispatch_note`] as string | null) ?? null,
    photo_urls: (r[`${p}_photo_urls`] as string[] | null) ?? [],
    dispatched_at: iso(r[`${p}_dispatched_at`]),
    picked_up_at: p === "out" ? iso(r.out_picked_up_at) : null,
    delivered_at: iso(r[`${p}_delivered_at`]),
    received_at: iso(r[`${p}_received_at`]),
    receipt_note: (r[`${p}_receipt_note`] as string | null) ?? null,
    receipt_photo_urls: (r[`${p}_receipt_photo_urls`] as string[] | null) ?? [],
    has_mismatch: Boolean(r[`${p}_has_mismatch`]),
  };
}

function money(row: LotRow, p: "advance" | "balance"): MoneyLeg {
  const r = row as unknown as Record<string, unknown>;
  return {
    amount: num(r[`${p}_amount`]),
    status: String(r[`${p}_status`] ?? (p === "advance" ? "not_required" : "not_due")),
    provider: (r[`${p}_provider`] as string | null) ?? null,
    order_id: (r[`${p}_order_id`] as string | null) ?? null,
    payment_id: (r[`${p}_payment_id`] as string | null) ?? null,
    reference: (r[`${p}_reference`] as string | null) ?? null,
    recorded_at: iso(r[`${p}_recorded_at`]),
    confirmed_at: iso(r[`${p}_confirmed_at`]),
  };
}

export function shapeLot(row: LotRow, tenant_name: string | null): Lot {
  return {
    id: row.id,
    ref_code: row.ref_code,
    tenant_id: row.tenant_id,
    tenant_name,
    status: row.status as LotStatus,
    awaiting: awaitingParty(row.status, {
      advance_status: row.advance_status,
      balance_status: row.balance_status,
    }),
    battery_count: row.battery_count,
    note: row.note ?? null,
    current_round: row.current_round,
    last_party: (row.last_party as Party | null) ?? null,
    expected_receipt_date: iso(row.expected_receipt_date),
    expected_return_date: iso(row.expected_return_date),
    estimated_labour_total: num(row.estimated_labour_total),
    estimated_accessories_total: num(row.estimated_accessories_total),
    estimated_total: num(row.estimated_total),
    proposal_note: row.proposal_note ?? null,
    agreed_at: iso(row.agreed_at),
    pickup_mode: (row.pickup_mode as PickupMode) ?? "nbfc_ships",
    pickup_address: row.pickup_address ?? null,
    workshop_address: row.workshop_address ?? null,
    scheduled_pickup_date: iso(row.scheduled_pickup_date),
    quote_approved_total: num(row.quote_approved_total),
    quote_approved_at: iso(row.quote_approved_at),
    revised_total: num(row.revised_total),
    revision_note: row.revision_note ?? null,
    revision_round: row.revision_round ?? 0,
    advance_pct: num(row.advance_pct) ?? 0,
    advance: money(row, "advance"),
    final_total: num(row.final_total),
    balance: money(row, "balance"),
    settled_at: iso(row.settled_at),
    out: leg(row, "out"),
    ret: leg(row, "ret"),
    work_started_at: iso(row.work_started_at),
    completed_at: iso(row.completed_at),
    cancelled_at: iso(row.cancelled_at),
    cancelled_by_party: (row.cancelled_by_party as Party | null) ?? null,
    cancel_reason: row.cancel_reason ?? null,
    created_at: iso(row.created_at) ?? "",
    updated_at: iso(row.updated_at) ?? "",
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const asUuid = (id: string | null | undefined): string | null =>
  id && UUID_RE.test(id) ? id : null;

const money2 = (n: number) => Math.round(n * 100) / 100;

/** RFB-000123 — sequential; the unique index is the real guard (retried on 23505). */
async function nextRefCode(): Promise<string> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(refurbishmentLots);
  return `RFB-${String(Number(row?.n ?? 0) + 1).padStart(6, "0")}`;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export async function loadLot(id: string, tenant_id: string | null): Promise<LotRow> {
  const [row] = await db
    .select()
    .from(refurbishmentLots)
    .where(and(eq(refurbishmentLots.id, id), tenant_id ? eq(refurbishmentLots.tenant_id, tenant_id) : undefined))
    .limit(1);
  if (!row) throw new Error("NOT_FOUND: refurbishment lot not found");
  return row;
}

/** Latest measured SOH per pipeline row, in one query. */
async function sohByPipeline(tenant_id: string, pipeline_ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (pipeline_ids.length === 0) return out;
  const rows = await db
    .selectDistinctOn([nbfcBatteryEvaluations.recovery_pipeline_id], {
      pid: nbfcBatteryEvaluations.recovery_pipeline_id,
      step1: nbfcBatteryEvaluations.step1,
    })
    .from(nbfcBatteryEvaluations)
    .where(
      and(
        eq(nbfcBatteryEvaluations.tenant_id, tenant_id),
        inArray(nbfcBatteryEvaluations.recovery_pipeline_id, pipeline_ids),
      ),
    )
    .orderBy(nbfcBatteryEvaluations.recovery_pipeline_id, desc(nbfcBatteryEvaluations.created_at));
  for (const r of rows) {
    const soh = Number((r.step1 as Record<string, unknown> | null)?.soh_percent);
    if (Number.isFinite(soh)) out.set(r.pid, soh);
  }
  return out;
}

async function loadItems(lot: LotRow): Promise<LotItem[]> {
  const rows = await db
    .select({ job: refurbishmentJobs, battery: recoveryBatteries })
    .from(refurbishmentJobs)
    .leftJoin(recoveryBatteries, eq(recoveryBatteries.id, refurbishmentJobs.battery_id))
    .where(eq(refurbishmentJobs.lot_id, lot.id))
    .orderBy(asc(refurbishmentJobs.created_at));
  const soh = await sohByPipeline(
    lot.tenant_id,
    rows.map((r) => r.job.recovery_pipeline_id).filter((x): x is string => !!x),
  );
  return rows.map((r) => ({
    ...shapeJob(r.job, r.battery?.serial ?? null),
    model: r.battery?.model ?? null,
    capacity: r.battery?.capacity ?? null,
    condition_grade: r.battery?.condition_grade ?? null,
    soh_pct: r.job.recovery_pipeline_id ? (soh.get(r.job.recovery_pipeline_id) ?? null) : null,
    image_urls: r.battery?.image_urls ?? [],
    battery_state: r.battery?.state_code ?? null,
    custody: custodyForItem(lot.status, r.job),
  }));
}

async function loadEvents(lot_id: string): Promise<LotEvent[]> {
  const rows = await db
    .select()
    .from(refurbishmentLotEvents)
    .where(eq(refurbishmentLotEvents.lot_id, lot_id))
    .orderBy(asc(refurbishmentLotEvents.seq));
  return rows.map((e) => ({
    id: e.id,
    seq: e.seq,
    party: e.party as LotEvent["party"],
    kind: e.kind,
    message: e.message ?? null,
    payload: (e.payload as Record<string, unknown>) ?? {},
    created_at: iso(e.created_at) ?? "",
  }));
}

async function tenantName(tenant_id: string): Promise<string | null> {
  const [t] = await db.select({ name: nbfcTenants.display_name }).from(nbfcTenants).where(eq(nbfcTenants.id, tenant_id)).limit(1);
  return t?.name ?? null;
}

const liveOf = <T extends { status: string }>(jobs: T[]) =>
  jobs.filter((j) => j.status !== "declined" && j.status !== "cancelled");

export async function getLot(id: string, tenant_id: string | null): Promise<LotDetail | null> {
  let lot: LotRow;
  try {
    lot = await loadLot(id, tenant_id);
  } catch {
    return null;
  }
  const [items, events, name] = await Promise.all([loadItems(lot), loadEvents(lot.id), tenantName(lot.tenant_id)]);
  const live = liveOf(items);
  const actual_total = live.length ? money2(live.reduce((s, i) => s + (i.total_cost ?? 0), 0)) : null;
  const approved = num(lot.quote_approved_total);
  return {
    ...shapeLot(lot, name),
    items,
    events,
    actual_total,
    over_approved_quote: !withinApprovedQuote(actual_total, approved),
  };
}

export async function listLots(input: {
  tenant_id: string | null;
  status?: LotStatus | "open" | "closed" | "all";
}): Promise<{ items: Lot[]; counts: Record<string, number> }> {
  const status = input.status ?? "open";
  const statusCond =
    status === "all"
      ? undefined
      : status === "open"
        ? inArray(refurbishmentLots.status, OPEN_LOT_STATUSES)
        : status === "closed"
          ? inArray(refurbishmentLots.status, ["settled", "cancelled"])
          : eq(refurbishmentLots.status, status);
  const tenantCond = input.tenant_id ? eq(refurbishmentLots.tenant_id, input.tenant_id) : undefined;

  const [rows, countRows] = await Promise.all([
    db
      .select({ lot: refurbishmentLots, tenant_name: nbfcTenants.display_name })
      .from(refurbishmentLots)
      .leftJoin(nbfcTenants, eq(nbfcTenants.id, refurbishmentLots.tenant_id))
      .where(and(tenantCond, statusCond))
      .orderBy(desc(refurbishmentLots.created_at))
      .limit(200),
    db
      .select({ status: refurbishmentLots.status, n: sql<number>`count(*)::int` })
      .from(refurbishmentLots)
      .where(tenantCond)
      .groupBy(refurbishmentLots.status),
  ]);
  const counts: Record<string, number> = {};
  for (const s of LOT_STATUSES) counts[s] = 0;
  for (const r of countRows) counts[r.status] = Number(r.n);
  counts.open = OPEN_LOT_STATUSES.reduce((s, k) => s + (counts[k] ?? 0), 0);
  return { items: rows.map((r) => shapeLot(r.lot, r.tenant_name ?? null)), counts };
}

// ---------------------------------------------------------------------------
// Eligible batteries — what the NBFC may put in a lot
// ---------------------------------------------------------------------------
export interface EligibleBattery {
  id: string;
  serial: string;
  model: string | null;
  capacity: string | null;
  condition_grade: string | null;
  soh_pct: number | null;
  image_urls: string[];
  recovery_pipeline_id: string | null;
  /** null = eligible; otherwise the reason it is listed greyed out. */
  blocked_reason: string | null;
  /** [E-271] Why iTarang refused it last time — so the NBFC fixes that before resubmitting. */
  last_decline_reason: string | null;
  last_declined_at: string | null;
}

export async function listEligibleBatteries(tenant_id: string): Promise<EligibleBattery[]> {
  const rows = await db
    .select()
    .from(recoveryBatteries)
    .where(and(eq(recoveryBatteries.tenant_id, tenant_id), eq(recoveryBatteries.state_code, "inspected")))
    .orderBy(desc(recoveryBatteries.updated_at))
    .limit(500);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const [soh, openJobs, declined] = await Promise.all([
    sohByPipeline(tenant_id, rows.map((r) => r.recovery_pipeline_id).filter((x): x is string => !!x)),
    db
      .select({ battery_id: refurbishmentJobs.battery_id })
      .from(refurbishmentJobs)
      .where(and(inArray(refurbishmentJobs.battery_id, ids), inArray(refurbishmentJobs.status, OPEN_STATUSES))),
    db
      .selectDistinctOn([refurbishmentJobs.battery_id], {
        battery_id: refurbishmentJobs.battery_id,
        reason: refurbishmentJobs.decline_reason,
        at: refurbishmentJobs.decided_at,
      })
      .from(refurbishmentJobs)
      .where(and(inArray(refurbishmentJobs.battery_id, ids), eq(refurbishmentJobs.status, "declined")))
      .orderBy(refurbishmentJobs.battery_id, desc(refurbishmentJobs.decided_at)),
  ]);
  const busy = new Set(openJobs.map((j) => j.battery_id));
  const lastDecline = new Map(declined.map((d) => [d.battery_id, d]));

  return rows.map((b) => {
    const s = b.recovery_pipeline_id ? (soh.get(b.recovery_pipeline_id) ?? null) : null;
    let blocked: string | null = null;
    if (busy.has(b.id)) blocked = "already has an open refurbishment job";
    else if (s === null) blocked = "no state of health recorded — evaluate it first";
    else if (s < SOH_REFURBISHABLE_MIN) blocked = `SOH ${s}% is below the ${SOH_REFURBISHABLE_MIN}% refurbishment threshold`;
    const d = lastDecline.get(b.id);
    return {
      id: b.id,
      serial: b.serial,
      model: b.model ?? null,
      capacity: b.capacity ?? null,
      condition_grade: b.condition_grade ?? null,
      soh_pct: s,
      image_urls: b.image_urls ?? [],
      recovery_pipeline_id: b.recovery_pipeline_id ?? null,
      blocked_reason: blocked,
      last_decline_reason: d?.reason ?? null,
      last_declined_at: iso(d?.at),
    };
  });
}

// ---------------------------------------------------------------------------
// Transaction helpers (exported for refurb-payments.ts)
// ---------------------------------------------------------------------------
export async function appendEvent(
  tx: Tx,
  lot: { id: string; tenant_id: string },
  ev: { party: "nbfc" | "admin" | "system"; kind: EventKind; message?: string | null; payload?: Record<string, unknown>; actor?: string | null },
): Promise<void> {
  const [m] = await tx
    .select({ seq: sql<number>`coalesce(max(${refurbishmentLotEvents.seq}), 0)::int` })
    .from(refurbishmentLotEvents)
    .where(eq(refurbishmentLotEvents.lot_id, lot.id));
  await tx.insert(refurbishmentLotEvents).values({
    lot_id: lot.id,
    tenant_id: lot.tenant_id,
    seq: Number(m?.seq ?? 0) + 1,
    party: ev.party,
    kind: ev.kind,
    message: ev.message ?? null,
    payload: ev.payload ?? {},
    created_by: asUuid(ev.actor),
  });
}

export async function audit(
  tx: Tx,
  lot: { id: string; tenant_id: string },
  actor: string | null | undefined,
  action_type: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Promise<void> {
  // nbfc_audit_log.user_id is NOT NULL uuid; a test-bypass surrogate cannot be
  // stored, so the audit row is skipped rather than failing the move.
  const uid = asUuid(actor);
  if (!uid) return;
  await tx.insert(nbfcAuditLog).values({
    tenant_id: lot.tenant_id,
    user_id: uid,
    action_type, // varchar(32) — every string used here is ≤ 24 chars
    action_id: lot.id,
    before_state: before,
    after_state: after,
  });
}

/** Battery back to inspected / pipeline back to needs_inspection — decline or cancel. */
async function releaseBattery(tx: Tx, job: { battery_id: string; recovery_pipeline_id: string | null }, now: Date) {
  await tx
    .update(recoveryBatteries)
    .set({ state_code: "inspected", updated_at: now })
    .where(and(eq(recoveryBatteries.id, job.battery_id), eq(recoveryBatteries.state_code, "refurbishing")));
  if (job.recovery_pipeline_id) {
    await tx
      .update(nbfcRecoveryPipeline)
      .set({ stage: "needs_inspection", updated_at: now })
      .where(and(eq(nbfcRecoveryPipeline.id, job.recovery_pipeline_id), eq(nbfcRecoveryPipeline.stage, "refurbishable")));
  }
}

async function lotJobs(tx: Tx, lot_id: string) {
  return tx.select().from(refurbishmentJobs).where(eq(refurbishmentJobs.lot_id, lot_id));
}

async function serialOf(tx: Tx, battery_id: string): Promise<string | null> {
  const [b] = await tx.select({ serial: recoveryBatteries.serial }).from(recoveryBatteries).where(eq(recoveryBatteries.id, battery_id)).limit(1);
  return b?.serial ?? null;
}

/** actual (or estimated) labour + included accessories over live jobs. */
function actualTotalOf(jobs: Array<{ status: string; actual_cost: unknown; estimated_cost: unknown; accessories: unknown }>): number {
  return money2(
    liveOf(jobs).reduce((s, j) => {
      const labour = num(j.actual_cost) ?? num(j.estimated_cost) ?? 0;
      return s + labour + accessoriesTotal((j.accessories as AccessoryLine[]) ?? []);
    }, 0),
  );
}

// ---------------------------------------------------------------------------
// 1. NBFC: create a lot
// ---------------------------------------------------------------------------
export async function createLot(input: {
  tenant_id: string;
  actor_user_id: string | null;
  battery_ids: string[];
  note?: string | null;
}): Promise<LotDetail> {
  const ids = Array.from(new Set(input.battery_ids));
  if (ids.length === 0) throw new Error("BAD_REQUEST: pick at least one battery");

  const batteries = await db
    .select()
    .from(recoveryBatteries)
    .where(and(eq(recoveryBatteries.tenant_id, input.tenant_id), inArray(recoveryBatteries.id, ids)));
  if (batteries.length !== ids.length) throw new Error("NOT_FOUND: one or more batteries do not belong to this NBFC");
  for (const b of batteries) {
    if (b.state_code !== "inspected") {
      throw new Error(`CONFLICT: battery ${b.serial} is ${b.state_code} — only inspected batteries can be sent for refurbishment`);
    }
  }
  const soh = await sohByPipeline(input.tenant_id, batteries.map((b) => b.recovery_pipeline_id).filter((x): x is string => !!x));
  for (const b of batteries) {
    const s = b.recovery_pipeline_id ? (soh.get(b.recovery_pipeline_id) ?? null) : null;
    try {
      assertSohAllowsStage(s, "refurbishable");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`${msg.split(":")[0]}: ${b.serial} — ${msg.replace(/^[A-Z_]+:\s*/, "")}`);
    }
  }
  const open = await db
    .select({ battery_id: refurbishmentJobs.battery_id })
    .from(refurbishmentJobs)
    .where(and(inArray(refurbishmentJobs.battery_id, ids), inArray(refurbishmentJobs.status, OPEN_STATUSES)));
  if (open.length) {
    const serial = batteries.find((b) => b.id === open[0].battery_id)?.serial ?? open[0].battery_id;
    throw new Error(`CONFLICT: battery ${serial} already has an open refurbishment job`);
  }
  // Resubmission after a decline (review point 1): link the previous lot.
  const prior = await db
    .select({ lot_id: refurbishmentJobs.lot_id, battery_id: refurbishmentJobs.battery_id })
    .from(refurbishmentJobs)
    .where(and(inArray(refurbishmentJobs.battery_id, ids), eq(refurbishmentJobs.status, "declined")))
    .orderBy(desc(refurbishmentJobs.decided_at))
    .limit(1);

  const now = new Date();
  const accessories: AccessoryLine[] = REQUIRED_ACCESSORIES.map((a) => ({ ...a, included: true }));

  let lotId: string | null = null;
  for (let attempt = 0; attempt < 3 && !lotId; attempt++) {
    const ref = await nextRefCode();
    try {
      lotId = await db.transaction(async (tx) => {
        const [lot] = await tx
          .insert(refurbishmentLots)
          .values({
            ref_code: attempt === 0 ? ref : `${ref}-${randomUUID().slice(0, 4)}`,
            tenant_id: input.tenant_id,
            status: "requested",
            battery_count: batteries.length,
            note: input.note ?? null,
            last_party: "nbfc",
            created_by: asUuid(input.actor_user_id),
            created_at: now,
            updated_at: now,
          })
          .returning();
        await tx.insert(refurbishmentJobs).values(
          batteries.map((b) => ({
            tenant_id: input.tenant_id,
            battery_id: b.id,
            recovery_pipeline_id: b.recovery_pipeline_id ?? null,
            requested_by_user_id: asUuid(input.actor_user_id),
            lot_id: lot.id,
            checklist: [] as ChecklistItem[],
            accessories,
            status: "requested",
            requested_at: now,
          })),
        );
        await tx.update(recoveryBatteries).set({ state_code: "refurbishing", updated_at: now }).where(inArray(recoveryBatteries.id, ids));
        const pids = batteries.map((b) => b.recovery_pipeline_id).filter((x): x is string => !!x);
        if (pids.length) {
          await tx.update(nbfcRecoveryPipeline).set({ stage: "refurbishable", updated_at: now }).where(inArray(nbfcRecoveryPipeline.id, pids));
        }
        await appendEvent(tx, lot, {
          party: "nbfc",
          kind: "requested",
          message: input.note ?? null,
          actor: input.actor_user_id,
          payload: {
            serials: batteries.map((b) => b.serial),
            battery_count: batteries.length,
            resubmitted_from_lot: prior[0]?.lot_id ?? null,
          },
        });
        await audit(tx, lot, input.actor_user_id, "refurb_lot_created", {}, { ref_code: lot.ref_code, battery_count: batteries.length });
        return lot.id;
      });
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === "23505" && attempt < 2) continue;
      throw e;
    }
  }
  if (!lotId) throw new Error("CONFLICT: could not allocate a lot reference");
  return (await getLot(lotId, input.tenant_id))!;
}

// ---------------------------------------------------------------------------
// 2. Admin: per-battery review (decline some, keep the rest)
// ---------------------------------------------------------------------------
export async function reviewLotItems(input: {
  lot_id: string;
  actor_user_id: string | null;
  decisions: Array<{ job_id: string; decision: "accept" | "decline"; reason?: string | null }>;
}): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, null);
  if (lot.status !== "requested" && lot.status !== "countered") {
    throw new Error(`CONFLICT: batteries can only be reviewed while the lot is requested or countered (it is ${lot.status})`);
  }
  const now = new Date();
  await db.transaction(async (tx) => {
    const jobs = await lotJobs(tx, lot.id);
    const byId = new Map(jobs.map((j) => [j.id, j]));
    let declined = 0;
    for (const d of input.decisions) {
      const job = byId.get(d.job_id);
      if (!job) throw new Error(`NOT_FOUND: job ${d.job_id} is not in this lot`);
      if (d.decision === "decline") {
        if (job.status !== "requested") continue;
        if (!d.reason?.trim()) throw new Error("BAD_REQUEST: a declined battery needs a reason");
        await tx
          .update(refurbishmentJobs)
          .set({ status: "declined", decline_reason: d.reason.trim(), decided_at: now, decided_by: asUuid(input.actor_user_id), updated_at: now })
          .where(eq(refurbishmentJobs.id, job.id));
        await releaseBattery(tx, job, now);
        await appendEvent(tx, lot, {
          party: "admin",
          kind: "item_declined",
          message: d.reason.trim(),
          actor: input.actor_user_id,
          payload: { job_id: job.id, battery_id: job.battery_id, serial: await serialOf(tx, job.battery_id) },
        });
        declined++;
      } else if (job.status === "requested" && !job.decided_at) {
        await tx.update(refurbishmentJobs).set({ decided_at: now, decided_by: asUuid(input.actor_user_id), updated_at: now }).where(eq(refurbishmentJobs.id, job.id));
      }
    }
    const remaining = liveOf(await lotJobs(tx, lot.id)).length;
    const allGone = remaining === 0;
    await tx
      .update(refurbishmentLots)
      .set({
        battery_count: remaining,
        ...(allGone
          ? { status: "cancelled", cancelled_at: now, cancelled_by: asUuid(input.actor_user_id), cancelled_by_party: "admin", cancel_reason: "every battery in the lot was declined", last_party: "admin" }
          : {}),
        updated_at: now,
      })
      .where(eq(refurbishmentLots.id, lot.id));
    if (allGone) {
      await appendEvent(tx, lot, { party: "system", kind: "cancelled", message: "Every battery was declined, so the lot is closed.", payload: { by: "admin" } });
    }
    await audit(tx, lot, input.actor_user_id, "refurb_lot_reviewed", { battery_count: lot.battery_count }, { declined, battery_count: remaining, status: allGone ? "cancelled" : lot.status });
  });
  return (await getLot(lot.id, null))!;
}

// ---------------------------------------------------------------------------
// 3. Admin: the quote — timeline + pickup plan + estimate + advance
// ---------------------------------------------------------------------------
export interface ProposalItem {
  job_id: string;
  estimated_cost: number;
  accessories?: AccessoryLine[];
}

export async function proposeLot(input: {
  lot_id: string;
  actor_user_id: string | null;
  expected_receipt_date: string; // YYYY-MM-DD
  expected_return_date: string;
  items: ProposalItem[];
  note?: string | null;
  // E-271
  pickup_mode?: PickupMode;
  pickup_address?: string | null;
  workshop_address?: string | null;
  scheduled_pickup_date?: string | null;
  advance_pct?: number;
}): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, null);
  const to = assertLotMove(lot.status, "propose");
  if (input.expected_return_date < input.expected_receipt_date) {
    throw new Error("BAD_REQUEST: the return date cannot be before the receipt date");
  }
  const pickup_mode: PickupMode = input.pickup_mode ?? "nbfc_ships";
  if (!PICKUP_MODES.includes(pickup_mode)) throw new Error("BAD_REQUEST: unknown pickup mode");
  if (pickup_mode === "itarang_pickup" && !input.scheduled_pickup_date) {
    throw new Error("BAD_REQUEST: an iTarang pickup needs a scheduled pickup date");
  }
  const advance_pct = input.advance_pct ?? 0;
  if (advance_pct < 0 || advance_pct > 100) throw new Error("BAD_REQUEST: advance must be between 0 and 100 percent");

  const now = new Date();
  await db.transaction(async (tx) => {
    const jobs = liveOf(await lotJobs(tx, lot.id));
    if (jobs.length === 0) throw new Error("CONFLICT: the lot has no batteries left to quote on");
    const byId = new Map(input.items.map((i) => [i.job_id, i]));
    let labour = 0;
    let acc = 0;
    const snapshot: Array<Record<string, unknown>> = [];
    for (const job of jobs) {
      const it = byId.get(job.id);
      if (!it) throw new Error(`BAD_REQUEST: no estimate given for job ${job.id}`);
      const accessories = it.accessories ?? ((job.accessories as AccessoryLine[]) ?? []);
      const a = accessoriesTotal(accessories);
      labour += it.estimated_cost;
      acc += a;
      await tx
        .update(refurbishmentJobs)
        .set({ estimated_cost: String(it.estimated_cost), accessories, decided_at: job.decided_at ?? now, decided_by: job.decided_by ?? asUuid(input.actor_user_id), updated_at: now })
        .where(eq(refurbishmentJobs.id, job.id));
      snapshot.push({ job_id: job.id, battery_id: job.battery_id, estimated_cost: it.estimated_cost, accessories_total: a });
    }
    const total = money2(labour + acc);
    const advance_amount = advance_pct > 0 ? money2((total * advance_pct) / 100) : 0;
    const round = lot.current_round + 1;
    await tx
      .update(refurbishmentLots)
      .set({
        status: to,
        current_round: round,
        last_party: "admin",
        expected_receipt_date: input.expected_receipt_date,
        expected_return_date: input.expected_return_date,
        estimated_labour_total: String(money2(labour)),
        estimated_accessories_total: String(money2(acc)),
        estimated_total: String(total),
        proposal_note: input.note ?? null,
        battery_count: jobs.length,
        pickup_mode,
        pickup_address: input.pickup_address ?? null,
        workshop_address: input.workshop_address ?? null,
        scheduled_pickup_date: input.scheduled_pickup_date ?? null,
        advance_pct: String(advance_pct),
        advance_amount: advance_pct > 0 ? String(advance_amount) : null,
        updated_at: now,
      })
      .where(eq(refurbishmentLots.id, lot.id));
    await appendEvent(tx, lot, {
      party: "admin",
      kind: "proposed",
      message: input.note ?? null,
      actor: input.actor_user_id,
      payload: {
        round,
        expected_receipt_date: input.expected_receipt_date,
        expected_return_date: input.expected_return_date,
        estimated_labour_total: money2(labour),
        estimated_accessories_total: money2(acc),
        estimated_total: total,
        pickup_mode,
        scheduled_pickup_date: input.scheduled_pickup_date ?? null,
        pickup_address: input.pickup_address ?? null,
        workshop_address: input.workshop_address ?? null,
        advance_pct,
        advance_amount,
        items: snapshot,
      },
    });
    await audit(tx, lot, input.actor_user_id, "refurb_lot_proposed", { status: lot.status }, { status: to, round, estimated_total: total, advance_pct, pickup_mode });
  });
  return (await getLot(lot.id, null))!;
}

// ---------------------------------------------------------------------------
// 4. NBFC: approve the quote, or counter
// ---------------------------------------------------------------------------
export async function respondToProposal(input: {
  lot_id: string;
  tenant_id: string;
  actor_user_id: string | null;
  kind: "accept" | "counter";
  message?: string | null;
  requested_receipt_date?: string | null;
  requested_return_date?: string | null;
}): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, input.tenant_id);
  assertLotMove(lot.status, input.kind);
  if (input.kind === "counter" && !input.message?.trim() && !input.requested_receipt_date && !input.requested_return_date) {
    throw new Error("BAD_REQUEST: say what should change — a message or the dates you need");
  }
  const now = new Date();
  const total = num(lot.estimated_total) ?? 0;
  const advance_pct = num(lot.advance_pct) ?? 0;
  const advance_amount = advance_pct > 0 ? money2((total * advance_pct) / 100) : 0;
  const landing: LotStatus =
    input.kind === "accept" ? nextAfterAgreed({ advance_pct, pickup_mode: lot.pickup_mode }) : "countered";

  await db.transaction(async (tx) => {
    await tx
      .update(refurbishmentLots)
      .set({
        status: landing,
        last_party: "nbfc",
        ...(input.kind === "accept"
          ? {
              agreed_at: now,
              agreed_by: asUuid(input.actor_user_id),
              // THE approval (review points 2 & 5): frozen here, enforced at ready.
              quote_approved_total: String(total),
              quote_approved_at: now,
              quote_approved_by: asUuid(input.actor_user_id),
              advance_amount: advance_pct > 0 ? String(advance_amount) : null,
              advance_status: advance_pct > 0 ? "pending" : "not_required",
            }
          : {}),
        updated_at: now,
      })
      .where(eq(refurbishmentLots.id, lot.id));
    await appendEvent(tx, lot, {
      party: "nbfc",
      kind: input.kind === "accept" ? "accepted" : "countered",
      message: input.message ?? null,
      actor: input.actor_user_id,
      payload:
        input.kind === "accept"
          ? {
              round: lot.current_round,
              expected_receipt_date: iso(lot.expected_receipt_date),
              expected_return_date: iso(lot.expected_return_date),
              quote_approved_total: total,
              advance_amount,
              pickup_mode: lot.pickup_mode,
              landing,
            }
          : { round: lot.current_round, requested_receipt_date: input.requested_receipt_date ?? null, requested_return_date: input.requested_return_date ?? null },
    });
    if (input.kind === "accept" && landing === "pickup_scheduled") {
      await appendEvent(tx, lot, {
        party: "system",
        kind: "pickup_scheduled",
        payload: { scheduled_pickup_date: iso(lot.scheduled_pickup_date), pickup_address: lot.pickup_address },
      });
    }
    await audit(tx, lot, input.actor_user_id, input.kind === "accept" ? "refurb_lot_agreed" : "refurb_lot_countered", { status: lot.status }, { status: landing, round: lot.current_round, quote_approved_total: total });
  });
  return (await getLot(lot.id, input.tenant_id))!;
}

/** After the advance is confirmed (refurb-payments.ts calls this inside its tx). */
export async function advanceToShipping(tx: Tx, lot: LotRow, actor: string | null, now: Date): Promise<LotStatus> {
  assertLotMove(lot.status, "advance_paid");
  const landing = nextAfterAdvance({ pickup_mode: lot.pickup_mode });
  await tx.update(refurbishmentLots).set({ status: landing, last_party: "admin", updated_at: now }).where(eq(refurbishmentLots.id, lot.id));
  if (landing === "pickup_scheduled") {
    await appendEvent(tx, lot, { party: "system", kind: "pickup_scheduled", payload: { scheduled_pickup_date: iso(lot.scheduled_pickup_date), pickup_address: lot.pickup_address } });
  }
  void actor;
  return landing;
}

// ---------------------------------------------------------------------------
// Cancel — either side, only before anything moved
// ---------------------------------------------------------------------------
export async function cancelLot(input: {
  lot_id: string;
  tenant_id: string | null;
  actor_user_id: string | null;
  party: Party;
  reason?: string | null;
}): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, input.tenant_id);
  if (!(CANCELLABLE_LOT_STATUSES as readonly string[]).includes(lot.status)) {
    throw new Error(`CONFLICT: a lot that is ${lot.status.replace(/_/g, " ")} cannot be cancelled — the batteries have already moved`);
  }
  const now = new Date();
  await db.transaction(async (tx) => {
    const jobs = liveOf(await lotJobs(tx, lot.id));
    for (const job of jobs) {
      await tx.update(refurbishmentJobs).set({ status: "cancelled", updated_at: now }).where(eq(refurbishmentJobs.id, job.id));
      await releaseBattery(tx, job, now);
    }
    await tx
      .update(refurbishmentLots)
      .set({ status: "cancelled", cancelled_at: now, cancelled_by: asUuid(input.actor_user_id), cancelled_by_party: input.party, cancel_reason: input.reason ?? null, last_party: input.party, updated_at: now })
      .where(eq(refurbishmentLots.id, lot.id));
    await appendEvent(tx, lot, {
      party: input.party,
      kind: "cancelled",
      message: input.reason ?? null,
      actor: input.actor_user_id,
      // An advance already confirmed is a refund conversation, flagged here
      // rather than silently forgotten.
      payload: { by: input.party, released: jobs.length, advance_confirmed: lot.advance_status === "confirmed", advance_amount: num(lot.advance_amount) },
    });
    await audit(tx, lot, input.actor_user_id, "refurb_lot_cancelled", { status: lot.status }, { status: "cancelled", by: input.party });
  });
  return (await getLot(lot.id, input.tenant_id))!;
}

// ---------------------------------------------------------------------------
// 5 / 8. Trucks — NBFC dispatch, iTarang pickup, admin return dispatch
// ---------------------------------------------------------------------------
export interface TransportInput {
  lot_id: string;
  tenant_id: string | null;
  actor_user_id: string | null;
  carrier?: string | null;
  vehicle_no?: string | null;
  docket_no?: string | null;
  eway_bill_no?: string | null;
  eway_bill_url?: string | null;
  dispatched_on: string; // YYYY-MM-DD
  note?: string | null;
  photo_urls?: string[];
}

async function writeTransport(
  tx: Tx,
  lot: LotRow,
  p: "out" | "ret",
  input: TransportInput,
  extra: Partial<LotRow>,
  now: Date,
) {
  const existing = ((lot as unknown as Record<string, unknown>)[`${p}_photo_urls`] as string[]) ?? [];
  await tx
    .update(refurbishmentLots)
    .set({
      [`${p}_carrier`]: input.carrier ?? null,
      [`${p}_vehicle_no`]: input.vehicle_no ?? null,
      [`${p}_docket_no`]: input.docket_no ?? null,
      [`${p}_eway_bill_no`]: input.eway_bill_no ?? null,
      [`${p}_eway_bill_url`]: input.eway_bill_url ?? (lot as unknown as Record<string, unknown>)[`${p}_eway_bill_url`] ?? null,
      [`${p}_dispatched_on`]: input.dispatched_on,
      [`${p}_dispatch_note`]: input.note ?? null,
      [`${p}_photo_urls`]: [...existing, ...(input.photo_urls ?? [])],
      [`${p}_dispatched_at`]: now,
      [`${p}_dispatched_by`]: asUuid(input.actor_user_id),
      ...extra,
      updated_at: now,
    } as Partial<LotRow>)
    .where(eq(refurbishmentLots.id, lot.id));
  return {
    carrier: input.carrier ?? null,
    vehicle_no: input.vehicle_no ?? null,
    docket_no: input.docket_no ?? null,
    eway_bill_no: input.eway_bill_no ?? null,
    dispatched_on: input.dispatched_on,
    photo_count: (input.photo_urls ?? []).length + existing.length,
  };
}

/** NBFC ships (nbfc_ships mode) or admin ships back. */
export async function recordDispatch(input: TransportInput & { leg: "out" | "return" }): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, input.tenant_id);
  const move = input.leg === "out" ? "dispatch_out" : "dispatch_return";
  const to = assertLotMove(lot.status, move);
  if (input.leg === "out" && lot.pickup_mode === "itarang_pickup") {
    throw new Error("CONFLICT: iTarang is collecting this lot — its agent records the pickup, not the NBFC");
  }
  const p = input.leg === "out" ? "out" : "ret";
  const party: Party = input.leg === "out" ? "nbfc" : "admin";
  const now = new Date();
  await db.transaction(async (tx) => {
    const payload = await writeTransport(tx, lot, p, input, { status: to, last_party: party }, now);
    await appendEvent(tx, lot, { party, kind: input.leg === "out" ? "dispatched_out" : "dispatched_return", message: input.note ?? null, actor: input.actor_user_id, payload });
    await audit(tx, lot, input.actor_user_id, "refurb_lot_dispatched", { status: lot.status }, { status: to, leg: input.leg, docket_no: input.docket_no ?? null, eway_bill_no: input.eway_bill_no ?? null });
  });
  return (await getLot(lot.id, input.tenant_id))!;
}

/** iTarang's agent collected the batteries (itarang_pickup mode). */
export async function recordPickup(input: TransportInput): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, null);
  const to = assertLotMove(lot.status, "pickup");
  const now = new Date();
  await db.transaction(async (tx) => {
    const payload = await writeTransport(tx, lot, "out", input, { status: to, last_party: "admin", out_picked_up_at: now, out_picked_up_by: asUuid(input.actor_user_id) }, now);
    await appendEvent(tx, lot, { party: "admin", kind: "picked_up", message: input.note ?? null, actor: input.actor_user_id, payload });
    await audit(tx, lot, input.actor_user_id, "refurb_lot_picked_up", { status: lot.status }, { status: to, docket_no: input.docket_no ?? null, eway_bill_no: input.eway_bill_no ?? null });
  });
  return (await getLot(lot.id, null))!;
}

/** The truck reached the gate (review point 8). Receipt battery-by-battery comes next. */
export async function markArrived(input: { lot_id: string; tenant_id: string | null; actor_user_id: string | null; leg: "out" | "return"; note?: string | null }): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, input.tenant_id);
  const to = assertLotMove(lot.status, input.leg === "out" ? "arrive_out" : "arrive_return");
  const p = input.leg === "out" ? "out" : "ret";
  const party: Party = input.leg === "out" ? "admin" : "nbfc";
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(refurbishmentLots)
      .set({ status: to, last_party: party, [`${p}_delivered_at`]: now, [`${p}_delivered_by`]: asUuid(input.actor_user_id), updated_at: now } as Partial<LotRow>)
      .where(eq(refurbishmentLots.id, lot.id));
    await appendEvent(tx, lot, { party, kind: input.leg === "out" ? "arrived_out" : "arrived_return", message: input.note ?? null, actor: input.actor_user_id, payload: { leg: input.leg } });
    await audit(tx, lot, input.actor_user_id, "refurb_lot_arrived", { status: lot.status }, { status: to, leg: input.leg });
  });
  return (await getLot(lot.id, input.tenant_id))!;
}

// ---------------------------------------------------------------------------
// 6 / 9. Receipt — admin signs for the batteries, NBFC signs for them back
// ---------------------------------------------------------------------------
export interface ReceiptInput {
  lot_id: string;
  tenant_id: string | null;
  actor_user_id: string | null;
  leg: "out" | "return";
  items: Array<{ job_id: string; condition: ReceiptCondition; note?: string | null; photo_urls?: string[] }>;
  note?: string | null;
  photo_urls?: string[];
}

export async function confirmReceipt(input: ReceiptInput): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, input.tenant_id);
  const to = assertLotMove(lot.status, input.leg === "out" ? "receive_out" : "receive_return");
  const p = input.leg === "out" ? "out" : "ret";
  const party: Party = input.leg === "out" ? "admin" : "nbfc";
  const now = new Date();

  await db.transaction(async (tx) => {
    const jobs = liveOf(await lotJobs(tx, lot.id));
    const byId = new Map(input.items.map((i) => [i.job_id, i]));
    let mismatch = false;
    const tally = { received: 0, damaged: 0, missing: 0 };
    const rows: Array<Record<string, unknown>> = [];

    for (const job of jobs) {
      if (input.leg === "return" && job.status !== "ready") continue;
      const it = byId.get(job.id);
      if (!it) throw new Error(`BAD_REQUEST: no receipt condition given for job ${job.id}`);
      if (it.condition !== "received") mismatch = true;
      tally[it.condition]++;
      rows.push({ job_id: job.id, serial: await serialOf(tx, job.battery_id), condition: it.condition, note: it.note ?? null });

      const itemPatch = {
        [`${p}_received_condition`]: it.condition,
        [`${p}_received_note`]: it.note ?? null,
        [`${p}_received_photo_urls`]: it.photo_urls ?? [],
        updated_at: now,
      } as Partial<typeof refurbishmentJobs.$inferInsert>;

      if (input.leg === "return") {
        itemPatch.ret_received_at = now;
        if (it.condition === "received") {
          // THE move that makes the repair count.
          itemPatch.status = "returned";
          itemPatch.returned_at = now;
          await tx.update(recoveryBatteries).set({ state_code: "ready", condition_grade: "refurbished", updated_at: now }).where(eq(recoveryBatteries.id, job.battery_id));
          if (job.recovery_pipeline_id) {
            await tx.update(nbfcRecoveryPipeline).set({ stage: "ready_for_auction", updated_at: now }).where(eq(nbfcRecoveryPipeline.id, job.recovery_pipeline_id));
          }
        }
      }
      await tx.update(refurbishmentJobs).set(itemPatch).where(eq(refurbishmentJobs.id, job.id));
    }

    const after = await lotJobs(tx, lot.id);
    const stillOpen = after.filter((j) => j.status === "ready" || j.status === "in_progress" || j.status === "requested");

    // Money on the return leg (review point 3): final bill minus the advance.
    let moneyPatch: Partial<LotRow> = {};
    let lotStatus: LotStatus = to;
    if (input.leg === "return") {
      if (stillOpen.length > 0) {
        lotStatus = "delivered_back"; // partial receipt — still waiting on the flagged ones
      } else {
        const final_total = actualTotalOf(after);
        const advanceConfirmed = lot.advance_status === "confirmed" ? (num(lot.advance_amount) ?? 0) : 0;
        const balance = money2(Math.max(0, final_total - advanceConfirmed));
        lotStatus = nextAfterReceipt(balance);
        moneyPatch = {
          final_total: String(final_total),
          balance_amount: String(balance),
          balance_status: balance > 0.005 ? "pending" : "not_due",
          completed_at: now,
          ...(lotStatus === "settled" ? { settled_at: now } : {}),
        };
      }
    }

    const existing = ((lot as unknown as Record<string, unknown>)[`${p}_receipt_photo_urls`] as string[]) ?? [];
    await tx
      .update(refurbishmentLots)
      .set({
        status: lotStatus,
        last_party: party,
        [`${p}_received_at`]: now,
        [`${p}_received_by`]: asUuid(input.actor_user_id),
        [`${p}_receipt_note`]: input.note ?? null,
        [`${p}_receipt_photo_urls`]: [...existing, ...(input.photo_urls ?? [])],
        [`${p}_has_mismatch`]: mismatch,
        ...moneyPatch,
        updated_at: now,
      } as Partial<LotRow>)
      .where(eq(refurbishmentLots.id, lot.id));

    await appendEvent(tx, lot, {
      party,
      kind: input.leg === "out" ? "received_out" : "received_return",
      message: input.note ?? null,
      actor: input.actor_user_id,
      payload: { ...tally, has_mismatch: mismatch, items: rows, partial: input.leg === "return" && stillOpen.length > 0, final_total: num(moneyPatch.final_total), balance_amount: num(moneyPatch.balance_amount) },
    });
    if (lotStatus === "settled") {
      await appendEvent(tx, lot, { party: "system", kind: "settled", payload: { final_total: num(moneyPatch.final_total), balance_amount: 0 } });
    }
    await audit(tx, lot, input.actor_user_id, lotStatus === "settled" ? "refurb_lot_settled" : "refurb_lot_received", { status: lot.status }, { status: lotStatus, leg: input.leg, ...tally });
  });
  return (await getLot(lot.id, input.tenant_id))!;
}

// ---------------------------------------------------------------------------
// 7. Admin: work, and the approved-quote gate with its revision round
// ---------------------------------------------------------------------------
export async function startWork(input: { lot_id: string; actor_user_id: string | null }): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, null);
  const to = assertLotMove(lot.status, "start_work");
  const now = new Date();
  await db.transaction(async (tx) => {
    const jobs = liveOf(await lotJobs(tx, lot.id));
    const workable = jobs.filter((j) => j.status === "requested" && j.out_received_condition !== "missing");
    if (workable.length) {
      await tx.update(refurbishmentJobs).set({ status: "in_progress", started_at: now, updated_at: now }).where(inArray(refurbishmentJobs.id, workable.map((j) => j.id)));
    }
    const missing = jobs.filter((j) => j.out_received_condition === "missing" && j.status === "requested");
    if (missing.length) {
      await tx.update(refurbishmentJobs).set({ status: "cancelled", notes: "missing at workshop receipt", updated_at: now }).where(inArray(refurbishmentJobs.id, missing.map((j) => j.id)));
      for (const j of missing) await releaseBattery(tx, j, now);
    }
    await tx.update(refurbishmentLots).set({ status: to, work_started_at: now, last_party: "admin", battery_count: workable.length, updated_at: now }).where(eq(refurbishmentLots.id, lot.id));
    await appendEvent(tx, lot, { party: "admin", kind: "work_started", actor: input.actor_user_id, payload: { batteries: workable.length, missing_closed: missing.length } });
    await audit(tx, lot, input.actor_user_id, "refurb_lot_started", { status: lot.status }, { status: to });
  });
  return (await getLot(lot.id, null))!;
}

export async function updateLotItem(input: {
  lot_id: string;
  job_id: string;
  actor_user_id: string | null;
  checklist?: ChecklistItem[];
  accessories?: AccessoryLine[];
  actual_cost?: number | null;
  notes?: string | null;
  assigned_workshop?: string | null;
}): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, null);
  if (!["in_progress", "received", "ready", "revision_pending"].includes(lot.status)) {
    throw new Error(`CONFLICT: work details can only be edited while the lot is at the workshop (it is ${lot.status})`);
  }
  const [job] = await db.select().from(refurbishmentJobs).where(and(eq(refurbishmentJobs.id, input.job_id), eq(refurbishmentJobs.lot_id, lot.id))).limit(1);
  if (!job) throw new Error("NOT_FOUND: job is not in this lot");
  await db
    .update(refurbishmentJobs)
    .set({
      ...(input.checklist !== undefined ? { checklist: input.checklist } : {}),
      ...(input.accessories !== undefined ? { accessories: input.accessories } : {}),
      ...(input.actual_cost !== undefined ? { actual_cost: input.actual_cost === null ? null : String(input.actual_cost) } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.assigned_workshop !== undefined ? { assigned_workshop: input.assigned_workshop } : {}),
      updated_at: new Date(),
    })
    .where(eq(refurbishmentJobs.id, job.id));
  return (await getLot(lot.id, null))!;
}

export async function markItemReady(input: { lot_id: string; job_id: string; actor_user_id: string | null }): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, null);
  if (lot.status !== "in_progress") {
    throw new Error(`CONFLICT: a battery can only be marked ready while the lot is in progress (it is ${lot.status})`);
  }
  const now = new Date();
  await db.transaction(async (tx) => {
    const jobs = await lotJobs(tx, lot.id);
    const job = jobs.find((j) => j.id === input.job_id);
    if (!job) throw new Error("NOT_FOUND: job is not in this lot");
    if (job.status !== "in_progress") throw new Error(`CONFLICT: job is ${job.status}, not in progress`);

    const statuses = jobs.map((j) => (j.id === job.id ? "ready" : j.status));
    const allReady = allOpenItemsReady(statuses);
    // THE approved-quote gate (review points 2 & 5). The last battery cannot
    // close the lot while the bill exceeds what the NBFC signed off.
    const actual = actualTotalOf(jobs);
    const approved = num(lot.quote_approved_total);
    if (allReady && !withinApprovedQuote(actual, approved)) {
      throw new Error(
        `CONFLICT: actual work is ₹${actual.toLocaleString("en-IN")} against an approved quote of ₹${(approved ?? 0).toLocaleString("en-IN")} — send the NBFC a revised quote before marking the last battery ready`,
      );
    }

    await tx.update(refurbishmentJobs).set({ status: "ready", ready_at: now, updated_at: now }).where(eq(refurbishmentJobs.id, job.id));
    await appendEvent(tx, lot, {
      party: "admin",
      kind: "item_ready",
      actor: input.actor_user_id,
      payload: { job_id: job.id, serial: await serialOf(tx, job.battery_id), actual_cost: num(job.actual_cost), accessories_total: accessoriesTotal((job.accessories as AccessoryLine[]) ?? []), lot_ready: allReady },
    });
    await tx
      .update(refurbishmentLots)
      .set(allReady ? { status: "ready", last_party: "admin", updated_at: now } : { updated_at: now })
      .where(eq(refurbishmentLots.id, lot.id));
    await audit(tx, lot, input.actor_user_id, "refurb_item_ready", { job_status: job.status }, { job_id: job.id, lot_status: allReady ? "ready" : lot.status });
  });
  return (await getLot(lot.id, null))!;
}

/** Admin: the bill will exceed the approved quote — ask the NBFC to approve the new total. */
export async function reviseQuote(input: { lot_id: string; actor_user_id: string | null; revised_total: number; note?: string | null }): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, null);
  const to = assertLotMove(lot.status, "revise");
  const approved = num(lot.quote_approved_total) ?? 0;
  if (input.revised_total <= approved) {
    throw new Error(`BAD_REQUEST: the revised total must exceed the approved ₹${approved.toLocaleString("en-IN")} — otherwise no revision is needed`);
  }
  const now = new Date();
  const round = (lot.revision_round ?? 0) + 1;
  await db.transaction(async (tx) => {
    await tx
      .update(refurbishmentLots)
      .set({ status: to, last_party: "admin", revised_total: String(money2(input.revised_total)), revision_note: input.note ?? null, revision_round: round, updated_at: now })
      .where(eq(refurbishmentLots.id, lot.id));
    await appendEvent(tx, lot, { party: "admin", kind: "revision_proposed", message: input.note ?? null, actor: input.actor_user_id, payload: { round, approved_total: approved, revised_total: money2(input.revised_total) } });
    await audit(tx, lot, input.actor_user_id, "refurb_quote_revised", { quote_approved_total: approved }, { revised_total: input.revised_total, round });
  });
  return (await getLot(lot.id, null))!;
}

/** NBFC: approve (new cap) or reject (admin must fit the original) the revised quote. */
export async function respondToRevision(input: { lot_id: string; tenant_id: string; actor_user_id: string | null; kind: "approve" | "reject"; message?: string | null }): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, input.tenant_id);
  const to = assertLotMove(lot.status, input.kind === "approve" ? "approve_revision" : "reject_revision");
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(refurbishmentLots)
      .set({
        status: to,
        last_party: "nbfc",
        ...(input.kind === "approve" ? { quote_approved_total: lot.revised_total, quote_approved_at: now, quote_approved_by: asUuid(input.actor_user_id) } : {}),
        revised_total: null,
        updated_at: now,
      })
      .where(eq(refurbishmentLots.id, lot.id));
    await appendEvent(tx, lot, {
      party: "nbfc",
      kind: input.kind === "approve" ? "revision_approved" : "revision_rejected",
      message: input.message ?? null,
      actor: input.actor_user_id,
      payload: { round: lot.revision_round, revised_total: num(lot.revised_total), approved_total: input.kind === "approve" ? num(lot.revised_total) : num(lot.quote_approved_total) },
    });
    await audit(tx, lot, input.actor_user_id, "refurb_revision_answer", { revised_total: num(lot.revised_total) }, { kind: input.kind, quote_approved_total: input.kind === "approve" ? num(lot.revised_total) : num(lot.quote_approved_total) });
  });
  return (await getLot(lot.id, input.tenant_id))!;
}

// ---------------------------------------------------------------------------
// Thread + photos
// ---------------------------------------------------------------------------
export async function postMessage(input: { lot_id: string; tenant_id: string | null; actor_user_id: string | null; party: Party; message: string }): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, input.tenant_id);
  if (!input.message.trim()) throw new Error("BAD_REQUEST: empty message");
  await db.transaction(async (tx) => {
    await appendEvent(tx, lot, { party: input.party, kind: "message", message: input.message.trim(), actor: input.actor_user_id });
    await tx.update(refurbishmentLots).set({ updated_at: new Date() }).where(eq(refurbishmentLots.id, lot.id));
  });
  return (await getLot(lot.id, input.tenant_id))!;
}

export type PhotoTarget = "out_dispatch" | "out_receipt" | "ret_dispatch" | "ret_receipt" | "out_eway_bill" | "ret_eway_bill";

/** Photos append to a list; an e-way bill REPLACES (one document per leg). */
export async function attachLotPhotos(lot_id: string, tenant_id: string | null, target: PhotoTarget, paths: string[]): Promise<string[]> {
  const lot = await loadLot(lot_id, tenant_id);
  if (target === "out_eway_bill" || target === "ret_eway_bill") {
    const col = target === "out_eway_bill" ? "out_eway_bill_url" : "ret_eway_bill_url";
    const url = paths[paths.length - 1] ?? null;
    await db.update(refurbishmentLots).set({ [col]: url, updated_at: new Date() } as Partial<LotRow>).where(eq(refurbishmentLots.id, lot.id));
    return url ? [url] : [];
  }
  const col =
    target === "out_dispatch" ? "out_photo_urls" : target === "out_receipt" ? "out_receipt_photo_urls" : target === "ret_dispatch" ? "ret_photo_urls" : "ret_receipt_photo_urls";
  const existing = ((lot as unknown as Record<string, unknown>)[col] as string[]) ?? [];
  const next = [...existing, ...paths];
  await db.update(refurbishmentLots).set({ [col]: next, updated_at: new Date() } as Partial<LotRow>).where(eq(refurbishmentLots.id, lot.id));
  return next;
}

export async function attachItemPhotos(lot_id: string, tenant_id: string | null, job_id: string, leg: "out" | "return", paths: string[]): Promise<string[]> {
  await loadLot(lot_id, tenant_id);
  const [job] = await db.select().from(refurbishmentJobs).where(and(eq(refurbishmentJobs.id, job_id), eq(refurbishmentJobs.lot_id, lot_id))).limit(1);
  if (!job) throw new Error("NOT_FOUND: job is not in this lot");
  const col = leg === "out" ? "out_received_photo_urls" : "ret_received_photo_urls";
  const next = [...(job[col] ?? []), ...paths];
  await db.update(refurbishmentJobs).set({ [col]: next, updated_at: new Date() }).where(eq(refurbishmentJobs.id, job.id));
  return next;
}

/** Where every battery of an NBFC that is currently `refurbishing` sits — for the battery register. */
export async function custodyForTenantBatteries(tenant_id: string, battery_ids: string[]): Promise<Map<string, { custody: Custody; lot_id: string; ref_code: string }>> {
  const out = new Map<string, { custody: Custody; lot_id: string; ref_code: string }>();
  if (battery_ids.length === 0) return out;
  const rows = await db
    .select({ job: refurbishmentJobs, lot: refurbishmentLots })
    .from(refurbishmentJobs)
    .innerJoin(refurbishmentLots, eq(refurbishmentLots.id, refurbishmentJobs.lot_id))
    .where(and(eq(refurbishmentJobs.tenant_id, tenant_id), inArray(refurbishmentJobs.battery_id, battery_ids), inArray(refurbishmentJobs.status, OPEN_STATUSES)));
  for (const r of rows) {
    out.set(r.job.battery_id, { custody: custodyForItem(r.lot.status, r.job), lot_id: r.lot.id, ref_code: r.lot.ref_code });
  }
  return out;
}
