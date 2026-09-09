/**
 * E-292 — refurbishment LOTS, v3: the NBFC ⇄ iTarang ⇄ refurbisher loop, as writes.
 *
 * Every function here is one MOVE on a lot: it loads the lot, asserts the move
 * is legal from its status (refurbishment-lot-status.ts), and then, in ONE
 * transaction, updates the lot header, the jobs it carries, the batteries and
 * pipeline rows behind them, writes an nbfc_audit_log row, and appends the
 * move to refurbishment_lot_events. The route that called it then sends the
 * notification (refurbish-notify.ts) — outside the transaction, same as scrap.
 *
 * THREE PARTIES, TWO WALLS. The NBFC never sees the refurbisher (who it is,
 * what it charged, its messages); the refurbisher never sees the money (PI,
 * advance, balance, margin, final bill). Both walls are enforced HERE, in
 * getLot(viewer), not in the components — see redact().
 *
 * WHAT THE BATTERY DOES AT EACH MOVE
 *   createLot          inspected -> refurbishing, pipeline -> refurbishable
 *   decline / cancel   -> inspected, pipeline -> needs_inspection
 *   PI / money / trucks / receipt / assign / work / ready   (no change)
 *   NBFC receipt `received`       -> ready + grade refurbished,
 *                                    pipeline -> ready_for_auction
 *   close (redeploy)              pipeline -> redeploy (stub)
 *
 * The receipt row is the whole point: the NBFC signing for the battery is what
 * sets the job `returned`, and `returned` is the only status
 * refurbishmentCostForBatteries() counts — so the FINAL cost (refurbisher +
 * accessories + pro-rata margin) rolls into the auction base price at exactly
 * the moment the battery is back in the NBFC's hands.
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  refurbishmentLots,
  refurbishmentLotEvents,
  refurbishmentJobs,
  refurbishers,
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
  partsTotal,
  num,
  iso,
  shapeJob,
  type AccessoryLine,
  type ChecklistItem,
  type RefurbisherPart,
  type RefurbishmentJobRow,
} from "@/lib/nbfc/recovery/refurbishment";
import {
  assertLotMove,
  awaitingParty,
  allOpenItemsCosted,
  allOpenItemsReady,
  balanceClearedForReturn,
  custodyForItem,
  nextAfterReceipt,
  shippableOut,
  splitMargin,
  CANCELLABLE_LOT_STATUSES,
  CLOSED_LOT_STATUSES,
  CLOSE_OUTCOMES,
  OPEN_LOT_STATUSES,
  LOT_STATUSES,
  PICKUP_MODES,
  type CloseOutcome,
  type Custody,
  type LotStatus,
  type Party,
  type PickupMode,
  type EventKind,
  type ReceiptCondition,
} from "@/lib/nbfc/recovery/refurbishment-lot-status";

export type LotRow = typeof refurbishmentLots.$inferSelect;
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Who is reading — drives redaction. */
export type Viewer = Party;
/** Who is allowed to see the row at all. `null` = iTarang admin, unscoped. */
export type LotScope = { tenant_id?: string | null; refurbisher_id?: string | null } | null;

// ---------------------------------------------------------------------------
// Shapes the API returns
// ---------------------------------------------------------------------------
export type EventParty = Party | "system";

export interface LotEvent {
  id: string;
  seq: number;
  party: EventParty;
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
  /** [E-292] triage health % — the SOH stand-in when no evaluation exists. */
  health_pct: number | null;
  image_urls: string[];
  battery_state: string | null;
  /** Where this battery physically is, derived. */
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
  reference: string | null;
  recorded_at: string | null;
  confirmed_at: string | null;
  /** E-293: NBFC-uploaded payment slips (relative /api/files paths). */
  proof_urls: string[];
}

export interface PiBankDetails {
  account_name?: string | null;
  account_number?: string | null;
  ifsc?: string | null;
  bank_name?: string | null;
  upi?: string | null;
}

export interface PiView {
  number: string | null;
  url: string | null;
  amount: number | null;
  advance_pct: number | null;
  advance_amount: number | null;
  bank_details: PiBankDetails | null;
  note: string | null;
  sent_at: string | null;
  accepted_at: string | null;
  acceptance_note: string | null;
}

export interface CounterView {
  total: number | null;
  advance_pct: number | null;
  receipt_date: string | null;
  return_date: string | null;
  message: string | null;
}

export interface RefurbisherView {
  id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
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
  reviewed_at: string | null;
  expected_receipt_date: string | null;
  expected_return_date: string | null;
  estimated_labour_total: number | null;
  estimated_accessories_total: number | null;
  estimated_total: number | null;
  proposal_note: string | null;
  counter: CounterView;
  agreed_at: string | null;
  pickup_mode: PickupMode;
  pickup_address: string | null;
  workshop_address: string | null;
  scheduled_pickup_date: string | null;
  /** The agreed commercial baseline — the PI amount once accepted, the estimate before that. */
  quote_approved_total: number | null;
  quote_approved_at: string | null;
  pi: PiView;
  advance_pct: number;
  advance: MoneyLeg;
  refurbisher: RefurbisherView | null;
  assigned_at: string | null;
  refurbisher_note: string | null;
  refurbisher_total: number | null;
  costed_at: string | null;
  margin: { pct: number | null; amount: number | null };
  final_total: number | null;
  final_sent_at: string | null;
  balance: MoneyLeg;
  settled_at: string | null;
  close_outcome: CloseOutcome | null;
  closed_at: string | null;
  close_note: string | null;
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
  /** Sum of refurbisher (or legacy actual / estimated) labour + parts + included accessories over live items. */
  actual_total: number | null;
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
    reference: (r[`${p}_reference`] as string | null) ?? null,
    recorded_at: iso(r[`${p}_recorded_at`]),
    confirmed_at: iso(r[`${p}_confirmed_at`]),
    proof_urls: (r[`${p}_proof_urls`] as string[] | null) ?? [],
  };
}

const EMPTY_MONEY = (p: "advance" | "balance"): MoneyLeg => ({
  amount: null,
  status: p === "advance" ? "not_required" : "not_due",
  provider: null,
  reference: null,
  proof_urls: [],
  recorded_at: null,
  confirmed_at: null,
});
const EMPTY_PI: PiView = { number: null, url: null, amount: null, advance_pct: null, advance_amount: null, bank_details: null, note: null, sent_at: null, accepted_at: null, acceptance_note: null };

