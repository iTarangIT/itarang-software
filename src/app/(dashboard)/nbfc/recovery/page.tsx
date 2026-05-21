/**
 * /nbfc/recovery — Recovery & Auction (BRD §6.1.7)
 *
 * Stage kanban + per-card actions. Reads nbfc_recovery_pipeline directly so
 * the server component renders synchronously. Card transitions and the
 * immobilisation request modal are wired client-side via the existing API
 * endpoints (PATCH /api/nbfc/recovery/[id]/stage, POST
 * /api/nbfc/actions/battery-immobilisation/initiate).
 */
import { db } from "@/lib/db";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
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
  nbfcTenants,
} from "@/lib/db/schema";
import { getCurrentTenant, requireNbfcAccess } from "@/lib/nbfc/tenant";
import { getVehicleStates } from "@/lib/db/iot-queries";
import RecoveryKanban from "./_components/RecoveryKanban";
import PendingEvaluationsList from "./_components/PendingEvaluationsList";
import { AuctionLotsGrid, type AuctionLot } from "@/components/nbfc-portal/AuctionLotsGrid";
import { AuctionSettlementsTable, type SettlementRow, type SettlementStatus } from "@/components/nbfc-portal/AuctionSettlementsTable";

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

export default async function RecoveryPage() {
  const tenant = await getCurrentTenant();
  await requireNbfcAccess(tenant.id);

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

  // 2. Borrower context for each serial — joined via nbfcLoans.vehicleno = battery_serial.
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
          .leftJoin(loanFiles, eq(loanFiles.loan_application_id, nbfcLoans.loan_application_id))
          .leftJoin(iotDevices, eq(iotDevices.serial_number, nbfcLoans.vehicleno))
          .where(
            and(eq(nbfcLoans.tenant_id, tenant.id), inArray(nbfcLoans.vehicleno, serials)),
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
      states.filter((s) => s.soh_pct != null).map((s) => [s.vehicleno, s.soh_pct as number]),
    );
  } catch {
    /* VPS unreachable — render without live SOH */
  }

  // 4. Pending immobilisation requests for this tenant + executed actions for status pills.
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
      ? Math.max(0, Math.floor((nowMs - r.updated_at.getTime()) / (24 * 60 * 60 * 1000)))
      : 0;
    return {
      id: r.id,
      battery_serial: r.battery_serial,
      stage: r.stage as Stage,
      estimated_recovery_value:
        r.estimated_recovery_value != null ? Number(r.estimated_recovery_value) : null,
      borrower_name: c?.borrower_name ?? null,
      loan_application_id: c?.loan_application_id ?? null,
      current_dpd: c?.current_dpd ?? null,
      outstanding_amount: c?.outstanding_amount != null ? Number(c.outstanding_amount) : null,
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

  // 5. Battery Evaluations entry point — rows currently in needs_inspection.
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
    .where(and(eq(auctionLots.status, "live"), gt(auctionLots.ends_at, new Date())))
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
    autoBidByLot = new Map(myAutoBids.map((b) => [b.lot_id, Number(b.max_amount)]));
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
      final_price: auctionSettlements.final_price,
      winner_tenant_id: auctionSettlements.winner_tenant_id,
      winner_name: nbfcTenants.display_name,
      status: auctionSettlements.status,
      updated_at: auctionSettlements.updated_at,
    })
    .from(auctionSettlements)
    .innerJoin(auctionLots, eq(auctionLots.id, auctionSettlements.lot_id))
    .innerJoin(nbfcTenants, eq(nbfcTenants.id, auctionSettlements.winner_tenant_id))
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

  return (
    <div className="space-y-6">
      <header>
        <p className="section-label-muted">Recovery & Auction</p>
        <h1 className="text-2xl font-semibold text-[color:var(--color-brand-navy)] mt-1">
          Repossession pipeline — {tenant.display_name}
        </h1>
        <p className="text-sm text-[color:var(--color-ink-muted)] mt-1">
          Move batteries through inspection → refurbish → auction. Initiate immobilisation
          requests; iTarang sales_head approves before they execute.
        </p>
      </header>

      {/* KPI strip */}
      <section className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {STAGES.map((s) => (
          <div key={s} className="card-iTarang p-3">
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
              {STAGE_LABEL[s]}
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-[color:var(--color-brand-navy)]">
              {enrichedRows.filter((r) => r.stage === s).length}
            </p>
          </div>
        ))}
      </section>

      <RecoveryKanban
        stages={STAGES as unknown as Stage[]}
        stageLabels={STAGE_LABEL}
        rows={enrichedRows}
      />

      {/* Pending immobilisations */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800">
          <h2 className="font-semibold">Immobilisation requests</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            iTarang sales_head approves; on approval the device-immobilisation row is written.
          </p>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-800/50 text-xs uppercase tracking-widest text-slate-500">
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
                <td colSpan={5} className="px-3 py-8 text-center text-slate-500">
                  No immobilisation requests yet.
                </td>
              </tr>
            ) : (
              enrichedRequests.map((r) => (
                <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="px-3 py-2 text-xs text-slate-500 tabular-nums">
                    {r.created_at?.toLocaleString() ?? "—"}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{r.loan_application_id}</td>
                  <td className="px-3 py-2 text-xs uppercase font-bold">{r.reason_code}</td>
                  <td className="px-3 py-2">
                    <ImmobilisationStatusPill status={r.status} executed={r.executed} />
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500 tabular-nums">
                    {r.expires_at?.toLocaleString() ?? "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      {/* Battery Evaluations — Needs Inspection (BRD §6.1.7) */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800">
          <h2 className="font-semibold">Battery evaluations — needs inspection</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            3-step form per BRD §6.1.7 — Technical → Refurbishment Analysis → Pricing.
            Base auction price auto-computes from SOH on submit.
          </p>
        </div>
        <PendingEvaluationsList rows={pendingEvaluations} />
      </section>

      {/* Auction Marketplace — Live Lots (BRD §6.1.7) */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800">
          <h2 className="font-semibold">Auction marketplace — live lots</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Lot ID · capacity · avg SOH · age · qty · base · current bid · bidder count · countdown.
            Bidding modal enforces min-next-bid and a binding confirmation per RBI audit requirements.
          </p>
        </div>
        <div className="p-4">
          {lots.length === 0 ? (
            <p className="text-center text-slate-500 text-sm py-8">No live auctions.</p>
          ) : (
            <AuctionLotsGrid lots={lots} />
          )}
        </div>
      </section>

      {/* Post-auction Settlements (BRD §6.1.7) */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800">
          <h2 className="font-semibold">Post-auction settlements</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Status flow: Payment Pending → In Transit → Delivered. Each transition is audit-logged.
          </p>
        </div>
        {settlements.length === 0 ? (
          <p className="text-center text-slate-500 text-sm py-8">No settlements yet.</p>
        ) : (
          <AuctionSettlementsTable rows={settlements} />
        )}
      </section>
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
    return (
      <span className="px-2 py-0.5 rounded text-xs font-bold uppercase bg-red-50 text-red-700">
        Executed
      </span>
    );
  }
  if (status === "approved") {
    return (
      <span className="px-2 py-0.5 rounded text-xs font-bold uppercase bg-emerald-50 text-emerald-700">
        Approved
      </span>
    );
  }
  if (status === "rejected") {
    return (
      <span className="px-2 py-0.5 rounded text-xs font-bold uppercase bg-slate-100 text-slate-500">
        Rejected
      </span>
    );
  }
  if (status === "expired") {
    return (
      <span className="px-2 py-0.5 rounded text-xs font-bold uppercase bg-gray-100 text-gray-500">
        Expired
      </span>
    );
  }
  return (
    <span className="px-2 py-0.5 rounded text-xs font-bold uppercase bg-amber-50 text-amber-700">
      Pending sales_head
    </span>
  );
}
