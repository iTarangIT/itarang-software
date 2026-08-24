/**
 * E-258 — scrap consignments: the NBFC → iTarang sale of scrapped batteries.
 *
 * WHAT THIS CLOSES
 *   `nbfc_recovery_pipeline.stage = 'scrap'` is a terminal stage with nothing
 *   after it. The auction engine sells REFURBISHED stock to dealers and
 *   excludes scrap by design (SOH < 55%), so a battery that failed inspection
 *   had no buyer, no price and no way off the NBFC's books — it just piled up
 *   in a column of the Kanban.
 *
 * THE DEAL
 *   1. The NBFC bundles one or many scrap batteries into a consignment, with
 *      photographs, and names a RATE PER BATTERY.
 *   2. iTarang admin sees it and answers with its own rate. Either side may
 *      counter; every round is kept in scrap_consignment_offers.
 *   3. On acceptance the rate freezes and the amount is rate × battery_count.
 *   4. iTarang pays (see ./payment.ts) and the batteries transfer.
 *
 * WHOSE TURN IT IS
 *   `last_party` is who spoke last, so the OTHER side owes the answer. A party
 *   cannot counter its own counter, and — the rule that matters — cannot
 *   ACCEPT its own rate. Acceptance is always the other side agreeing to the
 *   number on the table.
 *
 * TENANT SCOPING
 *   Every NBFC-side read and write is scoped to `tenant_id` in the where-clause
 *   itself; a cross-tenant row surfaces as NOT_FOUND and never leaks. The admin
 *   side is deliberately unscoped — iTarang buys from every NBFC — and is
 *   gated on role instead (see ./roles.ts).
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  scrapConsignments,
  scrapConsignmentItems,
  scrapConsignmentOfferItems,
  scrapConsignmentOffers,
  recoveryBatteries,
  nbfcRecoveryPipeline,
  nbfcTenants,
  nbfcAuditLog,
} from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Vocabulary — lives here, not in a pgEnum or a CHECK
// ---------------------------------------------------------------------------
export const CONSIGNMENT_STATUSES = [
  "draft",
  "submitted",
  "negotiating",
  "agreed",
  "paid",
  "rejected",
  "withdrawn",
] as const;
export type ConsignmentStatus = (typeof CONSIGNMENT_STATUSES)[number];

/** Statuses in which the deal is still live and its batteries are committed. */
export const OPEN_STATUSES: ConsignmentStatus[] = [
  "draft",
  "submitted",
  "negotiating",
  "agreed",
];

/** Statuses in which nothing more will happen and the batteries are freed. */
export const CLOSED_STATUSES: ConsignmentStatus[] = [
  "paid",
  "rejected",
  "withdrawn",
];

/**
 * [E-260] How a consignment is priced.
 *
 * 'flat' is one rate for every battery — right for a pile of identical dead
 * cells. 'itemised' is a rate per battery, for the lots where an intact 48V
 * pack and a swollen 60V one are plainly not the same money; before this the
 * NBFC's only way to say so was to split the lot into separate consignments
 * and negotiate each.
 *
 * IN BOTH MODES THE NEGOTIATION IS ON THE TOTAL. `asking_amount` carries it
 * and every offer round carries `amount`; the per-battery rates are the
 * NBFC's breakdown behind its asking total, not a set of numbers that get
 * countered one by one. A buyer bids on the pile.
 */
export const PRICING_MODES = ["flat", "itemised"] as const;
export type PricingMode = (typeof PRICING_MODES)[number];

export type Party = "nbfc" | "admin";
export const OFFER_KINDS = [
  "quote",
  "counter",
  "accept",
  "reject",
  "withdraw",
] as const;
export type OfferKind = (typeof OFFER_KINDS)[number];

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------
export interface ConsignmentItem {
  id: string;
  battery_id: string | null;
  serial: string;
  model: string | null;
  capacity: string | null;
  soh_pct: number | null;
  condition_note: string | null;
  /** [E-260] This battery's own price. NULL in flat mode. */
  asking_rate: number | null;
  /** [E-261] Its share of the settled deal, when the accepted round had one. */
  agreed_rate: number | null;
  /** From recovery_batteries — the shots a buyer judges the battery on. */
  image_urls: string[];
}

/** [E-261] One battery's line in an itemised round. */
export interface OfferItemRate {
  item_id: string;
  battery_id: string | null;
  serial: string;
  rate: number;
}

export interface ConsignmentOffer {
  id: string;
  round: number;
  /** [E-261] How this round was expressed — see `item_rates`. */
  pricing_mode: "lot" | "itemised";
  /** [E-261] Populated only on an itemised round; sums to `amount`. */
  item_rates: OfferItemRate[];
  party: Party;
  kind: OfferKind;
  rate_per_battery: number | null;
  battery_count: number | null;
  amount: number | null;
  message: string | null;
  created_at: string;
}

