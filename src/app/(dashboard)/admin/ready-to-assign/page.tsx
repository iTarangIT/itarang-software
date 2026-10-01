import Link from "next/link";
import { requireRole } from "@/lib/auth-utils";
import {
    AWAITING_ASSIGNMENT_OVERDUE_DAYS,
    countAwaitingAssignment,
    listReadyToAssign,
    salesReadyReasonLabel,
} from "@/lib/leads/salesReady";
import { LEAD_STATUS_LABEL } from "@/lib/leads/queueFilters";
import { LEADS_BULK_ROLES } from "@/lib/leads/access";
import type { LeadStatus } from "@/lib/lifecycle/transitions";
import { ReadyToAssignTable } from "./ReadyToAssignTable";

export const dynamic = "force-dynamic";

const LIST_CAP = 500;
// Who may give a lead an owner — the roles POST /api/admin/leads/bulk accepts
// (LEADS_BULK_ROLES), which is what the table's Reassign calls. The other
// roles this page admits (business head, sales manager) read the queue and
// cannot assign from it.
const ASSIGN_ROLES: readonly string[] = LEADS_BULK_ROLES;

// Tracker ID 82 (handover P2-10): sales-ready leads nobody owns, oldest wait
// first. The wait is counted from the Sales-ready event, not from creation.
//
// The CEO card "Sales-ready leads awaiting assignment (7+ days)" opens this
// page with ?min_days=7. Card, page and the daily email's "Right now" box all
// count by ONE rule (awaitingAssignment in lib/leads/salesReady.ts), and the
// page says the number it is showing, so what the card said is what is listed.
export default async function ReadyToAssignPage({
    searchParams,
}: {
    searchParams: Promise<{ min_days?: string }>;
}) {
    const user = await requireRole(["admin", "sales_head", "ceo", "business_head", "sales_manager", "partner"]);
    const canAssign = ASSIGN_ROLES.includes(user.role);

    const requested = Number.parseInt((await searchParams).min_days ?? "", 10);
    const minDays = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 3650) : 0;
    const [counts, rows] = await Promise.all([
        countAwaitingAssignment(),
        listReadyToAssign({ minDays, limit: LIST_CAP }),
    ]);
    const overdueOnly = minDays === AWAITING_ASSIGNMENT_OVERDUE_DAYS;
    const showing = minDays === 0 ? counts.total : overdueOnly ? counts.overdue : rows.length;

    const tab = (href: string, label: string, n: number, active: boolean) => (
        <Link
            href={href}
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                active ? "border-gray-900 bg-gray-900 text-white" : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
            }`}
        >
            {label} · {n.toLocaleString("en-IN")}
        </Link>
    );

    return (
        <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1400px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">Ready to assign</h1>
                <p className="mt-1 text-sm text-ink-muted">
                    Leads that became sales-ready and have no owner.{" "}
                    {canAssign ? "Tick leads and assign them from here. " : ""}
                    The wait is counted from the Sales-ready event (or from when a reactivated lead came back to the
                    pool). Leads with a dead or non-responsive number are not listed.
                </p>
            </header>

            <div className="flex flex-wrap items-center gap-2">
                {tab("/admin/ready-to-assign", "All awaiting", counts.total, minDays === 0)}
                {tab(
                    `/admin/ready-to-assign?min_days=${AWAITING_ASSIGNMENT_OVERDUE_DAYS}`,
                    `Waiting ${AWAITING_ASSIGNMENT_OVERDUE_DAYS}+ days`,
                    counts.overdue,
                    overdueOnly,
                )}
                {counts.oldestDays != null && (
                    <span className="text-xs text-gray-500">Longest wait: {counts.oldestDays} days</span>
                )}
            </div>

            {rows.length === 0 ? (
                <p className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500">
                    {minDays > 0 && counts.total > 0
                        ? `No lead has been waiting ${minDays} days or more. ${counts.total.toLocaleString("en-IN")} are waiting in all.`
                        : "Nothing is waiting — every sales-ready lead has an owner."}
                </p>
            ) : (
                <>
                    {showing > rows.length && (
                        <p className="text-xs text-gray-500">
                            Showing the {rows.length.toLocaleString("en-IN")} longest waits of {showing.toLocaleString("en-IN")}.
                        </p>
                    )}
                    <ReadyToAssignTable
                        canAssign={canAssign}
                        overdueDays={AWAITING_ASSIGNMENT_OVERDUE_DAYS}
                        rows={rows.map((r) => ({
                            id: r.id,
                            dealer_name: r.dealer_name,
                            location: [r.city, r.state].filter(Boolean).join(", ") || "—",
                            status: r.lead_status ? (LEAD_STATUS_LABEL[r.lead_status as LeadStatus] ?? r.lead_status) : "—",
                            interest_level: r.interest_level,
                            reason: salesReadyReasonLabel(r.sales_ready_reason),
                            days_waiting: r.days_waiting,
                        }))}
                    />
                </>
            )}
        </div>
    );
}
