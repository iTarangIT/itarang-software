/**
 * /nbfc/recovery — Recovery & Auction (BRD §6.1.7)
 *
 * Layout (top → bottom):
 *   1. Recovery pipeline   — 3 headline metrics + 4 stage stat cards.
 *   2. Auction marketplace — live lot grid + a sticky Battery Evaluation panel.
 *   3. Post-auction settlement — 3 headline metrics + settlement table.
 *   4. Buyback requests    — customer battery buyback table (E-118).
 *   5. Operations workspace — recovery stage kanban + immobilisation requests.
 *
 * Server component: reads nbfc_recovery_pipeline, auction_lots/_bids/_settlements,
 * nbfc_buyback_requests and dual-approval immobilisation rows directly. Card
 * transitions, bidding and the evaluation wizard are wired client-side.
 */
import { db } from "@/lib/db";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  ClipboardCheck,
  Wrench,
  Trash2,
  CheckCircle2,
} from "lucide-react";
import {
  nbfcRecoveryPipeline,
  nbfcLoans,
  loanFiles,
  iotDevices,
  dualApprovalRequests,
  nbfcImmobilisationActions,
  auctionLots,
  auctionBids,
  auctionSettlements,
  auctionAutoBids,
  nbfcBuybackRequests,
  nbfcTenants,
} from "@/lib/db/schema";
import { getCurrentTenant, requireNbfcAccess } from "@/lib/nbfc/tenant";
import { getVehicleStates } from "@/lib/db/iot-queries";
import RecoveryKanban from "./_components/RecoveryKanban";
import BatteryEvaluationPanel from "./_components/BatteryEvaluationPanel";
import {
  AuctionLotsGrid,
  type AuctionLot,
} from "@/components/nbfc-portal/AuctionLotsGrid";
import {
  AuctionSettlementsTable,
  type SettlementRow,
  type SettlementStatus,
} from "@/components/nbfc-portal/AuctionSettlementsTable";
import {
  BuybackRequestsTable,
  type BuybackRow,
} from "@/components/nbfc-portal/BuybackRequestsTable";

export const dynamic = "force-dynamic";

const STAGES = [
  "needs_inspection",
  "refurbishable",
  "ready_for_auction",
  "resold",
  "scrap",
] as const;

type Stage = (typeof STAGES)[number];

const STAGE_LABEL: Record<Stage, string> = {
  needs_inspection: "Needs Inspection",
  refurbishable: "Refurbishable",
  ready_for_auction: "Ready for Auction",
  resold: "Resold",
  scrap: "Scrap",
};

// The pipeline strip surfaces 4 stages; ready_for_auction stays in the kanban.
const PIPELINE_CARDS = [
  {
    stage: "needs_inspection" as Stage,
    icon: ClipboardCheck,
    tone: "text-[color:var(--color-brand-sky)]",
  },
  {
    stage: "refurbishable" as Stage,
    icon: Wrench,
    tone: "text-[color:var(--color-success)]",
  },
  { stage: "scrap" as Stage, icon: Trash2, tone: "text-[color:var(--color-danger)]" },
  {
    stage: "resold" as Stage,
    icon: CheckCircle2,
    tone: "text-[color:var(--color-warning)]",
  },
];

// Stages whose estimated recovery value is still "locked" in the pipeline.
const IN_PROGRESS_STAGES: Stage[] = [
  "needs_inspection",
  "refurbishable",
  "ready_for_auction",
];

