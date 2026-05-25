/**
 * Publish a refurbished battery to the auction marketplace (BRD §6.1.7).
 *
 * Called from transitionStage() when a recovery_pipeline row moves from
 * "refurbishable" -> "ready_for_auction". Reads the most recent
 * nbfc_battery_evaluations row for the pipeline_id to derive the lot's
 * avg_soh / age_months / base_price; falls back to the pipeline row's
 * estimated_recovery_value if no evaluation exists.
 *
 * The insert is always status='live' with ends_at = now + 7 days — the BRD
 * does not pin a fixed auction window, but a week matches the §6.1.7 example
 * and gives bidders multiple working days to react. bid_increment is
 * auto-sized at 2% of base, rounded to the nearest ₹100 and floored at ₹100.
 *
 * lot_code is deterministic per pipeline row: `LOT-` + first 8 chars of the
 * recovery_pipeline_id. That keeps re-runs idempotent (the column has a
 * UNIQUE constraint — a duplicate insert would surface as a 23505 the caller
 * can choose to swallow).
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  auctionLots,
  nbfcBatteryEvaluations,
  nbfcRecoveryPipeline,
} from "@/lib/db/schema";

type DbLike = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

const AUCTION_WINDOW_DAYS = 7;
const MIN_BID_INCREMENT = 100;
const BID_INCREMENT_PCT = 0.02;

export interface PublishLotInput {
  tenant_id: string;
  recovery_pipeline_id: string;
  /** Drizzle db handle or transaction. Defaults to the singleton `db`. */
  executor?: DbLike;
}

export interface PublishLotResult {
  lot_id: string;
  lot_code: string;
  base_price: number;
  ends_at: string;
}

interface Step1Shape {
  soh_percent?: unknown;
  manufacturing_date?: unknown;
}

function readNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function ageMonthsFrom(manufacturingDate: unknown): number | null {
  if (typeof manufacturingDate !== "string" || !manufacturingDate) return null;
  const d = new Date(manufacturingDate);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const months =
    (now.getFullYear() - d.getFullYear()) * 12 +
    (now.getMonth() - d.getMonth());
  return months < 0 ? 0 : months;
}

function computeBidIncrement(basePrice: number): number {
  const pct = basePrice * BID_INCREMENT_PCT;
  const rounded = Math.round(pct / 100) * 100;
  return Math.max(MIN_BID_INCREMENT, rounded);
}

function shortLotCode(pipelineId: string): string {
  // pipelineId is a UUID; first 8 hex chars are unique enough across the
  // recovery pipeline for a single tenant and keep us well under
  // auction_lots.lot_code's varchar(32) ceiling.
  const slug = pipelineId.replace(/-/g, "").slice(0, 8).toUpperCase();
  return `LOT-${slug}`;
}

export async function publishLotFromRecovery(
  input: PublishLotInput,
): Promise<PublishLotResult> {
  const x: DbLike = input.executor ?? db;

  // 1. Pipeline row — provides the tenant-scoped fallback price.
  const pipelineRows = await x
    .select({
      id: nbfcRecoveryPipeline.id,
      battery_serial: nbfcRecoveryPipeline.battery_serial,
      estimated_recovery_value: nbfcRecoveryPipeline.estimated_recovery_value,
    })
    .from(nbfcRecoveryPipeline)
    .where(
      and(
        eq(nbfcRecoveryPipeline.id, input.recovery_pipeline_id),
        eq(nbfcRecoveryPipeline.tenant_id, input.tenant_id),
      ),
    )
    .limit(1);

  if (pipelineRows.length === 0) {
    throw new Error(
      "NOT_FOUND: recovery pipeline row not found for this tenant",
    );
  }
  const pipeline = pipelineRows[0];

  // 2. Latest evaluation — preferred source of price, SOH, manufacturing age.
  const evals = await x
    .select({
      step1: nbfcBatteryEvaluations.step1,
      base_auction_price: nbfcBatteryEvaluations.base_auction_price,
      rejected: nbfcBatteryEvaluations.rejected,
    })
    .from(nbfcBatteryEvaluations)
    .where(
      and(
        eq(
          nbfcBatteryEvaluations.recovery_pipeline_id,
          input.recovery_pipeline_id,
        ),
        eq(nbfcBatteryEvaluations.tenant_id, input.tenant_id),
      ),
    )
    .orderBy(desc(nbfcBatteryEvaluations.created_at))
    .limit(1);
  const latestEval = evals[0];

  // 3. Resolve avg_soh / age_months / base_price with explicit fallbacks.
  const step1 = (latestEval?.step1 ?? null) as Step1Shape | null;
  const avgSoh = step1 ? readNumber(step1.soh_percent) : null;
  const ageMonths = step1 ? ageMonthsFrom(step1.manufacturing_date) : null;

  const evalPrice = latestEval
    ? readNumber(latestEval.base_auction_price)
    : null;
  const fallbackPrice = readNumber(pipeline.estimated_recovery_value);
  const basePrice = evalPrice ?? fallbackPrice;

  if (basePrice == null || basePrice <= 0) {
    throw new Error(
      "BAD_REQUEST: cannot publish lot — no base auction price (run battery evaluation first)",
    );
  }
  if (latestEval?.rejected) {
    throw new Error(
      "BAD_REQUEST: cannot publish lot — most recent evaluation rejected this battery",
    );
  }

  // 4. Insert auction lot. ON CONFLICT keeps the existing row so a duplicate
  //    transition request never multiplies the marketplace.
  const lotCode = shortLotCode(input.recovery_pipeline_id);
  const bidIncrement = computeBidIncrement(basePrice);
  const endsAt = new Date(
    Date.now() + AUCTION_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );

  const [inserted] = await x
    .insert(auctionLots)
    .values({
      lot_code: lotCode,
      capacity: null,
      avg_soh: avgSoh != null ? avgSoh.toFixed(2) : null,
      age_months: ageMonths,
      quantity: 1,
      base_price: basePrice.toFixed(2),
      bid_increment: bidIncrement.toFixed(2),
      ends_at: endsAt,
      status: "live",
    })
    .onConflictDoNothing({ target: auctionLots.lot_code })
    .returning({
      id: auctionLots.id,
      lot_code: auctionLots.lot_code,
      ends_at: auctionLots.ends_at,
    });

  // 5. If the conflict path swallowed the insert, fetch the existing lot so
  //    the caller still gets a coherent receipt.
  if (!inserted) {
    const [existing] = await x
      .select({
        id: auctionLots.id,
        lot_code: auctionLots.lot_code,
        ends_at: auctionLots.ends_at,
      })
      .from(auctionLots)
      .where(eq(auctionLots.lot_code, lotCode))
      .limit(1);
    if (!existing) {
      throw new Error(
        "CONFLICT: auction lot insert failed and no existing row found",
      );
    }
    return {
      lot_id: existing.id,
      lot_code: existing.lot_code,
      base_price: basePrice,
      ends_at: existing.ends_at.toISOString(),
    };
  }

  return {
    lot_id: inserted.id,
    lot_code: inserted.lot_code,
    base_price: basePrice,
    ends_at: inserted.ends_at.toISOString(),
  };
}