export function shapeLot(row: LotRow, tenant_name: string | null, refurbisher: RefurbisherView | null): Lot {
  return {
    id: row.id,
    ref_code: row.ref_code,
    tenant_id: row.tenant_id,
    tenant_name,
    status: row.status as LotStatus,
    awaiting: awaitingParty(row.status, {
      advance_status: row.advance_status,
      balance_status: row.balance_status,
      pickup_mode: row.pickup_mode,
      final_sent_at: row.final_sent_at,
    }),
    battery_count: row.battery_count,
    note: row.note ?? null,
    current_round: row.current_round,
    last_party: (row.last_party as Party | null) ?? null,
    reviewed_at: iso(row.reviewed_at),
    expected_receipt_date: iso(row.expected_receipt_date),
    expected_return_date: iso(row.expected_return_date),
    estimated_labour_total: num(row.estimated_labour_total),
    estimated_accessories_total: num(row.estimated_accessories_total),
    estimated_total: num(row.estimated_total),
    proposal_note: row.proposal_note ?? null,
    counter: {
      total: num(row.counter_total),
      advance_pct: num(row.counter_advance_pct),
      receipt_date: iso(row.counter_receipt_date),
      return_date: iso(row.counter_return_date),
      message: row.counter_message ?? null,
    },
    agreed_at: iso(row.agreed_at),
    pickup_mode: (row.pickup_mode as PickupMode) ?? "nbfc_ships",
    pickup_address: row.pickup_address ?? null,
    workshop_address: row.workshop_address ?? null,
    scheduled_pickup_date: iso(row.scheduled_pickup_date),
    quote_approved_total: num(row.quote_approved_total),
    quote_approved_at: iso(row.quote_approved_at),
    pi: {
      number: row.pi_number ?? null,
      url: row.pi_url ?? null,
      amount: num(row.pi_amount),
      advance_pct: num(row.pi_advance_pct),
      advance_amount: num(row.pi_advance_amount),
      bank_details: (row.pi_bank_details as PiBankDetails | null) ?? null,
      note: row.pi_note ?? null,
      sent_at: iso(row.pi_sent_at),
      accepted_at: iso(row.pi_accepted_at),
      acceptance_note: row.pi_acceptance_note ?? null,
    },
    advance_pct: num(row.advance_pct) ?? 0,
    advance: money(row, "advance"),
    refurbisher,
    assigned_at: iso(row.assigned_at),
    refurbisher_note: row.refurbisher_note ?? null,
    refurbisher_total: num(row.refurbisher_total),
    costed_at: iso(row.costed_at),
    margin: { pct: num(row.itarang_margin_pct), amount: num(row.itarang_margin_amount) },
    final_total: num(row.final_total),
    final_sent_at: iso(row.final_sent_at),
    balance: money(row, "balance"),
    settled_at: iso(row.settled_at),
    close_outcome: (row.close_outcome as CloseOutcome | null) ?? null,
    closed_at: iso(row.closed_at),
    close_note: row.close_note ?? null,
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
function scopeCond(scope: LotScope) {
  return and(
    scope?.tenant_id ? eq(refurbishmentLots.tenant_id, scope.tenant_id) : undefined,
    scope?.refurbisher_id ? eq(refurbishmentLots.refurbisher_id, scope.refurbisher_id) : undefined,
  );
}

export async function loadLot(id: string, scope: LotScope): Promise<LotRow> {
  const [row] = await db
    .select()
    .from(refurbishmentLots)
    .where(and(eq(refurbishmentLots.id, id), scopeCond(scope)))
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
  return rows.map((r) => {
    const health = num(r.battery?.health_pct);
    const measured = r.job.recovery_pipeline_id ? (soh.get(r.job.recovery_pipeline_id) ?? null) : null;
    return {
      ...shapeJob(r.job, r.battery?.serial ?? null),
      model: r.battery?.model ?? null,
      capacity: r.battery?.capacity ?? null,
      condition_grade: r.battery?.condition_grade ?? null,
      soh_pct: measured ?? health,
      health_pct: health,
      image_urls: r.battery?.image_urls ?? [],
      battery_state: r.battery?.state_code ?? null,
      custody: custodyForItem(lot, r.job),
    };
  });
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
    party: e.party as EventParty,
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

async function refurbisherView(id: string | null): Promise<RefurbisherView | null> {
  if (!id) return null;
  const [r] = await db
    .select({ id: refurbishers.id, name: refurbishers.name, contact_name: refurbishers.contact_name, phone: refurbishers.phone, email: refurbishers.email, city: refurbishers.city })
    .from(refurbishers)
    .where(eq(refurbishers.id, id))
    .limit(1);
  return r ? { id: r.id, name: r.name, contact_name: r.contact_name ?? null, phone: r.phone ?? null, email: r.email ?? null, city: r.city ?? null } : null;
}

const liveOf = <T extends { status: string }>(jobs: T[]) =>
  jobs.filter((j) => j.status !== "declined" && j.status !== "cancelled");

/** The refurbisher-side cost of one battery: labour + parts + included accessories. */
function itemBase(j: { refurbisher_cost: unknown; actual_cost: unknown; estimated_cost: unknown; refurbisher_parts: unknown; accessories: unknown }): number {
  const labour = num(j.refurbisher_cost) ?? num(j.actual_cost) ?? num(j.estimated_cost) ?? 0;
  return money2(labour + partsTotal((j.refurbisher_parts as RefurbisherPart[]) ?? []) + accessoriesTotal((j.accessories as AccessoryLine[]) ?? []));
}

/** Σ itemBase over live jobs. */
function actualTotalOf(jobs: Array<{ status: string; refurbisher_cost: unknown; actual_cost: unknown; estimated_cost: unknown; refurbisher_parts: unknown; accessories: unknown }>): number {
  return money2(liveOf(jobs).reduce((s, j) => s + itemBase(j), 0));
}

// The NBFC ⇄ refurbisher walls. A message event carries `payload.to` when an
// admin wrote it, so each side only sees the thread addressed to it.
const NBFC_HIDDEN_KINDS = new Set(["refurbisher_assigned", "item_costed", "all_costed"]);
const REFURBISHER_HIDDEN_KINDS = new Set([
  "estimated", "countered", "accepted", "pi_sent", "pi_accepted", "advance_recorded", "advance_confirmed",
  "balance_recorded", "balance_confirmed", "settled", "final_bill_sent", "closed", "item_declined", "reviewed", "requested",
]);

function redactEvents(events: LotEvent[], viewer: Viewer): LotEvent[] {
  if (viewer === "admin") return events;
  return events
    .filter((e) => {
      if (e.kind === "message") {
        const to = String(e.payload?.to ?? "nbfc");
        if (viewer === "nbfc") return e.party === "nbfc" || e.party === "system" || (e.party === "admin" && to === "nbfc");
        return e.party === "refurbisher" || e.party === "system" || (e.party === "admin" && to === "refurbisher");
      }
      return viewer === "nbfc" ? !NBFC_HIDDEN_KINDS.has(e.kind) : !REFURBISHER_HIDDEN_KINDS.has(e.kind);
    })
    // From the NBFC's side the refurbisher IS iTarang, and the final bill is
    // one number — the refurbisher total / margin split is iTarang's business.
    .map((e) => {
      if (viewer !== "nbfc") return e;
      const party = e.party === "refurbisher" ? ("admin" as const) : e.party;
      if (e.kind === "final_bill_sent") {
        // Refurbisher total, margin and billed_from stay iTarang-internal.
        const { final_total, balance_expected, resent } = e.payload as { final_total?: unknown; balance_expected?: unknown; resent?: unknown };
        return { ...e, party, payload: { final_total, balance_expected, resent } };
      }
      return { ...e, party };
    });
}

function redact(detail: LotDetail, viewer: Viewer): LotDetail {
  if (viewer === "admin") return detail;
  if (viewer === "nbfc") {
    return {
      ...detail,
      refurbisher: null,
      refurbisher_note: null,
      refurbisher_total: null,
      margin: { pct: null, amount: null },
      items: detail.items.map((i) => ({ ...i, refurbisher_cost: null, refurbisher_parts: [], refurbisher_note: null, costed_at: null })),
      events: redactEvents(detail.events, viewer),
    };
  }
  // refurbisher: no money, no commercials, no NBFC-facing figures
  return {
    ...detail,
    note: null,
    estimated_labour_total: null,
    estimated_accessories_total: null,
    estimated_total: null,
    proposal_note: null,
    counter: { total: null, advance_pct: null, receipt_date: null, return_date: null, message: null },
    quote_approved_total: null,
    quote_approved_at: null,
    pi: EMPTY_PI,
    advance_pct: 0,
    advance: EMPTY_MONEY("advance"),
    margin: { pct: null, amount: null },
    final_total: null,
    final_sent_at: detail.final_sent_at, // "costs are frozen" is something the refurbisher must know
    balance: EMPTY_MONEY("balance"),
    settled_at: null,
    close_outcome: null,
    closed_at: null,
    close_note: null,
    actual_total: null,
    items: detail.items.map((i) => ({ ...i, estimated_cost: null, actual_cost: null, total_cost: null, final_cost: null, decline_reason: null })),
    events: redactEvents(detail.events, viewer),
  };
}

export async function getLot(id: string, scope: LotScope, viewer: Viewer = "admin"): Promise<LotDetail | null> {
  let lot: LotRow;
  try {
    lot = await loadLot(id, scope);
  } catch {
    return null;
  }
  const [items, events, name, ref] = await Promise.all([loadItems(lot), loadEvents(lot.id), tenantName(lot.tenant_id), refurbisherView(lot.refurbisher_id)]);
  const live = liveOf(items);
  const actual_total = live.length ? actualTotalOf(items as never) : null;
  return redact({ ...shapeLot(lot, name, ref), items, events, actual_total }, viewer);
}

export async function listLots(input: {
  tenant_id?: string | null;
  refurbisher_id?: string | null;
  status?: LotStatus | "open" | "closed" | "all";
}): Promise<{ items: Lot[]; counts: Record<string, number> }> {
  const status = input.status ?? "open";
  const statusCond =
    status === "all"
      ? undefined
      : status === "open"
        ? inArray(refurbishmentLots.status, OPEN_LOT_STATUSES)
        : status === "closed"
          ? inArray(refurbishmentLots.status, CLOSED_LOT_STATUSES)
          : eq(refurbishmentLots.status, status);
  const scope = scopeCond({ tenant_id: input.tenant_id ?? null, refurbisher_id: input.refurbisher_id ?? null });

  const [rows, countRows] = await Promise.all([
    db
      .select({ lot: refurbishmentLots, tenant_name: nbfcTenants.display_name, ref: refurbishers })
      .from(refurbishmentLots)
      .leftJoin(nbfcTenants, eq(nbfcTenants.id, refurbishmentLots.tenant_id))
      .leftJoin(refurbishers, eq(refurbishers.id, refurbishmentLots.refurbisher_id))
      .where(and(scope, statusCond))
      .orderBy(desc(refurbishmentLots.created_at))
      .limit(200),
    db
      .select({ status: refurbishmentLots.status, n: sql<number>`count(*)::int` })
      .from(refurbishmentLots)
      .where(scope)
      .groupBy(refurbishmentLots.status),
  ]);
  const counts: Record<string, number> = {};
  for (const s of LOT_STATUSES) counts[s] = 0;
  for (const r of countRows) counts[r.status] = Number(r.n);
  counts.open = OPEN_LOT_STATUSES.reduce((s, k) => s + (counts[k] ?? 0), 0);
  const items = rows.map((r) => {
    const ref = r.ref ? { id: r.ref.id, name: r.ref.name, contact_name: r.ref.contact_name ?? null, phone: r.ref.phone ?? null, email: r.ref.email ?? null, city: r.ref.city ?? null } : null;
    const lot = shapeLot(r.lot, r.tenant_name ?? null, ref);
    // List rows are read by all three sides; strip the same walls.
    if (input.refurbisher_id) return { ...lot, pi: EMPTY_PI, advance: EMPTY_MONEY("advance"), balance: EMPTY_MONEY("balance"), final_total: null, margin: { pct: null, amount: null }, quote_approved_total: null, estimated_total: null, note: null };
    if (input.tenant_id) return { ...lot, refurbisher: null, refurbisher_total: null, refurbisher_note: null, margin: { pct: null, amount: null } };
    return lot;
  });
  return { items, counts };
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
  /** [E-292] triage health % (the SOH stand-in) and what the NBFC chose. */
  health_pct: number | null;
  triage_choice: string | null;
  image_urls: string[];
  recovery_pipeline_id: string | null;
  /** null = eligible; otherwise the reason it is listed greyed out. */
  blocked_reason: string | null;
  /** Why iTarang refused it last time — so the NBFC fixes that before resubmitting. */
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
    const health = num(b.health_pct);
    const s = (b.recovery_pipeline_id ? (soh.get(b.recovery_pipeline_id) ?? null) : null) ?? health;
    let blocked: string | null = null;
    if (busy.has(b.id)) blocked = "already has an open refurbishment job";
    else if (s === null) blocked = "no state of health recorded — record the recovery details (triage) or evaluate it first";
    else if (s < SOH_REFURBISHABLE_MIN) blocked = `health ${s}% is below the ${SOH_REFURBISHABLE_MIN}% refurbishment floor — not suitable for refurbishing`;
    const d = lastDecline.get(b.id);
    return {
      id: b.id,
      serial: b.serial,
      model: b.model ?? null,
      capacity: b.capacity ?? null,
      condition_grade: b.condition_grade ?? null,
      soh_pct: s,
      health_pct: health,
      triage_choice: b.triage_choice ?? null,
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
  ev: { party: EventParty; kind: EventKind; message?: string | null; payload?: Record<string, unknown>; actor?: string | null },
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

async function reload(lot_id: string, scope: LotScope, viewer: Viewer): Promise<LotDetail> {
  return (await getLot(lot_id, scope, viewer))!;
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
    // The evaluation wins; the triage health % stands in when there is none.
    const s = (b.recovery_pipeline_id ? (soh.get(b.recovery_pipeline_id) ?? null) : null) ?? num(b.health_pct);
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
  // Resubmission after a decline: link the previous lot.
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
            // step 1: "recovery details carried over"
            triage: batteries.map((b) => ({ serial: b.serial, health_pct: num(b.health_pct), rated_v: num(b.rated_voltage_v), measured_v: num(b.measured_voltage_v), condition: b.triage_condition ?? null })),
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
  return reload(lotId, { tenant_id: input.tenant_id }, "nbfc");
}

// ---------------------------------------------------------------------------
// 2. Admin: review — decline per battery, then "mark reviewed"
// ---------------------------------------------------------------------------
export async function reviewLotItems(input: {
  lot_id: string;
  actor_user_id: string | null;
  decisions: Array<{ job_id: string; decision: "accept" | "decline"; reason?: string | null }>;
  note?: string | null;
}): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, null);
  const to = assertLotMove(lot.status, "review");
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
          : { status: to, reviewed_at: now, reviewed_by: asUuid(input.actor_user_id), last_party: "admin" }),
        updated_at: now,
      })
      .where(eq(refurbishmentLots.id, lot.id));
    if (allGone) {
      await appendEvent(tx, lot, { party: "system", kind: "cancelled", message: "Every battery was declined, so the lot is closed.", payload: { by: "admin" } });
    } else if (lot.status === "requested" || declined > 0) {
      await appendEvent(tx, lot, { party: "admin", kind: "reviewed", message: input.note ?? null, actor: input.actor_user_id, payload: { declined, battery_count: remaining } });
    }
    await audit(tx, lot, input.actor_user_id, "refurb_lot_reviewed", { battery_count: lot.battery_count, status: lot.status }, { declined, battery_count: remaining, status: allGone ? "cancelled" : to });
  });
  return reload(lot.id, null, "admin");
}