function stripZeros(s: string): string {
  return s.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

/** Indian compact currency — ₹1.24 Cr, ₹78 L, ₹4,200. */
function fmtCompactINR(n: number): string {
  if (n >= 1e7) return `₹${stripZeros((n / 1e7).toFixed(2))} Cr`;
  if (n >= 1e5) return `₹${stripZeros((n / 1e5).toFixed(1))} L`;
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

function fmtPct(ratio: number | null): string {
  return ratio == null ? "—" : `${Math.round(ratio * 100)}%`;
}

function fmtSignedPct(ratio: number | null): string {
  if (ratio == null) return "—";
  const p = ratio * 100;
  return `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
}

export default async function RecoveryPage() {
  const tenant = await getCurrentTenant();
  await requireNbfcAccess(tenant.id);

  // 0. Tenant legal identity — drives the §6.1.6 Borrower Notice Preview.
  const tenantLegalRows = await db
    .select({
      legal_name: nbfcTenants.nbfc_legal_name,
      grievance_url: nbfcTenants.grievance_url,
      grievance_helpline: nbfcTenants.grievance_helpline,
    })
    .from(nbfcTenants)
    .where(eq(nbfcTenants.id, tenant.id))
    .limit(1);
  const tenantLegal = {
    legal_name: tenantLegalRows[0]?.legal_name ?? null,
    display_name: tenant.display_name,
    grievance_url: tenantLegalRows[0]?.grievance_url ?? null,
    grievance_helpline: tenantLegalRows[0]?.grievance_helpline ?? null,
  };

  // 1. Pipeline rows for tenant.
  const rows = await db
    .select({
      id: nbfcRecoveryPipeline.id,
      battery_serial: nbfcRecoveryPipeline.battery_serial,
      stage: nbfcRecoveryPipeline.stage,
      estimated_recovery_value: nbfcRecoveryPipeline.estimated_recovery_value,
      created_at: nbfcRecoveryPipeline.created_at,
      updated_at: nbfcRecoveryPipeline.updated_at,
    })
    .from(nbfcRecoveryPipeline)
    .where(eq(nbfcRecoveryPipeline.tenant_id, tenant.id))
    .orderBy(desc(nbfcRecoveryPipeline.updated_at))
    .limit(500);

  // 2. Borrower context for each serial — joined via nbfcLoans.vehicleno.
  const serials = rows.map((r) => r.battery_serial).filter(Boolean);
  const ctx =
    serials.length > 0
      ? ((await db
          .select({
            vehicleno: nbfcLoans.vehicleno,
            loan_application_id: nbfcLoans.loan_application_id,
            current_dpd: nbfcLoans.current_dpd,
            outstanding_amount: nbfcLoans.outstanding_amount,
            borrower_name: loanFiles.borrower_name,
            imei: iotDevices.imei_id,
          })
          .from(nbfcLoans)
          .leftJoin(
            loanFiles,
            eq(loanFiles.loan_application_id, nbfcLoans.loan_application_id),
          )
          .leftJoin(
            iotDevices,
            eq(iotDevices.serial_number, nbfcLoans.vehicleno),
          )
          .where(
            and(
              eq(nbfcLoans.tenant_id, tenant.id),
              inArray(nbfcLoans.vehicleno, serials),
            ),
          )) as Array<{
          vehicleno: string;
          loan_application_id: string;
          current_dpd: number | null;
          outstanding_amount: string | null;
          borrower_name: string | null;
          imei: string | null;
        }>)
      : [];
  const ctxByVehicle = new Map(ctx.map((c) => [c.vehicleno, c]));

  // 3. Live SOH per battery from VPS (best-effort).
  let sohByVehicle = new Map<string, number>();
  try {
    const states = await getVehicleStates(serials);
    sohByVehicle = new Map(
      states
        .filter((s) => s.soh_pct != null)
        .map((s) => [s.vehicleno, s.soh_pct as number]),
    );
  } catch {
    /* VPS unreachable — render without live SOH */
  }

  // 4. Pending immobilisation requests + executed actions for status pills.
  const pending = await db
    .select({
      id: dualApprovalRequests.id,
      entity_id: dualApprovalRequests.entity_id,
      action_type: dualApprovalRequests.action_type,
      status: dualApprovalRequests.status,
      reason_code: dualApprovalRequests.reason_code,
      created_at: dualApprovalRequests.created_at,
      expires_at: dualApprovalRequests.expires_at,
    })
    .from(dualApprovalRequests)
    .where(
      and(
        eq(dualApprovalRequests.tenant_id, tenant.id),
        eq(dualApprovalRequests.action_type, "battery_immobilisation"),
      ),
    )
    .orderBy(desc(dualApprovalRequests.created_at))
    .limit(50);

  const executed = await db
    .select({
      approval_request_id: nbfcImmobilisationActions.approval_request_id,
      executed_at: nbfcImmobilisationActions.executed_at,
    })
    .from(nbfcImmobilisationActions)
    .where(eq(nbfcImmobilisationActions.tenant_id, tenant.id));
  const executedSet = new Set(executed.map((e) => e.approval_request_id));

  const nowMs = new Date().getTime();
  const enrichedRows = rows.map((r) => {
    const c = ctxByVehicle.get(r.battery_serial);
    const ageDays = r.updated_at
      ? Math.max(
          0,
          Math.floor((nowMs - r.updated_at.getTime()) / (24 * 60 * 60 * 1000)),
        )
      : 0;
    return {
      id: r.id,
      battery_serial: r.battery_serial,
      stage: r.stage as Stage,
      estimated_recovery_value:
        r.estimated_recovery_value != null
          ? Number(r.estimated_recovery_value)
          : null,
      borrower_name: c?.borrower_name ?? null,
      loan_application_id: c?.loan_application_id ?? null,
      current_dpd: c?.current_dpd ?? null,
      outstanding_amount:
        c?.outstanding_amount != null ? Number(c.outstanding_amount) : null,
      imei: c?.imei ?? null,
      live_soh_pct: sohByVehicle.get(r.battery_serial) ?? null,
      age_days: ageDays,
    };
  });

  const enrichedRequests = pending.map((p) => ({
    id: p.id,
    loan_application_id: p.entity_id,
    reason_code: p.reason_code,
    status: p.status,
    executed: executedSet.has(p.id),
    created_at: p.created_at,
    expires_at: p.expires_at,
  }));

  // Recovery-pipeline headline metrics.
  const valueLocked = enrichedRows
    .filter((r) => IN_PROGRESS_STAGES.includes(r.stage))
    .reduce((a, r) => a + (r.estimated_recovery_value ?? 0), 0);
  const estRecovery = enrichedRows
    .filter((r) => r.stage !== "scrap")
    .reduce((a, r) => a + (r.estimated_recovery_value ?? 0), 0);
  const resoldCount = enrichedRows.filter((r) => r.stage === "resold").length;
  const scrapCount = enrichedRows.filter((r) => r.stage === "scrap").length;
  const pipelineRecoveryRate =
    resoldCount + scrapCount > 0
      ? resoldCount / (resoldCount + scrapCount)
      : null;

  // 5. Battery Evaluations — rows currently in needs_inspection.
  const pendingEvaluations = enrichedRows
    .filter((r) => r.stage === "needs_inspection")
    .map((r) => ({
      id: r.id,
      battery_serial: r.battery_serial,
      borrower_name: r.borrower_name,
      live_soh_pct: r.live_soh_pct,
      age_days: r.age_days,
    }));

  // 6. Auction Marketplace — live lots with current bid + bidder count.
  const lotRows = await db
    .select({
      id: auctionLots.id,
      lot_code: auctionLots.lot_code,
      capacity: auctionLots.capacity,
      avg_soh: auctionLots.avg_soh,
      age_months: auctionLots.age_months,
      quantity: auctionLots.quantity,
      base_price: auctionLots.base_price,
      bid_increment: auctionLots.bid_increment,
      ends_at: auctionLots.ends_at,
      max_bid: sql<string | null>`MAX(${auctionBids.amount})`,
      bidder_count: sql<string>`COUNT(DISTINCT ${auctionBids.tenant_id})`,
    })
    .from(auctionLots)
    .leftJoin(auctionBids, eq(auctionBids.lot_id, auctionLots.id))
    .where(
      and(eq(auctionLots.status, "live"), gt(auctionLots.ends_at, new Date())),
    )
    .groupBy(auctionLots.id)
    .orderBy(auctionLots.ends_at)
    .limit(50);

  // BRD §6.1.7 — per-tenant max bid and active auto-bid max, keyed by lot.
  const lotIds = lotRows.map((l) => l.id);
  let yourBidByLot = new Map<string, number>();
  let autoBidByLot = new Map<string, number>();
  if (lotIds.length > 0) {
    const [myBids, myAutoBids] = await Promise.all([
      db
        .select({
          lot_id: auctionBids.lot_id,
          my_max: sql<string>`MAX(${auctionBids.amount})`,
        })
        .from(auctionBids)
        .where(
          and(
            eq(auctionBids.tenant_id, tenant.id),
            inArray(auctionBids.lot_id, lotIds),
          ),
        )
        .groupBy(auctionBids.lot_id),
      db
        .select({
          lot_id: auctionAutoBids.lot_id,
          max_amount: auctionAutoBids.max_amount,
        })
        .from(auctionAutoBids)
        .where(
          and(
            eq(auctionAutoBids.tenant_id, tenant.id),
            eq(auctionAutoBids.status, "active"),
            inArray(auctionAutoBids.lot_id, lotIds),
          ),
        ),
    ]);
    yourBidByLot = new Map(myBids.map((b) => [b.lot_id, Number(b.my_max)]));
    autoBidByLot = new Map(
      myAutoBids.map((b) => [b.lot_id, Number(b.max_amount)]),
    );
  }

  const lots: AuctionLot[] = lotRows.map((l) => {
    const basePrice = Number(l.base_price);
    return {
      lot_id: l.id,
      lot_code: l.lot_code,
      capacity: l.capacity,
      avg_soh: l.avg_soh != null ? Number(l.avg_soh) : null,
      age_months: l.age_months,
      quantity: l.quantity,
      base_price: basePrice,
      bid_increment: Number(l.bid_increment),
      current_bid: l.max_bid != null ? Number(l.max_bid) : basePrice,
      bidder_count: l.bidder_count != null ? Number(l.bidder_count) : 0,
      ends_at: l.ends_at.toISOString(),
      your_last_bid: yourBidByLot.get(l.id) ?? null,
      your_auto_bid_max: autoBidByLot.get(l.id) ?? null,
    };
  });

  // 7. Post-auction settlements — this tenant as seller.
  const settlementRows = await db
    .select({
      id: auctionSettlements.id,
      lot_code: auctionLots.lot_code,
      base_price: auctionLots.base_price,
      final_price: auctionSettlements.final_price,
      winner_tenant_id: auctionSettlements.winner_tenant_id,
      winner_name: nbfcTenants.display_name,
      status: auctionSettlements.status,
      updated_at: auctionSettlements.updated_at,
    })
    .from(auctionSettlements)
    .innerJoin(auctionLots, eq(auctionLots.id, auctionSettlements.lot_id))
    .innerJoin(
      nbfcTenants,
      eq(nbfcTenants.id, auctionSettlements.winner_tenant_id),
    )
    .where(eq(auctionSettlements.seller_tenant_id, tenant.id))
    .orderBy(desc(auctionSettlements.updated_at))
    .limit(50);

  const settlements: SettlementRow[] = settlementRows.map((s) => ({
    id: s.id,
    lot_id: s.lot_code,
    final_price: Number(s.final_price),
    winner_tenant_id: s.winner_tenant_id,
    winner_name: s.winner_name,
    status: s.status as SettlementStatus,
    updated_at: s.updated_at.toISOString(),
  }));

  // Post-auction settlement headline metrics.
  const sumFinal = settlementRows.reduce(
    (a, s) => a + Number(s.final_price),
    0,
  );
  const sumBase = settlementRows.reduce((a, s) => a + Number(s.base_price), 0);
  const deliveredCount = settlementRows.filter(
    (s) => s.status === "delivered",
  ).length;
  const settlementRecoveryRate =
    settlementRows.length > 0 ? deliveredCount / settlementRows.length : null;
  const premiumOverBase =
    sumBase > 0 ? (sumFinal - sumBase) / sumBase : null;

  // 8. Buyback requests — customer-initiated, this tenant (E-118).
  const buybackDbRows = await db
    .select()
    .from(nbfcBuybackRequests)
    .where(eq(nbfcBuybackRequests.tenant_id, tenant.id))
    .orderBy(desc(nbfcBuybackRequests.requested_at))
    .limit(50);

  const buybackRows: BuybackRow[] = buybackDbRows.map((b) => ({
    id: b.id,
    customer_name: b.customer_name,
    battery_serial: b.battery_serial,
    soh_percent: b.soh_percent != null ? Number(b.soh_percent) : null,
    requested_at: b.requested_at.toISOString(),
    evaluation_status: b.evaluation_status,
    offer_amount: b.offer_amount != null ? Number(b.offer_amount) : null,
    status: b.status,
  }));

  return (
    <div className="space-y-8">
      <header>
        <p className="section-label-muted">Recovery & Auction</p>
        <h1 className="mt-1 text-2xl font-semibold text-[color:var(--color-brand-navy)]">
          Repossession pipeline — {tenant.display_name}
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-ink-muted)]">
          Close the loop — move batteries through inspection, refurbish, auction
          and settlement to recycle capital.
        </p>
      </header>

      {/* 1. Recovery pipeline ------------------------------------------------ */}
      <section className="card-iTarang p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="section-label-muted">Recovery pipeline</p>
            <h2 className="mt-1 text-lg font-semibold text-[color:var(--color-brand-navy)]">
              {enrichedRows.length} assets in motion
            </h2>
          </div>
          <div className="flex flex-wrap gap-6">
            <Metric label="Value locked" value={fmtCompactINR(valueLocked)} />
            <Metric
              label="Est. recovery"
              value={fmtCompactINR(estRecovery)}
              tone="success"
            />
            <Metric
              label="Recovery rate"
              value={fmtPct(pipelineRecoveryRate)}
              tone="success"
            />
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {PIPELINE_CARDS.map(({ stage, icon: Icon, tone }) => (
            <div
              key={stage}
              className="rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-4"
            >
              <div className="flex items-center gap-2">
                <Icon className={`h-4 w-4 ${tone}`} />
                <p className="section-label-muted">{STAGE_LABEL[stage]}</p>
              </div>
              <p className="mt-2 text-3xl font-semibold tabular-nums text-[color:var(--color-brand-navy)]">
                {enrichedRows.filter((r) => r.stage === stage).length}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* 2. Auction marketplace + Battery evaluation ------------------------- */}
      <section className="space-y-3">
        <div>
          <p className="section-label-muted">Auction marketplace</p>
          <h2 className="mt-1 text-lg font-semibold text-[color:var(--color-brand-navy)]">
            {lots.length} live {lots.length === 1 ? "lot" : "lots"} · timers
            update every second
          </h2>
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            {lots.length === 0 ? (
              <div className="card-iTarang p-8 text-center text-sm text-[color:var(--color-ink-muted)]">
                No live auctions.
              </div>
            ) : (
              <AuctionLotsGrid
                lots={lots}
                columnsClassName="grid-cols-1 xl:grid-cols-2"
              />
            )}
          </div>
          <aside className="lg:col-span-1">
            <div className="lg:sticky lg:top-6">
              <BatteryEvaluationPanel candidates={pendingEvaluations} />
            </div>
          </aside>
        </div>
      </section>

      {/* 3. Post-auction settlement ----------------------------------------- */}
      <section className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="section-label-muted">Post-auction settlement</p>
            <h2 className="mt-1 text-lg font-semibold text-[color:var(--color-brand-navy)]">
              {settlements.length} settled{" "}
              {settlements.length === 1 ? "lot" : "lots"}
            </h2>
          </div>
          <div className="flex flex-wrap gap-6">
            <Metric label="Total value" value={fmtCompactINR(sumFinal)} />
            <Metric
              label="Recovery rate"
              value={fmtPct(settlementRecoveryRate)}
              tone="success"
            />
            <Metric
              label="Premium over base"
              value={fmtSignedPct(premiumOverBase)}
              tone="success"
            />
          </div>
        </div>
        {settlements.length === 0 ? (
          <div className="card-iTarang p-8 text-center text-sm text-[color:var(--color-ink-muted)]">
            No settlements yet.
          </div>
        ) : (
          <div className="card-iTarang p-4">
            <AuctionSettlementsTable rows={settlements} />
          </div>
        )}
      </section>

      {/* 4. Buyback requests (E-118) ---------------------------------------- */}
      <section className="space-y-3">
        <div>
          <p className="section-label-muted">Buyback requests</p>
          <h2 className="mt-1 text-lg font-semibold text-[color:var(--color-brand-navy)]">
            {buybackRows.length} customer{" "}
            {buybackRows.length === 1 ? "request" : "requests"}
          </h2>
        </div>
        <BuybackRequestsTable rows={buybackRows} />
      </section>

      {/* 5. Operations workspace — kanban + immobilisation ------------------ */}
      <section className="space-y-3">
        <div>
          <p className="section-label-muted">Operations workspace</p>
          <h2 className="mt-1 text-lg font-semibold text-[color:var(--color-brand-navy)]">
            Recovery board
          </h2>
          <p className="mt-0.5 text-sm text-[color:var(--color-ink-muted)]">
            Move batteries through inspection → refurbish → auction. Initiate
            immobilisation requests; iTarang sales_head approves before they
            execute.
          </p>
        </div>
        <RecoveryKanban
          stages={STAGES as unknown as Stage[]}
          stageLabels={STAGE_LABEL}
          rows={enrichedRows}
          tenantLegal={tenantLegal}
        />
      </section>

      {/* Immobilisation requests */}
      <section className="card-iTarang overflow-hidden">
        <div className="border-b border-[color:var(--color-border)] px-4 py-3">
          <h2 className="font-semibold text-[color:var(--color-brand-navy)]">
            Immobilisation requests
          </h2>
          <p className="mt-0.5 text-xs text-[color:var(--color-ink-muted)]">
            iTarang sales_head approves; on approval the device-immobilisation
            row is written.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-[color:var(--color-bg)] text-xs uppercase tracking-widest text-[color:var(--color-ink-muted)]">
              <tr>
                <th className="px-3 py-2 text-left font-bold">Created</th>
                <th className="px-3 py-2 text-left font-bold">Loan</th>
                <th className="px-3 py-2 text-left font-bold">Reason</th>
                <th className="px-3 py-2 text-left font-bold">Status</th>
                <th className="px-3 py-2 text-left font-bold">Expires</th>
              </tr>
            </thead>
            <tbody>
              {enrichedRequests.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-3 py-8 text-center text-[color:var(--color-ink-muted)]"
                  >
                    No immobilisation requests yet.
                  </td>
                </tr>
              ) : (
                enrichedRequests.map((r) => (
                  <tr
                    key={r.id}
                    className="border-t border-[color:var(--color-border)]"
                  >
                    <td className="px-3 py-2 text-xs text-[color:var(--color-ink-muted)] tabular-nums">
                      {r.created_at?.toLocaleString() ?? "—"}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {r.loan_application_id}
                    </td>
                    <td className="px-3 py-2 text-xs font-bold uppercase">
                      {r.reason_code}
                    </td>
                    <td className="px-3 py-2">
                      <ImmobilisationStatusPill
                        status={r.status}
                        executed={r.executed}
                      />
                    </td>
                    <td className="px-3 py-2 text-xs text-[color:var(--color-ink-muted)] tabular-nums">
                      {r.expires_at?.toLocaleString() ?? "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <p className="text-center text-xs text-[color:var(--color-ink-muted)]">
        Every auction action and bid is logged to the shared audit trail. This
        view complies with RBI Digital Lending Directions 2025 and the Fair
        Practices Code.
      </p>
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "success";
}) {
  return (
    <div className="text-left sm:text-right">
      <p className="text-[10px] font-bold uppercase tracking-widest text-[color:var(--color-ink-muted)]">
        {label}
      </p>
      <p
        className={`mt-0.5 text-lg font-semibold tabular-nums ${
          tone === "success"
            ? "text-[color:var(--color-success)]"
            : "text-[color:var(--color-brand-navy)]"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function ImmobilisationStatusPill({
  status,
  executed,
}: {
  status: string;
  executed: boolean;
}) {
  if (status === "approved" && executed) {
    return <span className="status-pill status-pill-danger">Executed</span>;
  }
  if (status === "approved") {
    return <span className="status-pill status-pill-success">Approved</span>;
  }
  if (status === "rejected") {
    return <span className="status-pill status-pill-neutral">Rejected</span>;
  }
  if (status === "expired") {
    return <span className="status-pill status-pill-neutral">Expired</span>;
  }
  return (
    <span className="status-pill status-pill-warning">Pending sales_head</span>
  );
}
