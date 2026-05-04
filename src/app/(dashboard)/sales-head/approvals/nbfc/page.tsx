/**
 * Sales-Head queue for NBFC dual-approval requests (battery_immobilisation
 * and any future action_type that requires sales_head sign-off). Lists
 * pending dual_approval_requests + a recent decision history.
 *
 * Per BRD §6.4.3 / user direction (2026-05-04): NBFC creates the request,
 * iTarang sales_head approves/rejects, the upstream service writes the
 * nbfc_immobilisation_actions row.
 */
import Link from "next/link";
import { db } from "@/lib/db";
import { and, desc, eq } from "drizzle-orm";
import { dualApprovalRequests, nbfcTenants, users } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import ImmobilisationApprovalCard from "./_components/ImmobilisationApprovalCard";

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

export default async function NbfcSalesHeadApprovalsPage() {
  const user = await requireAuth();
  if (user.role !== "sales_head") {
    return (
      <div className="max-w-4xl mx-auto py-12 px-6">
        <h1 className="text-2xl font-semibold text-red-600">Forbidden</h1>
        <p className="mt-2 text-sm text-gray-500">
          NBFC immobilisation approvals require the <code>sales_head</code> role.
        </p>
      </div>
    );
  }

  const pending = await db
    .select({
      id: dualApprovalRequests.id,
      action_type: dualApprovalRequests.action_type,
      entity_id: dualApprovalRequests.entity_id,
      tenant_id: dualApprovalRequests.tenant_id,
      tenant_name: nbfcTenants.display_name,
      tenant_slug: nbfcTenants.slug,
      reason_code: dualApprovalRequests.reason_code,
      evidence_snapshot: dualApprovalRequests.evidence_snapshot,
      created_at: dualApprovalRequests.created_at,
      expires_at: dualApprovalRequests.expires_at,
      initiator_user_id: dualApprovalRequests.initiator_user_id,
      initiator_name: users.name,
      initiator_email: users.email,
    })
    .from(dualApprovalRequests)
    .leftJoin(nbfcTenants, eq(nbfcTenants.id, dualApprovalRequests.tenant_id))
    .leftJoin(users, eq(users.id, dualApprovalRequests.initiator_user_id))
    .where(
      and(
        eq(dualApprovalRequests.status, "pending_approval"),
        eq(dualApprovalRequests.required_approver_role, "sales_head"),
      ),
    )
    .orderBy(desc(dualApprovalRequests.created_at))
    .limit(100);

  const recent = await db
    .select({
      id: dualApprovalRequests.id,
      action_type: dualApprovalRequests.action_type,
      entity_id: dualApprovalRequests.entity_id,
      tenant_name: nbfcTenants.display_name,
      status: dualApprovalRequests.status,
      approved_at: dualApprovalRequests.approved_at,
      rejected_at: dualApprovalRequests.rejected_at,
      rejection_reason: dualApprovalRequests.rejection_reason,
    })
    .from(dualApprovalRequests)
    .leftJoin(nbfcTenants, eq(nbfcTenants.id, dualApprovalRequests.tenant_id))
    .where(eq(dualApprovalRequests.required_approver_role, "sales_head"))
    .orderBy(desc(dualApprovalRequests.created_at))
    .limit(20);

  const completedCount = recent.filter((r) => r.status !== "pending_approval").length;

  return (
    <div className="max-w-7xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-black text-gray-900">NBFC Immobilisation Approvals</h1>
          <p className="text-sm text-gray-500 mt-1 uppercase tracking-widest font-bold">
            Sales Head — Battery Immobilisation Sign-off
          </p>
        </div>
        <Link
          href="/sales-head/approvals"
          className="text-xs uppercase tracking-widest font-bold text-gray-500 hover:text-gray-900"
        >
          ← Back to all approvals
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
          <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Pending</p>
          <p className="text-3xl font-black text-orange-600">{pending.length}</p>
        </div>
        <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
          <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Decided (Last 20)</p>
          <p className="text-3xl font-black text-green-600">{completedCount}</p>
        </div>
        <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
          <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">SLA</p>
          <p className="text-3xl font-black text-gray-900">24 Hours</p>
        </div>
      </div>

      <section className="space-y-4 mb-12">
        <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest">
          Awaiting your decision ({pending.length})
        </h2>
        {pending.length === 0 ? (
          <div className="bg-white border border-dashed border-gray-200 rounded-xl p-12 text-center text-sm text-gray-500">
            No pending NBFC immobilisation requests. Nice and quiet.
          </div>
        ) : (
          pending.map((row) => {
            const snap = (row.evidence_snapshot ?? {}) as EvidenceSnapshot;
            return (
              <ImmobilisationApprovalCard
                key={row.id}
                id={row.id}
                actionType={row.action_type}
                tenantName={row.tenant_name ?? row.tenant_slug ?? "—"}
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
                <th className="px-4 py-3 text-left font-bold">NBFC</th>
                <th className="px-4 py-3 text-left font-bold">Loan</th>
                <th className="px-4 py-3 text-left font-bold">Action</th>
                <th className="px-4 py-3 text-left font-bold">Status</th>
                <th className="px-4 py-3 text-left font-bold">Note</th>
              </tr>
            </thead>
            <tbody>
              {recent.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                    No decisions on record yet.
                  </td>
                </tr>
              ) : (
                recent.map((r) => (
                  <tr key={r.id} className="border-t border-gray-100">
                    <td className="px-4 py-2 text-xs text-gray-500 tabular-nums">
                      {(r.approved_at ?? r.rejected_at ?? null)?.toLocaleString() ?? "—"}
                    </td>
                    <td className="px-4 py-2">{r.tenant_name ?? "—"}</td>
                    <td className="px-4 py-2 font-mono text-xs">{r.entity_id}</td>
                    <td className="px-4 py-2">{r.action_type}</td>
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
    <span className={`px-2 py-0.5 rounded text-xs font-bold uppercase ${tone}`}>{status}</span>
  );
}