export interface Consignment {
  id: string;
  ref_code: string;
  tenant_id: string;
  tenant_name: string | null;
  status: ConsignmentStatus;
  battery_count: number;
  /** [E-260] 'flat' = one rate for all; 'itemised' = a rate per battery. */
  pricing_mode: PricingMode;
  /** NULL in itemised mode — there is no single rate to state. */
  asking_rate_per_battery: number | null;
  /** [E-260] The total asked. Set in BOTH modes; what the deal runs on. */
  asking_amount: number | null;
  agreed_rate_per_battery: number | null;
  agreed_amount: number | null;
  current_round: number;
  last_party: Party | null;
  /** Who owes the next move. NULL once the deal is closed. */
  awaiting: Party | null;
  pickup_city: string | null;
  pickup_state: string | null;
  warehouse: string | null;
  photo_urls: string[];
  note: string | null;
  payee_name: string | null;
  payee_account_number: string | null;
  payee_ifsc: string | null;
  payment_status: string;
  payment_provider: string | null;
  payment_ref: string | null;
  payment_utr: string | null;
  payment_failure_reason: string | null;
  paid_at: string | null;
  /** [E-259] When the batteries physically reached iTarang. */
  received_at: string | null;
  submitted_at: string | null;
  agreed_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConsignmentDetail extends Consignment {
  items: ConsignmentItem[];
  offers: ConsignmentOffer[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const iso = (v: unknown): string | null => {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : String(v);
};

/**
 * [E-260] The total currently on the table, in either pricing mode.
 *
 * Walks the rounds backwards for the last one that named an amount and falls
 * back to the asking total. The equivalent rate-based logic only ever worked
 * for flat lots; this is the version both modes share, and it is why `accept`
 * can stay one code path.
 */
export function amountOnTable(c: {
  offers?: { amount: number | null }[];
  asking_amount: number | null;
}): number | null {
  const offers = c.offers ?? [];
  for (let i = offers.length - 1; i >= 0; i--) {
    if (offers[i].amount != null) return offers[i].amount;
  }
  return c.asking_amount;
}

/**
 * Who owes the next move.
 *
 * Derived, never stored: a stored copy would be one more thing to keep in step
 * with `status` and `last_party`, and it is a pure function of both.
 */
export function awaitingParty(
  status: string,
  lastParty: string | null,
): Party | null {
  if (CLOSED_STATUSES.includes(status as ConsignmentStatus)) return null;
  if (status === "draft") return "nbfc";
  if (status === "agreed") return "admin"; // the payment is admin's move
  if (lastParty === "nbfc") return "admin";
  if (lastParty === "admin") return "nbfc";
  return "admin";
}

type ConsignmentRow = typeof scrapConsignments.$inferSelect;

function shape(row: ConsignmentRow, tenantName?: string | null): Consignment {
  return {
    id: row.id,
    ref_code: row.ref_code,
    tenant_id: row.tenant_id,
    tenant_name: tenantName ?? null,
    status: row.status as ConsignmentStatus,
    battery_count: row.battery_count,
    pricing_mode: (row.pricing_mode as PricingMode) ?? "flat",
    asking_rate_per_battery: num(row.asking_rate_per_battery),
    asking_amount: num(row.asking_amount),
    agreed_rate_per_battery: num(row.agreed_rate_per_battery),
    agreed_amount: num(row.agreed_amount),
    current_round: row.current_round,
    last_party: (row.last_party as Party | null) ?? null,
    awaiting: awaitingParty(row.status, row.last_party),
    pickup_city: row.pickup_city ?? null,
    pickup_state: row.pickup_state ?? null,
    warehouse: row.warehouse ?? null,
    photo_urls: row.photo_urls ?? [],
    note: row.note ?? null,
    payee_name: row.payee_name ?? null,
    payee_account_number: row.payee_account_number ?? null,
    payee_ifsc: row.payee_ifsc ?? null,
    payment_status: row.payment_status,
    payment_provider: row.payment_provider ?? null,
    payment_ref: row.payment_ref ?? null,
    payment_utr: row.payment_utr ?? null,
    payment_failure_reason: row.payment_failure_reason ?? null,
    paid_at: iso(row.paid_at),
    received_at: iso(row.received_at),
    submitted_at: iso(row.submitted_at),
    agreed_at: iso(row.agreed_at),
    closed_at: iso(row.closed_at),
    created_at: iso(row.created_at) ?? "",
    updated_at: iso(row.updated_at) ?? "",
  };
}

/**
 * SCR-000123. Sequential rather than random so an operator can say the number
 * over a phone, and unique in the database so two concurrent creates cannot
 * quietly mint the same one — the insert is retried on 23505.
 */
async function nextRefCode(): Promise<string> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(scrapConsignments);
  const n = Number(row?.n ?? 0) + 1;
  return `SCR-${String(n).padStart(6, "0")}`;
}

// ---------------------------------------------------------------------------
// Eligible batteries — what an NBFC may put in a consignment
// ---------------------------------------------------------------------------
export interface EligibleBattery {
  id: string;
  serial: string;
  model: string | null;
  capacity: string | null;
  state_code: string;
  pipeline_stage: string | null;
  warehouse: string | null;
  city: string | null;
  state: string | null;
  image_urls: string[];
  recovery_date: string | null;
}

/**
 * Batteries this NBFC may offer to iTarang as scrap.
 *
 * A battery is scrap if EITHER its own state says so (`state_code =
 * 'scrapped'`) OR its recovery pipeline row reached the terminal `scrap`
 * stage. Both are checked because moving a pipeline row to `scrap` does NOT
 * touch the battery's state_code — `transitionStage()` never has — so relying
 * on either alone would hide most of the actual scrap.
 *
 * Already-committed batteries are excluded: one battery, one open consignment.
 */
export async function listEligibleBatteries(
  tenant_id: string,
): Promise<EligibleBattery[]> {
  const rows = await db
    .select({
      id: recoveryBatteries.id,
      serial: recoveryBatteries.serial,
      model: recoveryBatteries.model,
      capacity: recoveryBatteries.capacity,
      state_code: recoveryBatteries.state_code,
      warehouse: recoveryBatteries.warehouse,
      city: recoveryBatteries.city,
      state: recoveryBatteries.state,
      image_urls: recoveryBatteries.image_urls,
      recovery_date: recoveryBatteries.recovery_date,
      scrap_consignment_id: recoveryBatteries.scrap_consignment_id,
      pipeline_stage: nbfcRecoveryPipeline.stage,
    })
    .from(recoveryBatteries)
    .leftJoin(
      nbfcRecoveryPipeline,
      eq(nbfcRecoveryPipeline.id, recoveryBatteries.recovery_pipeline_id),
    )
    .where(
      and(
        eq(recoveryBatteries.tenant_id, tenant_id),
        sql`(${recoveryBatteries.state_code} = 'scrapped' OR ${nbfcRecoveryPipeline.stage} = 'scrap')`,
        // Never re-offer something already sold to iTarang.
        sql`${recoveryBatteries.scrap_consignment_id} IS NULL`,
      ),
    )
    .orderBy(desc(recoveryBatteries.updated_at));

  if (rows.length === 0) return [];

  // Exclude anything sitting in a live consignment. Done as a second query
  // rather than a NOT EXISTS so the reason a battery is missing stays legible
  // in the logs when someone asks why.
  const committed = await db
    .select({ battery_id: scrapConsignmentItems.battery_id })
    .from(scrapConsignmentItems)
    .where(
      and(
        eq(scrapConsignmentItems.tenant_id, tenant_id),
        eq(scrapConsignmentItems.is_open, true),
      ),
    );
  const taken = new Set(committed.map((c) => c.battery_id).filter(Boolean));

  return rows
    .filter((r) => !taken.has(r.id))
    .map((r) => ({
      id: r.id,
      serial: r.serial,
      model: r.model ?? null,
      capacity: r.capacity ?? null,
      state_code: r.state_code,
      pipeline_stage: r.pipeline_stage ?? null,
      warehouse: r.warehouse ?? null,
      city: r.city ?? null,
      state: r.state ?? null,
      image_urls: r.image_urls ?? [],
      recovery_date: iso(r.recovery_date),
    }));
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
export interface CreateConsignmentInput {
  tenant_id: string;
  actor_user_id: string | null;
  battery_ids: string[];
  /** [E-260] Defaults to 'flat' — the behaviour every caller had before. */
  pricing_mode?: PricingMode;
  /** Flat mode only: one rate for every battery. */
  asking_rate_per_battery?: number | null;
  /**
   * [E-260] Itemised mode: battery_id → that battery's rate. Batteries missing
   * from the map are simply unpriced, which `submitConsignment` rejects — the
   * draft is allowed to be incomplete, the offer is not.
   */
  item_rates?: Record<string, number> | null;
  note?: string | null;
  pickup_city?: string | null;
  pickup_state?: string | null;
  warehouse?: string | null;
  payee_name?: string | null;
  payee_account_number?: string | null;
  payee_ifsc?: string | null;
}

/**
 * [E-260] The asking total for a set of priced items, or null when nothing is
 * priced yet. Returns null rather than 0 so "no price named" stays
 * distinguishable from "priced at zero" — the submit gate depends on it.
 */
function sumRates(rates: (number | null | undefined)[]): number | null {
  const priced = rates.filter((r): r is number => typeof r === "number" && r > 0);
  if (priced.length === 0) return null;
  return Math.round(priced.reduce((a, b) => a + b, 0) * 100) / 100;
}

export async function createConsignment(
  input: CreateConsignmentInput,
): Promise<ConsignmentDetail> {
  const ids = [...new Set(input.battery_ids.filter(Boolean))];
  if (ids.length === 0) {
    throw new Error("BAD_REQUEST: pick at least one battery");
  }

  // Load the batteries WITH the tenant filter in the where-clause, so another
  // NBFC's serial cannot be pulled into this consignment by id.
  const batteries = await db
    .select({
      id: recoveryBatteries.id,
      serial: recoveryBatteries.serial,
      model: recoveryBatteries.model,
      capacity: recoveryBatteries.capacity,
      warehouse: recoveryBatteries.warehouse,
      city: recoveryBatteries.city,
      state: recoveryBatteries.state,
      scrap_consignment_id: recoveryBatteries.scrap_consignment_id,
    })
    .from(recoveryBatteries)
    .where(
      and(
        eq(recoveryBatteries.tenant_id, input.tenant_id),
        inArray(recoveryBatteries.id, ids),
      ),
    );

  if (batteries.length !== ids.length) {
    throw new Error(
      "NOT_FOUND: one or more batteries do not belong to this NBFC",
    );
  }
  const alreadySold = batteries.find((b) => b.scrap_consignment_id);
  if (alreadySold) {
    throw new Error(
      `CONFLICT: battery ${alreadySold.serial} has already been sold as scrap`,
    );
  }

  const mode: PricingMode = input.pricing_mode ?? "flat";
  const rates = input.item_rates ?? {};
  // The asking total, in whichever mode. Flat multiplies; itemised adds. Both
  // land in the same column so nothing downstream has to branch.
  const askingAmount =
    mode === "itemised"
      ? sumRates(batteries.map((b) => rates[b.id]))
      : input.asking_rate_per_battery != null
        ? Math.round(input.asking_rate_per_battery * batteries.length * 100) / 100
        : null;

  const now = new Date();
  const first = batteries[0];

  // The ref code is derived from a count, so a concurrent create can collide.
  // Retried rather than serialised: the unique index is the real guard and a
  // second attempt is cheaper than a lock held across the whole insert.
  let created: ConsignmentRow | null = null;
  for (let attempt = 0; attempt < 3 && !created; attempt++) {
    const ref = await nextRefCode();
    try {
      const [row] = await db
        .insert(scrapConsignments)
        .values({
          ref_code: attempt === 0 ? ref : `${ref}-${randomUUID().slice(0, 4)}`,
          tenant_id: input.tenant_id,
          status: "draft",
          battery_count: batteries.length,
          pricing_mode: mode,
          // The two price fields are mutually exclusive by mode, so neither
          // can be read as authoritative in the mode it does not belong to.
          asking_rate_per_battery:
            mode === "flat" && input.asking_rate_per_battery != null
              ? String(input.asking_rate_per_battery)
              : null,
          asking_amount: askingAmount != null ? String(askingAmount) : null,
          note: input.note ?? null,
          pickup_city: input.pickup_city ?? first.city ?? null,
          pickup_state: input.pickup_state ?? first.state ?? null,
          warehouse: input.warehouse ?? first.warehouse ?? null,
          payee_name: input.payee_name ?? null,
          payee_account_number: input.payee_account_number ?? null,
          payee_ifsc: input.payee_ifsc?.toUpperCase() ?? null,
          created_by: input.actor_user_id ?? null,
          created_at: now,
          updated_at: now,
        })
        .returning();
      created = row;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/duplicate key|23505/i.test(msg) || attempt === 2) throw e;
    }
  }
  if (!created) throw new Error("CONFLICT: could not allocate a reference code");

  try {
    await db.insert(scrapConsignmentItems).values(
      batteries.map((b) => ({
        consignment_id: created.id,
        tenant_id: input.tenant_id,
        battery_id: b.id,
        serial: b.serial,
        model: b.model ?? null,
        capacity: b.capacity ?? null,
        asking_rate:
          mode === "itemised" && typeof rates[b.id] === "number"
            ? String(rates[b.id])
            : null,
        is_open: true,
        created_at: now,
      })),
    );
  } catch (e) {
    // The partial unique index on (battery_id) WHERE is_open fired: someone
    // put one of these batteries into another live consignment between the
    // eligibility check and this insert. Say which rule was hit rather than
    // leaking a constraint name, and take the empty header row back out.
    await db.delete(scrapConsignments).where(eq(scrapConsignments.id, created.id));
    const msg = e instanceof Error ? e.message : String(e);
    if (/duplicate key|23505/i.test(msg)) {
      throw new Error(
        "CONFLICT: one of these batteries is already in another open consignment",
      );
    }
    throw e;
  }

  return (await getConsignment(created.id, input.tenant_id))!;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------
/**
 * One consignment with its batteries and the full negotiation.
 *
 * `tenant_id` scopes the read for the NBFC side. Pass null for the admin side,
 * which buys from every NBFC and is gated on role instead.
 */
export async function getConsignment(
  id: string,
  tenant_id: string | null,
): Promise<ConsignmentDetail | null> {
  const [row] = await db
    .select({
      c: scrapConsignments,
      tenant_name: nbfcTenants.display_name,
    })
    .from(scrapConsignments)
    .leftJoin(nbfcTenants, eq(nbfcTenants.id, scrapConsignments.tenant_id))
    .where(
      tenant_id
        ? and(
            eq(scrapConsignments.id, id),
            eq(scrapConsignments.tenant_id, tenant_id),
          )
        : eq(scrapConsignments.id, id),
    )
    .limit(1);

  if (!row) return null;

  const itemRows = await db
    .select({
      i: scrapConsignmentItems,
      image_urls: recoveryBatteries.image_urls,
    })
    .from(scrapConsignmentItems)
    .leftJoin(
      recoveryBatteries,
      eq(recoveryBatteries.id, scrapConsignmentItems.battery_id),
    )
    .where(eq(scrapConsignmentItems.consignment_id, id))
    .orderBy(scrapConsignmentItems.created_at);

  const offerRows = await db
    .select()
    .from(scrapConsignmentOffers)
    .where(eq(scrapConsignmentOffers.consignment_id, id))
    .orderBy(scrapConsignmentOffers.round);

  // [E-261] Every round's per-battery breakdown in ONE read, keyed by round
  // below. Fetching per offer would be a query per round on a screen that
  // renders all of them.
  const breakdownRows = await db
    .select()
    .from(scrapConsignmentOfferItems)
    .where(eq(scrapConsignmentOfferItems.consignment_id, id));

  const serialByItem = new Map(itemRows.map((r) => [r.i.id, r.i.serial]));
  const ratesByOffer = new Map<string, OfferItemRate[]>();
  for (const r of breakdownRows) {
    const list = ratesByOffer.get(r.offer_id) ?? [];
    list.push({
      item_id: r.item_id,
      battery_id: r.battery_id ?? null,
      serial: serialByItem.get(r.item_id) ?? "—",
      rate: num(r.rate) ?? 0,
    });
    ratesByOffer.set(r.offer_id, list);
  }

  return {
    ...shape(row.c, row.tenant_name),
    items: itemRows.map((r) => ({
      id: r.i.id,
      battery_id: r.i.battery_id ?? null,
      serial: r.i.serial,
      model: r.i.model ?? null,
      capacity: r.i.capacity ?? null,
      soh_pct: num(r.i.soh_pct),
      condition_note: r.i.condition_note ?? null,
      asking_rate: num(r.i.asking_rate),
      agreed_rate: num(r.i.agreed_rate),
      image_urls: r.image_urls ?? [],
    })),
    offers: offerRows.map((o) => ({
      id: o.id,
      round: o.round,
      pricing_mode: (o.pricing_mode as "lot" | "itemised") ?? "lot",
      item_rates: (ratesByOffer.get(o.id) ?? []).sort((a, b) =>
        a.serial.localeCompare(b.serial),
      ),
      party: o.party as Party,
      kind: o.kind as OfferKind,
      rate_per_battery: num(o.rate_per_battery),
      battery_count: o.battery_count ?? null,
      amount: num(o.amount),
      message: o.message ?? null,
      created_at: iso(o.created_at) ?? "",
    })),
  };
}

export interface ListConsignmentsInput {
  /** NULL = the admin view, which spans every NBFC. */
  tenant_id?: string | null;
  status?: ConsignmentStatus | "open" | "all";
  page?: number;
  page_size?: number;
}

export async function listConsignments(input: ListConsignmentsInput): Promise<{
  items: Consignment[];
  total: number;
  page: number;
  counts: Record<string, number>;
}> {
  const page = input.page ?? 1;
  const pageSize = input.page_size ?? 50;

  const conditions = [
    input.tenant_id ? eq(scrapConsignments.tenant_id, input.tenant_id) : undefined,
    input.status && input.status !== "all"
      ? input.status === "open"
        ? inArray(scrapConsignments.status, OPEN_STATUSES)
        : eq(scrapConsignments.status, input.status)
      : undefined,
  ].filter(Boolean);
  const where = conditions.length ? and(...conditions) : undefined;

  const rows = await db
    .select({ c: scrapConsignments, tenant_name: nbfcTenants.display_name })
    .from(scrapConsignments)
    .leftJoin(nbfcTenants, eq(nbfcTenants.id, scrapConsignments.tenant_id))
    .where(where)
    .orderBy(desc(scrapConsignments.created_at))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const [totalRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(scrapConsignments)
    .where(where);

  // Tallies deliberately ignore the status filter — they are the "what is on
  // my plate" numbers and would be answering a different question if they
  // shrank every time a tab was clicked.
  const countRows = await db
    .select({ status: scrapConsignments.status, n: sql<number>`count(*)::int` })
    .from(scrapConsignments)
    .where(
      input.tenant_id ? eq(scrapConsignments.tenant_id, input.tenant_id) : undefined,
    )
    .groupBy(scrapConsignments.status);

  const counts: Record<string, number> = {};
  for (const r of countRows) counts[r.status] = Number(r.n ?? 0);

  return {
    items: rows.map((r) => shape(r.c, r.tenant_name)),
    total: Number(totalRow?.n ?? 0),
    page,
    counts,
  };
}

// ---------------------------------------------------------------------------
// Edit while still a draft
// ---------------------------------------------------------------------------
export async function updateDraft(
  id: string,
  tenant_id: string,
  patch: {
    pricing_mode?: PricingMode;
    asking_rate_per_battery?: number | null;
    /** [E-260] battery_id → rate. Itemised mode only. */
    item_rates?: Record<string, number> | null;
    note?: string | null;
    pickup_city?: string | null;
    pickup_state?: string | null;
    warehouse?: string | null;
    payee_name?: string | null;
    payee_account_number?: string | null;
    payee_ifsc?: string | null;
  },
): Promise<ConsignmentDetail> {
  const current = await getConsignment(id, tenant_id);
  if (!current) throw new Error("NOT_FOUND: consignment not found");
  // Bank details stay editable after submission: a wrong IFSC should not cost
  // the NBFC the whole negotiation. Everything else freezes once iTarang can
  // see it, because those are the terms being argued about.
  const bankOnly = current.status !== "draft";
  const priceOrTerms =
    patch.pricing_mode !== undefined ||
    patch.asking_rate_per_battery !== undefined ||
    patch.item_rates !== undefined ||
    patch.note !== undefined ||
    patch.pickup_city !== undefined ||
    patch.pickup_state !== undefined ||
    patch.warehouse !== undefined;
  if (bankOnly && priceOrTerms) {
    throw new Error(
      `CONFLICT: consignment is ${current.status} — only the payee bank details can still be changed`,
    );
  }
  if (CLOSED_STATUSES.includes(current.status)) {
    throw new Error(`CONFLICT: consignment is ${current.status} and is closed`);
  }

  const set: Record<string, unknown> = { updated_at: new Date() };

  // [E-260] Price edits are resolved as a unit, because the mode decides which
  // of the two price fields is real. Writing one without the other is what
  // would leave a lot claiming both a flat rate and a set of item rates.
  const mode: PricingMode = patch.pricing_mode ?? current.pricing_mode;
  const priceTouched =
    patch.pricing_mode !== undefined ||
    patch.asking_rate_per_battery !== undefined ||
    patch.item_rates !== undefined;

  if (priceTouched) {
    set.pricing_mode = mode;
    if (mode === "itemised") {
      const rates = patch.item_rates ?? {};
      // Applied per item, keyed by battery — an item whose battery is absent
      // from the map keeps whatever it had, so a partial save cannot silently
      // unprice the rest of the lot.
      for (const item of current.items) {
        const key = item.battery_id ?? "";
        if (!(key in rates)) continue;
        await db
          .update(scrapConsignmentItems)
          .set({ asking_rate: rates[key] != null ? String(rates[key]) : null })
          .where(eq(scrapConsignmentItems.id, item.id));
      }
      const merged = current.items.map((i) => {
        const key = i.battery_id ?? "";
        return key in rates ? rates[key] : i.asking_rate;
      });
      set.asking_rate_per_battery = null;
      const total = sumRates(merged);
      set.asking_amount = total != null ? String(total) : null;
    } else {
      const rate =
        patch.asking_rate_per_battery !== undefined
          ? patch.asking_rate_per_battery
          : current.asking_rate_per_battery;
      set.asking_rate_per_battery = rate != null ? String(rate) : null;
      set.asking_amount =
        rate != null
          ? String(Math.round(rate * current.battery_count * 100) / 100)
          : null;
    }
  }
  if (patch.note !== undefined) set.note = patch.note;
  if (patch.pickup_city !== undefined) set.pickup_city = patch.pickup_city;
  if (patch.pickup_state !== undefined) set.pickup_state = patch.pickup_state;
  if (patch.warehouse !== undefined) set.warehouse = patch.warehouse;
  if (patch.payee_name !== undefined) set.payee_name = patch.payee_name;
  if (patch.payee_account_number !== undefined)
    set.payee_account_number = patch.payee_account_number;
  if (patch.payee_ifsc !== undefined)
    set.payee_ifsc = patch.payee_ifsc ? patch.payee_ifsc.toUpperCase() : null;

  await db
    .update(scrapConsignments)
    .set(set)
    .where(
      and(
        eq(scrapConsignments.id, id),
        eq(scrapConsignments.tenant_id, tenant_id),
      ),
    );

  return (await getConsignment(id, tenant_id))!;
}

/** Appends consignment-level photographs (the pile, the weighbridge slip). */
export async function attachConsignmentPhotos(
  id: string,
  tenant_id: string,
  paths: string[],
): Promise<ConsignmentDetail> {
  if (paths.length === 0) {
    const cur = await getConsignment(id, tenant_id);
    if (!cur) throw new Error("NOT_FOUND: consignment not found");
    return cur;
  }

  // NOTE ON THE ARRAY LITERAL: drizzle's `sql` template expands a JS array into
  // a record tuple `($1,$2,$3)`, NOT a Postgres array, and `(...)::text[]`
  // fails with 42846. Each element is parameterised individually and joined
  // into an explicit ARRAY[...] — still fully parameterised. Same shape as
  // attachBatteryPhotos().
  const pathsArray = sql`ARRAY[${sql.join(
    paths.map((p) => sql`${p}`),
    sql`, `,
  )}]::text[]`;

  const [updated] = await db
    .update(scrapConsignments)
    .set({
      photo_urls: sql`(
        SELECT COALESCE(array_agg(DISTINCT u), '{}')
          FROM unnest(${scrapConsignments.photo_urls} || ${pathsArray}) AS u
      )`,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(scrapConsignments.id, id),
        eq(scrapConsignments.tenant_id, tenant_id),
      ),
    )
    .returning({ id: scrapConsignments.id });

  if (!updated) throw new Error("NOT_FOUND: consignment not found");
  return (await getConsignment(id, tenant_id))!;
}

// ---------------------------------------------------------------------------
// Submit — the NBFC puts it in front of iTarang
// ---------------------------------------------------------------------------
export async function submitConsignment(input: {
  id: string;
  tenant_id: string;
  actor_user_id: string | null;
  asking_rate_per_battery?: number | null;
  message?: string | null;
}): Promise<ConsignmentDetail> {
  const current = await getConsignment(input.id, input.tenant_id);
  if (!current) throw new Error("NOT_FOUND: consignment not found");
  if (current.status !== "draft") {
    throw new Error(
      `CONFLICT: consignment is already ${current.status} and cannot be submitted again`,
    );
  }
  if (current.items.length === 0) {
    throw new Error("CONFLICT: this consignment has no batteries in it");
  }

  // [E-260] What "priced" means depends on the mode. A flat lot needs its one
  // rate; an itemised lot needs a rate on EVERY battery — a lot where three of
  // five are priced is not an offer anyone can answer, and letting it through
  // would put a total on the table that covers only part of the pile.
  const itemised = current.pricing_mode === "itemised";
  const rate = itemised
    ? null
    : (input.asking_rate_per_battery ?? current.asking_rate_per_battery ?? null);

  if (itemised) {
    const unpriced = current.items.filter(
      (i) => i.asking_rate == null || i.asking_rate <= 0,
    );
    if (unpriced.length > 0) {
      throw new Error(
        `BAD_REQUEST: price every battery before sending this to iTarang — ${unpriced.length} still ${unpriced.length === 1 ? "has" : "have"} no rate`,
      );
    }
  } else if (rate == null || rate <= 0) {
    throw new Error(
      "BAD_REQUEST: name a rate per battery before sending this to iTarang",
    );
  }

  const total = itemised
    ? sumRates(current.items.map((i) => i.asking_rate))
    : Math.round((rate ?? 0) * current.battery_count * 100) / 100;
  if (total == null || total <= 0) {
    throw new Error("BAD_REQUEST: this consignment has no asking total");
  }
  // The photographs ARE the offer. Admin is being asked to price batteries it
  // cannot touch, and a consignment with no pictures is not a thing anyone can
  // put a number on.
  const anyPhotos =
    current.photo_urls.length > 0 ||
    current.items.some((i) => i.image_urls.length > 0);
  if (!anyPhotos) {
    throw new Error(
      "BAD_REQUEST: attach at least one photograph — iTarang prices these from the pictures",
    );
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(scrapConsignments)
      .set({
        status: "submitted",
        asking_rate_per_battery: rate != null ? String(rate) : null,
        asking_amount: String(total),
        submitted_at: now,
        current_round: 1,
        last_party: "nbfc",
        updated_at: now,
      })
      .where(
        and(
          eq(scrapConsignments.id, input.id),
          eq(scrapConsignments.tenant_id, input.tenant_id),
          eq(scrapConsignments.status, "draft"),
        ),
      )
      .returning({ id: scrapConsignments.id });

    if (updated.length === 0) {
      // Lost the race with another tab.
      throw new Error("CONFLICT: consignment is no longer a draft");
    }

    const [quote] = await tx
      .insert(scrapConsignmentOffers)
      .values({
        consignment_id: input.id,
        tenant_id: input.tenant_id,
        round: 1,
        party: "nbfc",
        kind: "quote",
        // [E-261] Round 1 records HOW the ask was expressed, so the opening
        // offer reads the same way in the log as every answer to it.
        pricing_mode: itemised ? "itemised" : "lot",
        // NULL for an itemised lot: there is no single rate, and writing an
        // average here would be a number nobody named.
        rate_per_battery: rate != null ? String(rate) : null,
        battery_count: current.battery_count,
        amount: String(total),
        message: input.message ?? null,
        created_by: input.actor_user_id ?? null,
        created_at: now,
      })
      .returning({ id: scrapConsignmentOffers.id });

    if (itemised) {
      await tx.insert(scrapConsignmentOfferItems).values(
        current.items.map((i) => ({
          offer_id: quote.id,
          consignment_id: input.id,
          item_id: i.id,
          battery_id: i.battery_id,
          rate: String(i.asking_rate ?? 0),
          created_at: now,
        })),
      );
    }
  });

  await audit(input.tenant_id, input.actor_user_id, "scrap_consignment_submitted", input.id, {
    ref_code: current.ref_code,
    pricing_mode: current.pricing_mode,
    rate_per_battery: rate,
    amount: total,
    battery_count: current.battery_count,
  });

  return (await getConsignment(input.id, input.tenant_id))!;
}

// ---------------------------------------------------------------------------
// Respond — counter, accept, reject, withdraw
// ---------------------------------------------------------------------------
export interface RespondInput {
  id: string;
  party: Party;
  /** NBFC callers pass their tenant; admin callers pass null. */
  tenant_id: string | null;
  actor_user_id: string | null;
  kind: Exclude<OfferKind, "quote">;
  /** Flat lots: the new rate per battery. Ignored on an itemised lot. */
  rate_per_battery?: number | null;
  /**
   * [E-260] Itemised lots: the new TOTAL for the lot. A buyer bids on the
   * pile, so an itemised counter names one number rather than re-pricing each
   * battery — the NBFC's breakdown stands as its justification for the ask.
   */
  amount?: number | null;
  /**
   * [E-261] item_id → rate. Present on a counter that answers battery by
   * battery instead of with one number for the pile. EITHER side may send it,
   * on ANY lot: the disagreement is usually about one pack, and a lot-level
   * counter cannot say which. When present it wins over `amount`, which is
   * then derived as the sum.
   */
  item_rates?: Record<string, number> | null;
  message?: string | null;
}

/**
 * One move in the negotiation.
 *
 * THE TURN RULE. `last_party` is who spoke last; a party may not counter its
 * own counter, and may not ACCEPT its own rate. Acceptance is always the other
 * side agreeing to the number already on the table, which is what makes
 * `agreed_rate_per_battery` a figure both parties put their name to.
 */
export async function respondToConsignment(
  input: RespondInput,
): Promise<ConsignmentDetail> {
  const current = await getConsignment(input.id, input.tenant_id);
  if (!current) throw new Error("NOT_FOUND: consignment not found");

  if (CLOSED_STATUSES.includes(current.status)) {
    throw new Error(
      `CONFLICT: this consignment is ${current.status} — the negotiation is over`,
    );
  }
  if (current.status === "draft") {
    throw new Error(
      "CONFLICT: this consignment has not been sent to iTarang yet",
    );
  }
  if (current.status === "agreed" && input.kind !== "reject") {
    throw new Error(
      "CONFLICT: the rate is already agreed — the remaining step is payment",
    );
  }

  // Withdraw is the NBFC's alone, and only over its own consignment.
  if (input.kind === "withdraw" && input.party !== "nbfc") {
    throw new Error("FORBIDDEN: only the NBFC can withdraw its consignment");
  }

  if (input.kind === "counter" || input.kind === "accept") {
    if (current.last_party === input.party) {
      throw new Error(
        input.kind === "accept"
          ? "CONFLICT: you cannot accept your own rate — it is the other side's turn"
          : "CONFLICT: it is not your turn — the other side has not answered yet",
      );
    }
  }

  const now = new Date();
  const round = current.current_round + 1;
  const count = current.battery_count;

  // [E-260] The deal is settled in a TOTAL, in both pricing modes. A flat lot
  // still argues in a rate — that is what its two sides say to each other —
  // but the rate is turned into the total here, and the total is the only
  // thing acceptance and payment ever read.
  const itemised = current.pricing_mode === "itemised";
  let rate: number | null = null;
  let amount: number | null = null;
  // [E-261] The breakdown this round carries, if it is an itemised one.
  let roundRates: { item_id: string; battery_id: string | null; rate: number }[] = [];
  let roundMode: "lot" | "itemised" = "lot";

  if (input.kind === "counter") {
    const perBattery = input.item_rates ?? null;
    if (perBattery && Object.keys(perBattery).length > 0) {
      // Answering battery by battery. EVERY battery must be priced: a partial
      // breakdown would sum to a total that covers only part of the lot, and
      // the other side would have no way to see which part.
      const byId = new Map(current.items.map((i) => [i.id, i]));
      const unknown = Object.keys(perBattery).filter((k) => !byId.has(k));
      if (unknown.length > 0) {
        throw new Error(
          "BAD_REQUEST: one or more priced batteries are not in this consignment",
        );
      }
      const missing = current.items.filter(
        (i) => !(perBattery[i.id] > 0),
      );
      if (missing.length > 0) {
        throw new Error(
          `BAD_REQUEST: price every battery — ${missing.length} still ${missing.length === 1 ? "has" : "have"} no rate`,
        );
      }
      roundRates = current.items.map((i) => ({
        item_id: i.id,
        battery_id: i.battery_id,
        rate: perBattery[i.id],
      }));
      amount = sumRates(roundRates.map((r) => r.rate));
      roundMode = "itemised";
      if (amount == null || amount <= 0) {
        throw new Error("BAD_REQUEST: the per-battery prices add up to nothing");
      }
    } else if (itemised) {
      amount = input.amount ?? null;
      if (amount == null || amount <= 0) {
        throw new Error(
          "BAD_REQUEST: this lot is priced per battery — a counter needs a total for the lot, or a rate for each battery",
        );
      }
    } else {
      // A flat lot may still be countered per battery — that is the branch
      // above. This is the plain case: one rate for everything.
      rate = input.rate_per_battery ?? null;
      if (rate == null || rate <= 0) {
        throw new Error("BAD_REQUEST: a counter needs a rate per battery");
      }
      amount = Math.round(rate * count * 100) / 100;
    }
  } else if (input.kind === "accept") {
    // Accepting means accepting WHAT IS ON THE TABLE — the last number the
    // other side named. Taking it from the accept request itself would let a
    // party "accept" at a figure nobody offered.
    amount = amountOnTable(current);
    if (amount == null) {
      throw new Error("CONFLICT: there is no price on the table to accept");
    }
    // [E-261] If the round being accepted named per-battery rates, they become
    // the agreed split. Accepting a LOT-level number deliberately carries none
    // forward — see the clearing below.
    const lastPriced = [...current.offers]
      .reverse()
      .find((o) => o.amount != null);
    if (lastPriced?.pricing_mode === "itemised") {
      roundRates = lastPriced.item_rates.map((r) => ({
        item_id: r.item_id,
        battery_id: r.battery_id,
        rate: r.rate,
      }));
      roundMode = "itemised";
    }
    if (!itemised && roundMode === "lot") {
      const lastFlatRate = [...current.offers]
        .reverse()
        .find((o) => o.rate_per_battery != null);
      rate =
        lastFlatRate?.rate_per_battery ??
        current.asking_rate_per_battery ??
        (count > 0 ? Math.round((amount / count) * 100) / 100 : null);
    }
  }

  const nextStatus: ConsignmentStatus =
    input.kind === "accept"
      ? "agreed"
      : input.kind === "reject"
        ? "rejected"
        : input.kind === "withdraw"
          ? "withdrawn"
          : "negotiating";

  await db.transaction(async (tx) => {
    const set: Record<string, unknown> = {
      status: nextStatus,
      current_round: round,
      last_party: input.party,
      updated_at: now,
    };
    if (input.kind === "accept") {
      // Left NULL on an itemised lot rather than storing amount ÷ count: an
      // average nobody agreed to would read as a per-battery price that was
      // never named, and `agreed_amount` is what the payout uses.
      set.agreed_rate_per_battery = rate != null ? String(rate) : null;
      set.agreed_amount = String(amount ?? 0);
      set.agreed_at = now;
      set.agreed_by = input.actor_user_id ?? null;
    }
    if (input.kind === "reject" || input.kind === "withdraw") {
      set.closed_at = now;
    }

    const updated = await tx
      .update(scrapConsignments)
      .set(set)
      .where(
        and(
          eq(scrapConsignments.id, input.id),
          // The round we read is the round we write against: if another tab
          // moved first, this matches nothing and the 409 below is correct.
          eq(scrapConsignments.current_round, current.current_round),
        ),
      )
      .returning({ id: scrapConsignments.id });

    if (updated.length === 0) {
      throw new Error(
        "CONFLICT: someone else answered first — reload to see the current rate",
      );
    }

    const [offerRow] = await tx
      .insert(scrapConsignmentOffers)
      .values({
        consignment_id: input.id,
        tenant_id: current.tenant_id,
        round,
        party: input.party,
        kind: input.kind,
        pricing_mode: roundMode,
        rate_per_battery: rate != null ? String(rate) : null,
        battery_count: count,
        amount: amount != null ? String(amount) : null,
        message: input.message ?? null,
        created_by: input.actor_user_id ?? null,
        created_at: now,
      })
      .returning({ id: scrapConsignmentOffers.id });

    // [E-261] The breakdown behind an itemised round. Written for an ACCEPT as
    // well as a COUNTER, so the accepted round carries the split it settled at
    // and the log does not have to be walked backwards to find it.
    if (roundMode === "itemised" && roundRates.length > 0) {
      await tx.insert(scrapConsignmentOfferItems).values(
        roundRates.map((r) => ({
          offer_id: offerRow.id,
          consignment_id: input.id,
          item_id: r.item_id,
          battery_id: r.battery_id,
          rate: String(r.rate),
          created_at: now,
        })),
      );
    }

    // The settled split. Cleared when the accepted round was lot-level: a
    // breakdown left over from an earlier round would not sum to
    // agreed_amount, and a wrong breakdown is worse than none.
    if (input.kind === "accept") {
      if (roundMode === "itemised") {
        for (const r of roundRates) {
          await tx
            .update(scrapConsignmentItems)
            .set({ agreed_rate: String(r.rate) })
            .where(eq(scrapConsignmentItems.id, r.item_id));
        }
      } else {
        await tx
          .update(scrapConsignmentItems)
          .set({ agreed_rate: null })
          .where(eq(scrapConsignmentItems.consignment_id, input.id));
      }
    }

    // A closed deal releases its batteries. `is_open = false` is what lets the
    // NBFC offer them again — the partial unique index is keyed on it.
    if (input.kind === "reject" || input.kind === "withdraw") {
      await tx
        .update(scrapConsignmentItems)
        .set({ is_open: false })
        .where(eq(scrapConsignmentItems.consignment_id, input.id));
    }
  });

  await audit(
    current.tenant_id,
    input.actor_user_id,
    `scrap_consignment_${input.kind}`,
    input.id,
    {
      ref_code: current.ref_code,
      party: input.party,
      round,
      pricing_mode: current.pricing_mode,
      rate_per_battery: rate,
      amount,
    },
  );

  return (await getConsignment(input.id, input.tenant_id))!;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------
/**
 * Best-effort by contract. `nbfc_audit_log` is the NBFC's immutable trail, but
 * a logging failure must never be the reason a deal move fails — the same rule
 * the notification emitter follows.
 *
 * `nbfc_audit_log.user_id` is NOT NULL, so an actor-less caller (the
 * non-production test bypass) is skipped rather than throwing inside the
 * try/catch and looking like a database fault in the logs. Every real session
 * carries a user id. `action_type` is varchar(32) — keep new strings short.
 */
// ---------------------------------------------------------------------------
// Received — the batteries are physically at iTarang
// ---------------------------------------------------------------------------
/**
 * [E-259] Records the arrival of an agreed lot.
 *
 * ADMIN-ONLY AND UNSCOPED. Only iTarang can attest that something reached
 * iTarang; letting the selling NBFC set this would hand the counterparty the
 * key to its own pay-after gate.
 *
 * Only meaningful from 'agreed' onwards — before a rate is settled there is no
 * lot to hand over — and idempotent: a second click returns the row with the
 * first timestamp rather than moving the arrival later.
 */
export async function markConsignmentReceived(input: {
  id: string;
  actor_user_id: string | null;
}): Promise<ConsignmentDetail> {
  const current = await getConsignment(input.id, null);
  if (!current) throw new Error("NOT_FOUND: consignment not found");
  if (current.received_at) return current;
  if (current.status !== "agreed" && current.status !== "paid") {
    throw new Error(
      `CONFLICT: consignment is ${current.status} — batteries are handed over once a rate is agreed`,
    );
  }

  const now = new Date();
  await db
    .update(scrapConsignments)
    .set({ received_at: now, received_by: input.actor_user_id, updated_at: now })
    .where(
      and(
        eq(scrapConsignments.id, input.id),
        sql`${scrapConsignments.received_at} IS NULL`,
      ),
    );

  await audit(current.tenant_id, input.actor_user_id, "scrap_consignment_received", input.id, {
    ref_code: current.ref_code,
    battery_count: current.battery_count,
  });

  return (await getConsignment(input.id, null))!;
}

async function audit(
  tenant_id: string,
  user_id: string | null,
  action_type: string,
  action_id: string,
  after: Record<string, unknown>,
): Promise<void> {
  if (!user_id) return;
  try {
    await db.insert(nbfcAuditLog).values({
      tenant_id,
      user_id,
      action_type: action_type.slice(0, 32),
      action_id,
      after_state: after,
      created_at: new Date(),
    });
  } catch (err) {
    console.warn(
      "[scrap] audit write skipped:",
      err instanceof Error ? err.message : err,
    );
  }
}

export { audit as auditScrapAction };