// ---------------------------------------------------------------------------
// 3. Admin: the estimate — timeline + costing + advance %
// ---------------------------------------------------------------------------
export interface EstimateItem {
  job_id: string;
  estimated_cost: number;
  accessories?: AccessoryLine[];
}

export async function estimateLot(input: {
  lot_id: string;
  actor_user_id: string | null;
  expected_receipt_date: string; // YYYY-MM-DD
  expected_return_date: string;
  items: EstimateItem[];
  note?: string | null;
  pickup_mode?: PickupMode;
  pickup_address?: string | null;
  workshop_address?: string | null;
  scheduled_pickup_date?: string | null;
  advance_pct?: number;
}): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, null);
  const to = assertLotMove(lot.status, "estimate");
  if (input.expected_return_date < input.expected_receipt_date) {
    throw new Error("BAD_REQUEST: the return date cannot be before the receipt date");
  }
  const pickup_mode: PickupMode = input.pickup_mode ?? "nbfc_ships";
  if (!PICKUP_MODES.includes(pickup_mode)) throw new Error("BAD_REQUEST: unknown pickup mode");
  const advance_pct = input.advance_pct ?? 0;
  if (advance_pct < 0 || advance_pct > 100) throw new Error("BAD_REQUEST: advance must be between 0 and 100 percent");

  const now = new Date();
  await db.transaction(async (tx) => {
    const jobs = liveOf(await lotJobs(tx, lot.id));
    if (jobs.length === 0) throw new Error("CONFLICT: the lot has no batteries left to estimate");
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
      kind: "estimated",
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
    await audit(tx, lot, input.actor_user_id, "refurb_lot_estimated", { status: lot.status }, { status: to, round, estimated_total: total, advance_pct, pickup_mode });
  });
  return reload(lot.id, null, "admin");
}

