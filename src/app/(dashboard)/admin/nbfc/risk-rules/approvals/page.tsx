/**
 * E-068 — /admin/nbfc/risk-rules/approvals page (BRD §6.3.3).
 *
 * Risk Head approval queue. Lists pending threshold change requests and
 * lets a different admin approve or reject. Route protection comes from
 * `src/middleware.ts` which gates `/admin/*` to admin-grade roles; the API
 * route additionally enforces self-approval rejection (HTTP 403).
 */
import RiskRuleApprovalQueue from "@/components/admin/nbfc/RiskRuleApprovalQueue";

export const dynamic = "force-dynamic";

export default function RiskRuleApprovalsPage() {
  return (
    <main className="mx-auto max-w-6xl p-6">
      <h1 className="mb-2 text-2xl font-semibold text-gray-900">
        Risk Rule Engine — Approval Queue
      </h1>
      <p className="mb-6 text-sm text-gray-600">
        Pending threshold changes awaiting Risk Head approval. The same admin
        who raised the request cannot approve it (BRD §6.3.3 dual-approval
        rule).
      </p>
      <RiskRuleApprovalQueue />
    </main>
  );
}
