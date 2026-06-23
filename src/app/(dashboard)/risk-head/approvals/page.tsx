/**
 * Risk Head — battery-immobilisation approval inbox (/risk-head/approvals).
 *
 * Second approver surface of the two-person gate. Lists this tenant's pending
 * dual_approval_requests (action_type=battery_immobilisation,
 * required_approver_role=nbfc_risk_head) plus a recent-decision history. The
 * Risk Head approves/rejects via the NBFC dual-approval routes; the engine
 * enforces initiator≠approver and writes the immutable audit + borrower notice.
 */
import { db } from "@/lib/db";
import { and, desc, eq } from "drizzle-orm";
import { dualApprovalRequests, users } from "@/lib/db/schema";
import { getCurrentTenant } from "@/lib/nbfc/tenant";
import { BATTERY_IMMOBILISATION_ACTION_TYPE } from "@/lib/nbfc/actions/battery-immobilisation/service";
import NbfcImmobilisationApprovalCard from "./_components/NbfcImmobilisationApprovalCard";

export const dynamic = "force-dynamic";

type EvidenceSnapshot = {
  loan_application_id?: string;
  imei?: string;
  reason_code?: string;
  loan?: {
    vehicleno?: string | null;
    current_dpd?: number | null;
    outstanding_amount?: string | null;
  } | null;
  snapshot_at?: string;
};

export default async function RiskHeadApprovalsPage() {
  const tenant = await getCurrentTenant();

  const pending = await db
    .select({
      id: dualApprovalRequests.id,
      action_type: dualApprovalRequests.action_type,
      entity_id: dualApprovalRequests.entity_id,
      reason_code: dualApprovalRequests.reason_code,
      evidence_snapshot: dualApprovalRequests.evidence_snapshot,
      created_at: dualApprovalRequests.created_at,
      expires_at: dualApprovalRequests.expires_at,
      initiator_user_id: dualApprovalRequests.initiator_user_id,
      initiator_name: users.name,
      initiator_email: users.email,
    })
    .from(dualApprovalRequests)
    .leftJoin(users, eq(users.id, dualApprovalRequests.initiator_user_id))
    .where(
      and(
        eq(dualApprovalRequests.tenant_id, tenant.id),
        eq(dualApprovalRequests.status, "pending_approval"),
        eq(dualApprovalRequests.required_approver_role, "nbfc_risk_head"),
        eq(dualApprovalRequests.action_type, BATTERY_IMMOBILISATION_ACTION_TYPE),
      ),
    )
    .orderBy(desc(dualApprovalRequests.created_at))
    .limit(100);

  const recent = await db
    .select({
      id: dualApprovalRequests.id,
      action_type: dualApprovalRequests.action_type,
      entity_id: dualApprovalRequests.entity_id,
      status: dualApprovalRequests.status,
      approved_at: dualApprovalRequests.approved_at,
      rejected_at: dualApprovalRequests.rejected_at,
      rejection_reason: dualApprovalRequests.rejection_reason,
    })
    .from(dualApprovalRequests)
    .where(
      and(
        eq(dualApprovalRequests.tenant_id, tenant.id),
        eq(dualApprovalRequests.required_approver_role, "nbfc_risk_head"),
        eq(dualApprovalRequests.action_type, BATTERY_IMMOBILISATION_ACTION_TYPE),
      ),
    )
    .orderBy(desc(dualApprovalRequests.created_at))
    .limit(20);

  const completedCount = recent.filter(
    (r) => r.status !== "pending_approval",
  ).length;

  return (
    <div className="space-y-8">
      <div>
        <p className="section-label-muted">Immobilisation Approvals</p>
        <h1 className="mt-1 text-2xl font-semibold text-[color:var(--color-brand-navy)]">
          Battery immobilisation sign-off — {tenant.display_name}
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-ink-muted)]">
          Review the evidence and approve or reject. Approval immobilises the
          financed battery and sends the borrower notice; both are written to the
          immutable audit log.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
          <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">
            Pending
          </p>
          <p className="text-3xl font-black text-orange-600">{pending.length}</p>
        </div>
        <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
          <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">
            Decided (Last 20)
          </p>
          <p className="text-3xl font-black text-green-600">{completedCount}</p>
        </div>
        <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
          <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">
            SLA
          </p>
          <p className="text-3xl font-black text-gray-900">24 Hours</p>
        </div>
      </div>

      <section className="space-y-4">
        <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest">
          Awaiting your decision ({pending.length})
        </h2>
        {pending.length === 0 ? (
          <div className="bg-white border border-dashed border-gray-200 rounded-xl p-12 text-center text-sm text-gray-500">
            No pending immobilisation requests. Nice and quiet.
          </div>
        ) : (
          pending.map((row) => {
            const snap = (row.evidence_snapshot ?? {}) as EvidenceSnapshot;
            return (
              <NbfcImmobilisationApprovalCard
                key={row.id}
                id={row.id}
                actionType={row.action_type}
                reasonCode={row.reason_code}
                loanApplicationId={row.entity_id}
                vehicleno={snap.loan?.vehicleno ?? null}
                imei={snap.imei ?? null}
                outstandingAmount={snap.loan?.outstanding_amount ?? null}
                currentDpd={snap.loan?.current_dpd ?? null}
                initiator={
                  row.initiator_name
                    ? `${row.initiator_name} (${row.initiator_email ?? "—"})`
                    : row.initiator_user_id
                }
                createdAt={row.created_at}
                expiresAt={row.expires_at}
              />
            );
          })
        )}
      </section>

      <section>
        <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest mb-3">
          Recent decisions
        </h2>
        <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-widest text-gray-500">
              <tr>
                <th className="px-4 py-3 text-left font-bold">When</th>
                <th className="px-4 py-3 text-left font-bold">Loan</th>
                <th className="px-4 py-3 text-left font-bold">Status</th>
                <th className="px-4 py-3 text-left font-bold">Note</th>
              </tr>
            </thead>
            <tbody>
              {recent.length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    className="px-4 py-8 text-center text-gray-500"
                  >
                    No decisions on record yet.
                  </td>
                </tr>
              ) : (
                recent.map((r) => (
                  <tr key={r.id} className="border-t border-gray-100">
                    <td className="px-4 py-2 text-xs text-gray-500 tabular-nums">
                      {(r.approved_at ?? r.rejected_at ?? null)?.toLocaleString() ??
                        "—"}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{r.entity_id}</td>
                    <td className="px-4 py-2">
                      <StatusPill status={r.status} />
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-500">
                      {r.status === "rejected" ? r.rejection_reason : ""}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "approved"
      ? "bg-emerald-50 text-emerald-700"
      : status === "rejected"
        ? "bg-red-50 text-red-700"
        : status === "expired"
          ? "bg-gray-100 text-gray-500"
          : "bg-amber-50 text-amber-700";
  return (
    <span
      className={`px-2 py-0.5 rounded text-xs font-bold uppercase ${tone}`}
    >
      {status}
    </span>
  );
}