// ---------------------------------------------------------------------------
// 4. NBFC: accept the estimate, or counter (cost / timeline / advance %)
// ---------------------------------------------------------------------------
export async function respondToEstimate(input: {
  lot_id: string;
  tenant_id: string;
  actor_user_id: string | null;
  kind: "accept" | "counter";
  message?: string | null;
  counter_total?: number | null;
  counter_advance_pct?: number | null;
  requested_receipt_date?: string | null;
  requested_return_date?: string | null;
}): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, { tenant_id: input.tenant_id });
  const to = assertLotMove(lot.status, input.kind);
  if (
    input.kind === "counter" &&
    !input.message?.trim() &&
    input.counter_total == null &&
    input.counter_advance_pct == null &&
    !input.requested_receipt_date &&
    !input.requested_return_date
  ) {
    throw new Error("BAD_REQUEST: say what should change — a price, an advance %, the dates you need, or a message");
  }
  if (input.counter_advance_pct != null && (input.counter_advance_pct < 0 || input.counter_advance_pct > 100)) {
    throw new Error("BAD_REQUEST: advance must be between 0 and 100 percent");
  }
  const now = new Date();
  const total = num(lot.estimated_total) ?? 0;

  await db.transaction(async (tx) => {
    await tx
      .update(refurbishmentLots)
      .set({
        status: to,
        last_party: "nbfc",
        ...(input.kind === "accept"
          ? {
              agreed_at: now,
              agreed_by: asUuid(input.actor_user_id),
              // The commercial baseline until the PI replaces it.
              quote_approved_total: String(total),
              quote_approved_at: now,
              quote_approved_by: asUuid(input.actor_user_id),
            }
          : {
              counter_total: input.counter_total != null ? String(money2(input.counter_total)) : null,
              counter_advance_pct: input.counter_advance_pct != null ? String(input.counter_advance_pct) : null,
              counter_receipt_date: input.requested_receipt_date ?? null,
              counter_return_date: input.requested_return_date ?? null,
              counter_message: input.message?.trim() || null,
            }),
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
          ? { round: lot.current_round, expected_receipt_date: iso(lot.expected_receipt_date), expected_return_date: iso(lot.expected_return_date), agreed_total: total, advance_pct: num(lot.advance_pct) ?? 0, pickup_mode: lot.pickup_mode }
          : { round: lot.current_round, counter_total: input.counter_total ?? null, counter_advance_pct: input.counter_advance_pct ?? null, requested_receipt_date: input.requested_receipt_date ?? null, requested_return_date: input.requested_return_date ?? null },
    });
    await audit(tx, lot, input.actor_user_id, input.kind === "accept" ? "refurb_lot_agreed" : "refurb_lot_countered", { status: lot.status }, { status: to, round: lot.current_round, agreed_total: total, counter_total: input.counter_total ?? null });
  });
  return reload(lot.id, { tenant_id: input.tenant_id }, "nbfc");
}

// ---------------------------------------------------------------------------
// 5 / 6. The proforma invoice — admin sends, NBFC accepts
// ---------------------------------------------------------------------------
export async function sendPi(input: {
  lot_id: string;
  actor_user_id: string | null;
  pi_number?: string | null;
  /** Relative /api/files path from the `pi_document` upload; falls back to the one already on the lot. */
  pi_url?: string | null;
  pi_amount: number;
  pi_advance_pct?: number;
  bank_details: PiBankDetails;
  note?: string | null;
}): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, null);
  const to = assertLotMove(lot.status, "send_pi");
  const url = input.pi_url ?? lot.pi_url ?? null;
  if (!url) throw new Error("BAD_REQUEST: upload the proforma invoice PDF first");
  if (!(input.pi_amount > 0)) throw new Error("BAD_REQUEST: the PI amount must be positive");
  const pct = input.pi_advance_pct ?? num(lot.advance_pct) ?? 0;
  if (pct < 0 || pct > 100) throw new Error("BAD_REQUEST: advance must be between 0 and 100 percent");
  const bank = input.bank_details ?? {};
  if (!(bank.account_number?.trim() && bank.ifsc?.trim()) && !bank.upi?.trim()) {
    throw new Error("BAD_REQUEST: give the bank details the NBFC pays into — account number + IFSC, or a UPI id");
  }
  const amount = money2(input.pi_amount);
  const advance_amount = pct > 0 ? money2((amount * pct) / 100) : 0;
  const number = input.pi_number?.trim() || `PI-${lot.ref_code}${lot.pi_sent_at ? `-${Date.now().toString(36).toUpperCase().slice(-4)}` : ""}`;
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(refurbishmentLots)
      .set({
        status: to,
        last_party: "admin",
        pi_number: number,
        pi_url: url,
        pi_amount: String(amount),
        pi_advance_pct: String(pct),
        pi_advance_amount: pct > 0 ? String(advance_amount) : null,
        pi_bank_details: bank,
        pi_note: input.note ?? null,
        pi_sent_at: now,
        pi_sent_by: asUuid(input.actor_user_id),
        // a re-sent PI supersedes any earlier acceptance
        pi_accepted_at: null,
        pi_accepted_by: null,
        pi_acceptance_note: null,
        updated_at: now,
      })
      .where(eq(refurbishmentLots.id, lot.id));
    await appendEvent(tx, lot, {
      party: "admin",
      kind: "pi_sent",
      message: input.note ?? null,
      actor: input.actor_user_id,
      payload: { pi_number: number, pi_amount: amount, advance_pct: pct, advance_amount, resent: !!lot.pi_sent_at, bank_name: bank.bank_name ?? null },
    });
    await audit(tx, lot, input.actor_user_id, "refurb_pi_sent", { status: lot.status, pi_amount: num(lot.pi_amount) }, { status: to, pi_number: number, pi_amount: amount, advance_pct: pct });
  });
  return reload(lot.id, null, "admin");
}

export async function acceptPi(input: { lot_id: string; tenant_id: string; actor_user_id: string | null; note?: string | null }): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, { tenant_id: input.tenant_id });
  const to = assertLotMove(lot.status, "accept_pi");
  const amount = num(lot.pi_amount) ?? 0;
  const pct = num(lot.pi_advance_pct) ?? 0;
  const advance_amount = pct > 0 ? money2((amount * pct) / 100) : 0;
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(refurbishmentLots)
      .set({
        status: to,
        last_party: "nbfc",
        pi_accepted_at: now,
        pi_accepted_by: asUuid(input.actor_user_id),
        pi_acceptance_note: input.note ?? null,
        // The PI is now THE commercial baseline.
        quote_approved_total: String(amount),
        quote_approved_at: now,
        quote_approved_by: asUuid(input.actor_user_id),
        advance_pct: String(pct),
        advance_amount: pct > 0 ? String(advance_amount) : null,
        advance_status: pct > 0 ? "pending" : "not_required",
        updated_at: now,
      })
      .where(eq(refurbishmentLots.id, lot.id));
    await appendEvent(tx, lot, {
      party: "nbfc",
      kind: "pi_accepted",
      message: input.note ?? null,
      actor: input.actor_user_id,
      payload: { pi_number: lot.pi_number, pi_amount: amount, advance_pct: pct, advance_amount, advance_required: pct > 0 },
    });
    await audit(tx, lot, input.actor_user_id, "refurb_pi_accepted", { status: lot.status }, { status: to, pi_amount: amount, advance_amount });
  });
  return reload(lot.id, { tenant_id: input.tenant_id }, "nbfc");
}

/** After admin confirms the advance (refurb-payments.ts calls this inside its tx). */
export async function confirmAdvance(tx: Tx, lot: LotRow, actor: string | null, now: Date): Promise<LotStatus> {
  const to = assertLotMove(lot.status, "advance_received");
  await tx.update(refurbishmentLots).set({ status: to, last_party: "admin", updated_at: now }).where(eq(refurbishmentLots.id, lot.id));
  void actor;
  return to;
}

