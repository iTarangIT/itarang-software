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
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  nbfcRecoveryPipeline,
  nbfcLoans,
  loanFiles,
  iotDevices,
  dualApprovalRequests,
  nbfcImmobilisationActions,
} from "@/lib/db/schema";
import { getCurrentTenant, requireNbfcAccess } from "@/lib/nbfc/tenant";
import { getVehicleStates } from "@/lib/db/iot-queries";
import RecoveryKanban from "./_components/RecoveryKanban";

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
