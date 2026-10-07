import { requireRole } from "@/lib/auth-utils";
import { errorMessage } from "@/lib/api-utils";
import { ECOFY_MANAGER_ROLES, ecofyLeadHref } from "@/lib/ecofy/access";
import { withEcofyTab } from "@/lib/ecofy/leadTabs";
import { crmLeadIdsForCases } from "@/lib/ecofy/queries";
import { readQueue } from "@/lib/ecofy/service";
import { formatIst, inr, StageBadge } from "@/components/ecofy/badges";
import { EcofyQueueGrid, type QueueColumn, type QueueRow } from "@/components/ecofy/EcofyQueueGrid";
import { FinancingQueueAction } from "@/components/ecofy/FinancingQueueAction";
import type { EcofyCase } from "@/components/ecofy/client";

export const dynamic = "force-dynamic";

type Row = {
    id: string;
    caseNo: string;
    segment: string;
    stage: string;
    subStatus: string | null;
    version: number;
    financierName?: string | null;
    customer: { fullName: string; city: string | null } | null;
    ageing: { inStageWorkingHours: number };
    decision: { id: string; attemptNo: number; submittedAt: string };
    file: { fileNo: string; acceptedTotalInr: number } | null;
};

const COLUMNS: QueueColumn[] = [
    { key: "file", label: "File", filter: "text", mono: true },
    { key: "case", label: "Case", filter: "text" },
    { key: "customer", label: "Customer", filter: "text" },
    { key: "city", label: "City", filter: "select" },
    { key: "financier", label: "Financier", filter: "select" },
    { key: "total", label: "Accepted total" },
    { key: "attempt", label: "Attempt", filter: "select" },
    { key: "submitted", label: "Submitted", date: true },
    { key: "waiting", label: "Waiting" },
    { key: "stage", label: "Stage", filter: "select" },
];

// E-307 — Files awaiting a financing decision for financiers iTarang Admin
// may see (Ecofy's /financing-queue). Each linked row opens the lead's
// Financing tab or records the decision in place with the same form
// (FinancingQueueAction; FR-11.5 — other financiers only, Ecofy enforces the
// financier's role). Search, per-column filters, date range and CSV are client-side
// (EcofyQueueGrid): the queue arrives whole from Ecofy.
export default async function EcofyFinancingPage() {
    const user = await requireRole([...ECOFY_MANAGER_ROLES]);
    let rows: Row[] = [];
    let error: string | null = null;
    try {
        rows = ((await readQueue("financing")) as Row[]) ?? [];
    } catch (err) {
        error = errorMessage(err);
    }
    const links = await crmLeadIdsForCases(rows.map((r) => r.id));

    const gridRows: QueueRow[] = rows.map((r) => {
        const leadId = links.get(r.id);
        const stageText = r.subStatus ? `${r.stage} · ${r.subStatus.replace(/_/g, " ").toLowerCase()}` : r.stage;
        return {
            id: r.decision.id,
            cells: {
                file: { text: r.file?.fileNo ?? "" },
                case: { text: r.caseNo, href: leadId ? `/sales-head/ecofy/leads/${leadId}` : undefined },
                customer: { text: r.customer?.fullName ?? "" },
                city: { text: r.customer?.city ?? "" },
                financier: { text: r.financierName ?? "" },
                total: { text: inr(r.file?.acceptedTotalInr) },
                attempt: { text: String(r.decision.attemptNo) },
                submitted: { text: r.decision.submittedAt, node: <span className="text-xs">{formatIst(r.decision.submittedAt)}</span> },
                waiting: { text: r.ageing?.inStageWorkingHours != null ? `${r.ageing.inStageWorkingHours} wh` : "" },
                stage: { text: stageText, node: <StageBadge value={r.stage} subStatus={r.subStatus} /> },
            },
            action: (
                <FinancingQueueAction
                    leadId={leadId ?? null}
                    leadHref={leadId ? withEcofyTab(ecofyLeadHref(user.role, leadId), "Financing") : null}
                    c={r as unknown as EcofyCase}
                    viewer={{ id: user.id, role: user.role }}
                />
            ),
        };
    });

    return (
        <div className="mx-auto max-w-[1600px] space-y-5 px-4 py-6 sm:px-6 md:px-8">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Ecofy — Financing queue</h1>
                <p className="mt-1 text-sm text-gray-600">
                    Files waiting for the financier&apos;s decision. Record Sanctioned or Rejected here or on the lead&apos;s Financing tab (other financiers only — Ecofy decides its own).
                </p>
            </header>
            {error && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Ecofy could not be reached: {error}</p>}
            {!error && (
                <EcofyQueueGrid
                    columns={COLUMNS}
                    rows={gridRows}
                    csvName="ecofy-financing-queue"
                    emptyText="No Files awaiting a decision."
                    searchPlaceholder="Search by file, case no., customer or city…"
                />
            )}
        </div>
    );
}