// ---------------------------------------------------------------------------
// Cancel — NBFC or admin, only before anything moved
// ---------------------------------------------------------------------------
export async function cancelLot(input: {
  lot_id: string;
  tenant_id: string | null;
  actor_user_id: string | null;
  party: "nbfc" | "admin";
  reason?: string | null;
}): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, input.tenant_id ? { tenant_id: input.tenant_id } : null);
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
  return reload(lot.id, input.tenant_id ? { tenant_id: input.tenant_id } : null, input.party);
}

// ---------------------------------------------------------------------------
// 8a / 8b / 14. Trucks — NBFC dispatch, iTarang pickup, return dispatch
// ---------------------------------------------------------------------------
export interface TransportInput {
  lot_id: string;
  scope: LotScope;
  actor_user_id: string | null;
  carrier?: string | null;
  vehicle_no?: string | null;
  docket_no?: string | null;
  /** Optional on both legs (v3). */
  eway_bill_no?: string | null;
  eway_bill_url?: string | null;
  dispatched_on: string; // YYYY-MM-DD
  note?: string | null;
  photo_urls?: string[];
}

async function writeTransport(tx: Tx, lot: LotRow, p: "out" | "ret", input: TransportInput, extra: Partial<LotRow>, now: Date) {
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

/** 8a: NBFC ships (nbfc_ships mode). 14: admin or refurbisher ships back. */
export async function recordDispatch(input: TransportInput & { leg: "out" | "return"; party: Party }): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, input.scope);
  if (input.leg === "out") {
    if (input.party !== "nbfc") throw new Error("FORBIDDEN: only the NBFC dispatches to iTarang");
    if (!shippableOut(lot)) {
      throw new Error(
        lot.status === "pi_accepted"
          ? `CONFLICT: the advance is ${lot.advance_status === "recorded" ? "recorded but not yet confirmed by iTarang" : "still due"} — the batteries move once it is received`
          : `CONFLICT: a lot that is ${lot.status.replace(/_/g, " ")} cannot be dispatched`,
      );
    }
    if (lot.pickup_mode === "itarang_pickup") {
      throw new Error("CONFLICT: iTarang is collecting this lot — its agent records the pickup, not the NBFC");
    }
  } else if (input.party === "nbfc") {
    throw new Error("FORBIDDEN: the return truck is recorded by iTarang or the refurbisher");
  } else if (!balanceClearedForReturn(lot)) {
    // E-293: the batteries stay with the refurbisher until the NBFC has
    // uploaded the balance payment slip and its bank reference.
    throw new Error(
      `CONFLICT: the balance of ₹${(num(lot.balance_amount) ?? 0).toLocaleString("en-IN")} is still due — the NBFC uploads the payment slip and bank reference before the batteries ship back`,
    );
  }
  const move = input.leg === "out" ? "dispatch_out" : "dispatch_return";
  const to = assertLotMove(lot.status, move);
  const p = input.leg === "out" ? "out" : "ret";
  const now = new Date();
  await db.transaction(async (tx) => {
    const payload = await writeTransport(tx, lot, p, input, { status: to, last_party: input.party }, now);
    await appendEvent(tx, lot, { party: input.party, kind: input.leg === "out" ? "dispatched_out" : "dispatched_return", message: input.note ?? null, actor: input.actor_user_id, payload });
    await audit(tx, lot, input.actor_user_id, "refurb_lot_dispatched", { status: lot.status }, { status: to, leg: input.leg, by: input.party, docket_no: input.docket_no ?? null, eway_bill_no: input.eway_bill_no ?? null });
  });
  return reload(lot.id, input.scope, input.party);
}

/** 8b: iTarang's agent collected the batteries (itarang_pickup mode). */
export async function recordPickup(input: TransportInput): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, null);
  if (!shippableOut(lot)) {
    throw new Error(
      lot.status === "pi_accepted"
        ? `CONFLICT: the advance is ${lot.advance_status === "recorded" ? "recorded but not yet confirmed" : "still due"} — confirm it before collecting`
        : `CONFLICT: a lot that is ${lot.status.replace(/_/g, " ")} cannot be picked up`,
    );
  }
  if (lot.pickup_mode !== "itarang_pickup") {
    throw new Error("CONFLICT: the NBFC ships this lot — it records the dispatch, not iTarang");
  }
  const to = assertLotMove(lot.status, "pickup");
  const now = new Date();
  await db.transaction(async (tx) => {
    const payload = await writeTransport(tx, lot, "out", input, { status: to, last_party: "admin", out_picked_up_at: now, out_picked_up_by: asUuid(input.actor_user_id) }, now);
    await appendEvent(tx, lot, { party: "admin", kind: "picked_up", message: input.note ?? null, actor: input.actor_user_id, payload });
    await audit(tx, lot, input.actor_user_id, "refurb_lot_picked_up", { status: lot.status }, { status: to, docket_no: input.docket_no ?? null, eway_bill_no: input.eway_bill_no ?? null });
  });
  return reload(lot.id, null, "admin");
}

/**
 * The truck reached the gate. On the OUT leg this is a timestamp + event only
 * (the receipt is the state change); on the RETURN leg it is `delivered_back`.
 */
export async function markArrived(input: { lot_id: string; scope: LotScope; actor_user_id: string | null; leg: "out" | "return"; note?: string | null }): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, input.scope);
  const now = new Date();
  if (input.leg === "out") {
    if (lot.status !== "in_transit_out") throw new Error(`CONFLICT: a lot that is ${lot.status.replace(/_/g, " ")} is not on its way to iTarang`);
    if (lot.out_delivered_at) throw new Error("CONFLICT: this lot was already marked arrived — sign for each battery next");
    await db.transaction(async (tx) => {
      await tx.update(refurbishmentLots).set({ out_delivered_at: now, out_delivered_by: asUuid(input.actor_user_id), updated_at: now }).where(eq(refurbishmentLots.id, lot.id));
      await appendEvent(tx, lot, { party: "admin", kind: "arrived_out", message: input.note ?? null, actor: input.actor_user_id, payload: { leg: "out" } });
      await audit(tx, lot, input.actor_user_id, "refurb_lot_arrived", { status: lot.status }, { status: lot.status, leg: "out" });
    });
    return reload(lot.id, input.scope, "admin");
  }
  const to = assertLotMove(lot.status, "arrive_return");
  await db.transaction(async (tx) => {
    await tx.update(refurbishmentLots).set({ status: to, last_party: "nbfc", ret_delivered_at: now, ret_delivered_by: asUuid(input.actor_user_id), updated_at: now }).where(eq(refurbishmentLots.id, lot.id));
    await appendEvent(tx, lot, { party: "nbfc", kind: "arrived_return", message: input.note ?? null, actor: input.actor_user_id, payload: { leg: "return" } });
    await audit(tx, lot, input.actor_user_id, "refurb_lot_arrived", { status: lot.status }, { status: to, leg: "return" });
  });
  return reload(lot.id, input.scope, "nbfc");
}

// ---------------------------------------------------------------------------
// 9 / 15. Receipt — admin signs for the batteries, NBFC signs for them back
// ---------------------------------------------------------------------------
export interface ReceiptInput {
  lot_id: string;
  scope: LotScope;
  actor_user_id: string | null;
  leg: "out" | "return";
  items: Array<{ job_id: string; condition: ReceiptCondition; note?: string | null; photo_urls?: string[] }>;
  note?: string | null;
  photo_urls?: string[];
}

export async function confirmReceipt(input: ReceiptInput): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, input.scope);
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
    const stillOpen = after.filter((j) => j.status === "ready" || j.status === "at_refurbisher" || j.status === "in_progress" || j.status === "requested");

    // Money on the return leg: final bill minus the confirmed advance.
    let moneyPatch: Partial<LotRow> = {};
    let lotStatus: LotStatus = to;
    if (input.leg === "return") {
      if (stillOpen.length > 0) {
        lotStatus = "delivered_back"; // partial receipt — still waiting on the flagged ones
      } else {
        // final_total was fixed at step 13 (setFinalCost); a legacy lot without one falls back to the actuals.
        const final_total = num(lot.final_total) ?? actualTotalOf(after);
        const advanceConfirmed = lot.advance_status === "confirmed" ? (num(lot.advance_amount) ?? 0) : 0;
        // E-293: the balance leg was opened when the final bill went out and
        // is normally recorded/confirmed by now (it gates the return truck).
        // Never reopen a leg the NBFC has already paid against.
        const legOpen = lot.balance_status === "recorded" || lot.balance_status === "confirmed";
        const balance = legOpen ? (num(lot.balance_amount) ?? money2(Math.max(0, final_total - advanceConfirmed))) : money2(Math.max(0, final_total - advanceConfirmed));
        lotStatus = nextAfterReceipt(balance, lot.balance_status);
        moneyPatch = {
          final_total: String(final_total),
          balance_amount: String(balance),
          balance_status: legOpen ? lot.balance_status : balance > 0.005 ? "pending" : "not_due",
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
        // receipt without a separate "arrived" click still stamps the arrival
        ...(input.leg === "out" && !lot.out_delivered_at ? { out_delivered_at: now, out_delivered_by: asUuid(input.actor_user_id) } : {}),
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
  return reload(lot.id, input.scope, party);
}

// ---------------------------------------------------------------------------
// 10. Admin: assign the lot to a refurbisher (internal — the NBFC is not told)
// ---------------------------------------------------------------------------
export async function assignRefurbisher(input: { lot_id: string; actor_user_id: string | null; refurbisher_id: string; note?: string | null }): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, null);
  const to = assertLotMove(lot.status, "assign");
  if (lot.work_started_at) throw new Error("CONFLICT: the refurbisher has already started — the lot cannot be re-assigned");
  const [ref] = await db.select({ id: refurbishers.id, name: refurbishers.name, active: refurbishers.is_active }).from(refurbishers).where(eq(refurbishers.id, input.refurbisher_id)).limit(1);
  if (!ref) throw new Error("NOT_FOUND: refurbisher not found");
  if (!ref.active) throw new Error(`CONFLICT: ${ref.name} is deactivated — pick an active refurbisher`);
  const now = new Date();
  await db.transaction(async (tx) => {
    const jobs = liveOf(await lotJobs(tx, lot.id));
    const workable = jobs.filter((j) => j.status === "requested" && j.out_received_condition !== "missing");
    if (workable.length) {
      await tx.update(refurbishmentJobs).set({ status: "at_refurbisher", assigned_workshop: ref.name, updated_at: now }).where(inArray(refurbishmentJobs.id, workable.map((j) => j.id)));
    }
    // A battery that never arrived closes out here and goes back to the NBFC's register.
    const missing = jobs.filter((j) => j.out_received_condition === "missing" && j.status === "requested");
    if (missing.length) {
      await tx.update(refurbishmentJobs).set({ status: "cancelled", notes: "missing at iTarang receipt", updated_at: now }).where(inArray(refurbishmentJobs.id, missing.map((j) => j.id)));
      for (const j of missing) await releaseBattery(tx, j, now);
    }
    const already = jobs.filter((j) => j.status === "at_refurbisher");
    if (already.length && lot.refurbisher_id !== ref.id) {
      await tx.update(refurbishmentJobs).set({ assigned_workshop: ref.name, updated_at: now }).where(inArray(refurbishmentJobs.id, already.map((j) => j.id)));
    }
    const count = workable.length + already.length;
    if (count === 0) throw new Error("CONFLICT: no battery in this lot arrived — nothing to assign");
    await tx
      .update(refurbishmentLots)
      .set({ status: to, refurbisher_id: ref.id, assigned_at: now, assigned_by: asUuid(input.actor_user_id), refurbisher_note: input.note ?? null, battery_count: count, last_party: "admin", updated_at: now })
      .where(eq(refurbishmentLots.id, lot.id));
    await appendEvent(tx, lot, {
      party: "admin",
      kind: "refurbisher_assigned",
      message: input.note ?? null,
      actor: input.actor_user_id,
      payload: { refurbisher_id: ref.id, refurbisher_name: ref.name, batteries: count, missing_closed: missing.length, reassigned: !!lot.refurbisher_id && lot.refurbisher_id !== ref.id },
    });
    await audit(tx, lot, input.actor_user_id, "refurb_ref_assigned", { status: lot.status, refurbisher_id: lot.refurbisher_id }, { status: to, refurbisher_id: ref.id, batteries: count });
  });
  return reload(lot.id, null, "admin");
}

// ---------------------------------------------------------------------------
// 11 / 12. Refurbisher (or admin override): work, cost per battery
// ---------------------------------------------------------------------------
export async function startWork(input: { lot_id: string; scope: LotScope; actor_user_id: string | null; party: "refurbisher" | "admin" }): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, input.scope);
  const to = assertLotMove(lot.status, "start_work");
  const now = new Date();
  await db.transaction(async (tx) => {
    const jobs = liveOf(await lotJobs(tx, lot.id)).filter((j) => j.status === "at_refurbisher");
    if (jobs.length) {
      await tx.update(refurbishmentJobs).set({ started_at: now, updated_at: now }).where(inArray(refurbishmentJobs.id, jobs.map((j) => j.id)));
    }
    await tx.update(refurbishmentLots).set({ status: to, work_started_at: now, last_party: input.party, updated_at: now }).where(eq(refurbishmentLots.id, lot.id));
    await appendEvent(tx, lot, { party: input.party, kind: "work_started", actor: input.actor_user_id, payload: { batteries: jobs.length } });
    await audit(tx, lot, input.actor_user_id, "refurb_lot_started", { status: lot.status }, { status: to, by: input.party });
  });
  return reload(lot.id, input.scope, input.party);
}

const WORK_EDITABLE: LotStatus[] = ["at_refurbisher", "in_progress", "costed"];

/** Edit a battery's checklist / accessories / notes while the lot sits with the refurbisher (no event). */
export async function updateLotItem(input: {
  lot_id: string;
  job_id: string;
  scope: LotScope;
  actor_user_id: string | null;
  checklist?: ChecklistItem[];
  accessories?: AccessoryLine[];
  refurbisher_parts?: RefurbisherPart[];
  refurbisher_cost?: number | null;
  refurbisher_note?: string | null;
  notes?: string | null;
}): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, input.scope);
  if (!WORK_EDITABLE.includes(lot.status as LotStatus)) {
    throw new Error(`CONFLICT: work details can only be edited while the lot is with the refurbisher (it is ${lot.status.replace(/_/g, " ")})`);
  }
  if (lot.final_sent_at) throw new Error("CONFLICT: the final bill has been sent to the NBFC — costs are frozen");
  const [job] = await db.select().from(refurbishmentJobs).where(and(eq(refurbishmentJobs.id, input.job_id), eq(refurbishmentJobs.lot_id, lot.id))).limit(1);
  if (!job) throw new Error("NOT_FOUND: job is not in this lot");
  await db
    .update(refurbishmentJobs)
    .set({
      ...(input.checklist !== undefined ? { checklist: input.checklist } : {}),
      ...(input.accessories !== undefined ? { accessories: input.accessories } : {}),
      ...(input.refurbisher_parts !== undefined ? { refurbisher_parts: input.refurbisher_parts } : {}),
      ...(input.refurbisher_cost !== undefined ? { refurbisher_cost: input.refurbisher_cost === null ? null : String(money2(input.refurbisher_cost)) } : {}),
      ...(input.refurbisher_note !== undefined ? { refurbisher_note: input.refurbisher_note } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      updated_at: new Date(),
    })
    .where(eq(refurbishmentJobs.id, job.id));
  return reload(lot.id, input.scope, input.scope?.refurbisher_id ? "refurbisher" : "admin");
}

/** 12: the refurbisher's final cost for ONE battery. When every live battery is costed the lot is `costed`. */
export async function costItem(input: {
  lot_id: string;
  job_id: string;
  scope: LotScope;
  actor_user_id: string | null;
  party: "refurbisher" | "admin";
  refurbisher_cost: number;
  refurbisher_parts?: RefurbisherPart[];
  checklist?: ChecklistItem[];
  accessories?: AccessoryLine[];
  note?: string | null;
}): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, input.scope);
  if (lot.status !== "in_progress" && lot.status !== "costed") {
    throw new Error(`CONFLICT: a battery can only be costed while work is in progress (the lot is ${lot.status.replace(/_/g, " ")})`);
  }
  if (lot.final_sent_at) throw new Error("CONFLICT: the final bill has been sent to the NBFC — costs are frozen");
  if (!(input.refurbisher_cost >= 0)) throw new Error("BAD_REQUEST: the cost cannot be negative");
  const now = new Date();
  await db.transaction(async (tx) => {
    const jobs = await lotJobs(tx, lot.id);
    const job = jobs.find((j) => j.id === input.job_id);
    if (!job) throw new Error("NOT_FOUND: job is not in this lot");
    if (job.status !== "at_refurbisher") throw new Error(`CONFLICT: job is ${job.status.replace(/_/g, " ")}, not at the refurbisher`);
    const parts = input.refurbisher_parts ?? ((job.refurbisher_parts as RefurbisherPart[]) ?? []);
    const accessories = input.accessories ?? ((job.accessories as AccessoryLine[]) ?? []);
    await tx
      .update(refurbishmentJobs)
      .set({
        refurbisher_cost: String(money2(input.refurbisher_cost)),
        refurbisher_parts: parts,
        accessories,
        ...(input.checklist !== undefined ? { checklist: input.checklist } : {}),
        refurbisher_note: input.note ?? job.refurbisher_note ?? null,
        costed_at: now,
        costed_by: asUuid(input.actor_user_id),
        updated_at: now,
      })
      .where(eq(refurbishmentJobs.id, job.id));
    const after = (await lotJobs(tx, lot.id)).map((j) => ({ ...j }));
    const base = itemBase({ refurbisher_cost: input.refurbisher_cost, actual_cost: null, estimated_cost: null, refurbisher_parts: parts, accessories });
    await appendEvent(tx, lot, {
      party: input.party,
      kind: "item_costed",
      message: input.note ?? null,
      actor: input.actor_user_id,
      payload: { job_id: job.id, serial: await serialOf(tx, job.battery_id), refurbisher_cost: money2(input.refurbisher_cost), parts_total: partsTotal(parts), accessories_total: accessoriesTotal(accessories), base },
    });
    const allCosted = allOpenItemsCosted(after);
    const refurbisher_total = actualTotalOf(after);
    if (allCosted) {
      const to = lot.status === "in_progress" ? assertLotMove(lot.status, "all_costed") : lot.status;
      await tx
        .update(refurbishmentLots)
        .set({ status: to, refurbisher_total: String(refurbisher_total), costed_at: lot.costed_at ?? now, last_party: input.party, updated_at: now })
        .where(eq(refurbishmentLots.id, lot.id));
      if (lot.status === "in_progress") {
        await appendEvent(tx, lot, { party: "system", kind: "all_costed", payload: { refurbisher_total, batteries: liveOf(after).length } });
      }
    } else {
      await tx.update(refurbishmentLots).set({ refurbisher_total: String(refurbisher_total), last_party: input.party, updated_at: now }).where(eq(refurbishmentLots.id, lot.id));
    }
    await audit(tx, lot, input.actor_user_id, "refurb_item_costed", { job_status: job.status }, { job_id: job.id, refurbisher_cost: input.refurbisher_cost, lot_status: allCosted ? "costed" : lot.status });
  });
  return reload(lot.id, input.scope, input.party);
}

// ---------------------------------------------------------------------------
// 13. Admin: final bill → NBFC; mark ready
//
// The NBFC is billed the PROFORMA INVOICE amount it accepted at step 7 — that
// figure was fixed when it accepted, and the advance was paid against it. The
// refurbisher's actual cost stays internal to iTarang ⇄ refurbisher: the
// iTarang margin is simply PI − refurbisher total (negative when the workshop
// cost more than was quoted), and it is spread across the batteries so each
// carries its true cost into an auction. Margin inputs are only honoured on a
// legacy lot that never had a PI accepted.
// ---------------------------------------------------------------------------
export async function setFinalCost(input: {
  lot_id: string;
  actor_user_id: string | null;
  margin_pct?: number | null;
  margin_amount?: number | null;
  note?: string | null;
}): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, null);
  if (lot.status !== "costed") throw new Error(`CONFLICT: the final bill can only be set once every battery is costed (the lot is ${lot.status.replace(/_/g, " ")})`);
  const piAmount = lot.pi_accepted_at ? num(lot.pi_amount) : null;
  const billedFromPi = piAmount != null && piAmount > 0;
  if (!billedFromPi) {
    if (input.margin_pct != null && input.margin_amount != null) throw new Error("BAD_REQUEST: give the margin as a percentage OR an amount, not both");
    if (input.margin_pct != null && (input.margin_pct < 0 || input.margin_pct > 100)) throw new Error("BAD_REQUEST: margin must be between 0 and 100 percent");
    if (input.margin_amount != null && input.margin_amount < 0) throw new Error("BAD_REQUEST: margin cannot be negative");
  }
  const now = new Date();
  await db.transaction(async (tx) => {
    const jobs = await lotJobs(tx, lot.id);
    const live = liveOf(jobs);
    if (live.some((j) => j.status === "ready")) throw new Error("CONFLICT: batteries are already marked ready against the current bill");
    const bases = live.map((j) => itemBase(j));
    const refurbisher_total = money2(bases.reduce((s, b) => s + b, 0));
    let margin_amount: number;
    let margin_pct: number;
    let final_total: number;
    if (billedFromPi) {
      final_total = money2(piAmount);
      margin_amount = money2(final_total - refurbisher_total);
      margin_pct = refurbisher_total > 0 ? money2((margin_amount / refurbisher_total) * 100) : 0;
    } else {
      margin_amount = money2(input.margin_amount != null ? input.margin_amount : ((refurbisher_total * (input.margin_pct ?? 0)) / 100));
      margin_pct = input.margin_pct != null ? input.margin_pct : refurbisher_total > 0 ? money2((margin_amount / refurbisher_total) * 100) : 0;
      final_total = money2(refurbisher_total + margin_amount);
    }
    const finals = splitMargin(bases, margin_amount);
    for (let i = 0; i < live.length; i++) {
      await tx.update(refurbishmentJobs).set({ final_cost: String(finals[i]), updated_at: now }).where(eq(refurbishmentJobs.id, live[i].id));
    }
    const advanceConfirmed = lot.advance_status === "confirmed" ? (num(lot.advance_amount) ?? 0) : 0;
    const balanceAmount = money2(Math.max(0, final_total - advanceConfirmed));
    // E-293: the balance is due NOW — before the batteries ship back. A
    // re-sent bill re-opens a leg that was merely pending; one the NBFC has
    // already recorded / iTarang confirmed keeps its state and its slips.
    const balanceStatus =
      lot.balance_status === "recorded" || lot.balance_status === "confirmed"
        ? lot.balance_status
        : balanceAmount > 0.005 ? "pending" : "not_due";
    await tx
      .update(refurbishmentLots)
      .set({
        refurbisher_total: String(refurbisher_total),
        itarang_margin_pct: String(margin_pct),
        itarang_margin_amount: String(margin_amount),
        final_total: String(final_total),
        balance_amount: String(balanceAmount),
        balance_status: balanceStatus,
        final_sent_at: now,
        final_sent_by: asUuid(input.actor_user_id),
        last_party: "admin",
        updated_at: now,
      })
      .where(eq(refurbishmentLots.id, lot.id));
    await appendEvent(tx, lot, {
      party: "admin",
      kind: "final_bill_sent",
      message: input.note ?? null,
      actor: input.actor_user_id,
      payload: { refurbisher_total, margin_pct, margin_amount, final_total, billed_from: billedFromPi ? "pi" : "margin", pi_amount: piAmount, advance_confirmed: advanceConfirmed, balance_expected: money2(Math.max(0, final_total - advanceConfirmed)), resent: !!lot.final_sent_at },
    });
    await audit(tx, lot, input.actor_user_id, "refurb_final_bill", { final_total: num(lot.final_total) }, { refurbisher_total, margin_pct, margin_amount, final_total, billed_from: billedFromPi ? "pi" : "margin" });
  });
  return reload(lot.id, null, "admin");
}

export async function markItemReady(input: { lot_id: string; job_id: string; actor_user_id: string | null }): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, null);
  if (lot.status !== "costed") {
    throw new Error(`CONFLICT: a battery can only be marked ready once the lot is costed (it is ${lot.status.replace(/_/g, " ")})`);
  }
  if (!lot.final_sent_at) throw new Error("CONFLICT: send the final bill to the NBFC before marking batteries ready");
  const now = new Date();
  await db.transaction(async (tx) => {
    const jobs = await lotJobs(tx, lot.id);
    const job = jobs.find((j) => j.id === input.job_id);
    if (!job) throw new Error("NOT_FOUND: job is not in this lot");
    if (job.status !== "at_refurbisher") throw new Error(`CONFLICT: job is ${job.status.replace(/_/g, " ")}, not at the refurbisher`);
    const statuses = jobs.map((j) => (j.id === job.id ? "ready" : j.status));
    const allReady = allOpenItemsReady(statuses);
    await tx.update(refurbishmentJobs).set({ status: "ready", ready_at: now, updated_at: now }).where(eq(refurbishmentJobs.id, job.id));
    await appendEvent(tx, lot, {
      party: "admin",
      kind: "item_ready",
      actor: input.actor_user_id,
      payload: { job_id: job.id, serial: await serialOf(tx, job.battery_id), final_cost: num(job.final_cost), lot_ready: allReady },
    });
    await tx
      .update(refurbishmentLots)
      .set(allReady ? { status: assertLotMove(lot.status, "all_ready"), last_party: "admin", updated_at: now } : { updated_at: now })
      .where(eq(refurbishmentLots.id, lot.id));
    await audit(tx, lot, input.actor_user_id, "refurb_item_ready", { job_status: job.status }, { job_id: job.id, lot_status: allReady ? "ready" : lot.status });
  });
  return reload(lot.id, null, "admin");
}

// ---------------------------------------------------------------------------
// 17. NBFC: redeploy or auction — the lot closes
// ---------------------------------------------------------------------------
export async function closeLot(input: { lot_id: string; tenant_id: string; actor_user_id: string | null; outcome: CloseOutcome; note?: string | null }): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, { tenant_id: input.tenant_id });
  const to = assertLotMove(lot.status, "close");
  if (!CLOSE_OUTCOMES.includes(input.outcome)) throw new Error("BAD_REQUEST: choose redeploy or auction");
  const now = new Date();
  await db.transaction(async (tx) => {
    const jobs = (await lotJobs(tx, lot.id)).filter((j) => j.status === "returned");
    let moved = 0;
    if (input.outcome === "redeploy") {
      // Stub: the pipeline row records the choice; the battery stays `ready`.
      const pids = jobs.map((j) => j.recovery_pipeline_id).filter((x): x is string => !!x);
      if (pids.length) {
        const r = await tx.update(nbfcRecoveryPipeline).set({ stage: "redeploy", updated_at: now }).where(and(inArray(nbfcRecoveryPipeline.id, pids), eq(nbfcRecoveryPipeline.stage, "ready_for_auction"))).returning({ id: nbfcRecoveryPipeline.id });
        moved = r.length;
      }
    }
    await tx
      .update(refurbishmentLots)
      .set({ status: to, close_outcome: input.outcome, closed_at: now, closed_by: asUuid(input.actor_user_id), close_note: input.note ?? null, last_party: "nbfc", updated_at: now })
      .where(eq(refurbishmentLots.id, lot.id));
    await appendEvent(tx, lot, { party: "nbfc", kind: "closed", message: input.note ?? null, actor: input.actor_user_id, payload: { outcome: input.outcome, batteries: jobs.length, redeploy_moved: moved } });
    await audit(tx, lot, input.actor_user_id, "refurb_lot_closed", { status: lot.status }, { status: to, outcome: input.outcome, batteries: jobs.length });
  });
  return reload(lot.id, { tenant_id: input.tenant_id }, "nbfc");
}

// ---------------------------------------------------------------------------
// Thread + photos
// ---------------------------------------------------------------------------
/** `to` matters only for admin messages: the NBFC thread and the refurbisher thread are separate walls. */
export async function postMessage(input: { lot_id: string; scope: LotScope; actor_user_id: string | null; party: Party; message: string; to?: "nbfc" | "refurbisher" }): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, input.scope);
  if (!input.message.trim()) throw new Error("BAD_REQUEST: empty message");
  const to = input.party === "admin" ? (input.to ?? "nbfc") : input.party === "nbfc" ? "admin" : "admin";
  await db.transaction(async (tx) => {
    await appendEvent(tx, lot, { party: input.party, kind: "message", message: input.message.trim(), actor: input.actor_user_id, payload: { to } });
    await tx.update(refurbishmentLots).set({ updated_at: new Date() }).where(eq(refurbishmentLots.id, lot.id));
  });
  return reload(lot.id, input.scope, input.party);
}

export type PhotoTarget =
  | "out_dispatch" | "out_receipt" | "ret_dispatch" | "ret_receipt" | "out_eway_bill" | "ret_eway_bill" | "pi_document"
  // E-293: NBFC payment slips (image / PDF), one list per money leg
  | "advance_slip" | "balance_slip";

/** Photos append to a list; an e-way bill or the PI REPLACES (one document each). */
export async function attachLotPhotos(lot_id: string, scope: LotScope, target: PhotoTarget, paths: string[]): Promise<string[]> {
  const lot = await loadLot(lot_id, scope);
  if (target === "out_eway_bill" || target === "ret_eway_bill" || target === "pi_document") {
    const col = target === "out_eway_bill" ? "out_eway_bill_url" : target === "ret_eway_bill" ? "ret_eway_bill_url" : "pi_url";
    const url = paths[paths.length - 1] ?? null;
    await db.update(refurbishmentLots).set({ [col]: url, updated_at: new Date() } as Partial<LotRow>).where(eq(refurbishmentLots.id, lot.id));
    return url ? [url] : [];
  }
  if (target === "advance_slip" || target === "balance_slip") {
    const leg = target === "advance_slip" ? "advance" : "balance";
    const st = String((lot as unknown as Record<string, unknown>)[`${leg}_status`] ?? "");
    if (st === "confirmed") throw new Error(`CONFLICT: the ${leg} is already confirmed — its slip is part of the record`);
    if (leg === "balance" && st === "not_due") throw new Error("CONFLICT: the balance is not due yet — iTarang sends the final bill first");
  }
  const col =
    target === "out_dispatch" ? "out_photo_urls"
      : target === "out_receipt" ? "out_receipt_photo_urls"
        : target === "ret_dispatch" ? "ret_photo_urls"
          : target === "advance_slip" ? "advance_proof_urls"
            : target === "balance_slip" ? "balance_proof_urls"
              : "ret_receipt_photo_urls";
  const existing = ((lot as unknown as Record<string, unknown>)[col] as string[]) ?? [];
  const next = [...existing, ...paths];
  await db.update(refurbishmentLots).set({ [col]: next, updated_at: new Date() } as Partial<LotRow>).where(eq(refurbishmentLots.id, lot.id));
  return next;
}

export async function attachItemPhotos(lot_id: string, scope: LotScope, job_id: string, leg: "out" | "return", paths: string[]): Promise<string[]> {
  await loadLot(lot_id, scope);
  const [job] = await db.select().from(refurbishmentJobs).where(and(eq(refurbishmentJobs.id, job_id), eq(refurbishmentJobs.lot_id, lot_id))).limit(1);
  if (!job) throw new Error("NOT_FOUND: job is not in this lot");
  const col = leg === "out" ? "out_received_photo_urls" : "ret_received_photo_urls";
  const next = [...(job[col] ?? []), ...paths];
  await db.update(refurbishmentJobs).set({ [col]: next, updated_at: new Date() }).where(eq(refurbishmentJobs.id, job.id));
  return next;
}
