import Link from "next/link";
import { requireRole } from "@/lib/auth-utils";
import {
    countAwaitingAssignment,
    isReadySplit,
    listReadyToAssign,
    READY_NO_OWNER_TITLE,
    READY_SPLIT_LABEL,
    READY_SPLITS,
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
// The CEO card opens this page with ?past=hot|other|any — the leads past their
// limit (18 Oct rework 1: Hot = hot_ready_to_assigned working hours, others =
// ready_to_assigned working days; readyPastLimitSql). ?min_days=N still works
// (working days). Card, page and the daily email's "Right now" box all
// count by ONE rule (awaitingAssignment in lib/leads/salesReady.ts), and the
// page says the number it is showing, so what the card said is what is listed.
export default async function ReadyToAssignPage({
    searchParams,
}: {
    searchParams: Promise<{ min_days?: string; split?: string; past?: string; state?: string; spoc_id?: string }>;
}) {
    const user = await requireRole(["admin", "sales_head", "ceo", "business_head", "sales_manager", "partner"]);
    const canAssign = ASSIGN_ROLES.includes(user.role);

    const sp = await searchParams;
    const requested = Number.parseInt(sp.min_days ?? "", 10);
    const minDays = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 3650) : 0;
    // ID 184: AI qualified / Hot / other, the card's split (one bucket per lead, AI first).
    const split = isReadySplit(sp.split) ? sp.split : undefined;
    // ID 184: the Sales dashboard's filters ride in on the card link. State
    // narrows the list as it narrows the card; ready leads have no owner, so
    // the person filter does not (the card ignores it too) — said on screen.
    const state = sp.state?.trim() || null;
    const personPicked = Boolean(sp.spoc_id?.trim());
    const withFilters = (href: string) => {
        if (!state) return href;
        return `${href}${href.includes("?") ? "&" : "?"}state=${encodeURIComponent(state)}`;
    };
    // 18 Oct rework 1: past the limit — Hot, others, or either.
    const past = sp.past === "hot" || sp.past === "other" || sp.past === "any" ? sp.past : undefined;
    const [counts, rows] = await Promise.all([
        countAwaitingAssignment({ state }),
        listReadyToAssign({ minDays, limit: LIST_CAP, split, pastLimit: past, state }),
    ]);
    const overdueDays = counts.overdueDays;
    const plain = minDays === 0 && !past;
    const showing = past
        ? past === "hot" && !split
            ? counts.hotPast
            : past === "other" && !split
              ? counts.otherPast
              : past === "any" && !split
                ? counts.overdue
                : rows.length
        : split
          ? minDays === 0
              ? counts.split[split]
              : rows.length
          : minDays === 0
            ? counts.total
            : rows.length;
    const wd = (n: number) => `${n} working day${n === 1 ? "" : "s"}`;

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
                    {READY_NO_OWNER_TITLE}: leads that became sales-ready and have no owner.{" "}
                    {canAssign ? "Tick leads and assign them from here. " : ""}
                    The wait is counted from the Sales-ready event (or from when a reactivated lead came back to the
                    pool). Leads with a dead or non-responsive number are not listed.
                </p>
                {(state || personPicked) && (
                    <p className="mt-1 text-xs text-ink-muted">
                        {state ? (
                            <>
                                State: <b>{state}</b> (from the Sales dashboard) ·{" "}
                                <Link href="/admin/ready-to-assign" className="font-medium text-brand-600 hover:underline">
                                    All states
                                </Link>
                            </>
                        ) : null}
                        {personPicked ? `${state ? " · " : ""}These leads have no owner yet, so the Person filter does not narrow them.` : ""}
                    </p>
                )}
            </header>

            <div className="flex flex-wrap items-center gap-2">
                {tab(withFilters("/admin/ready-to-assign"), "All awaiting", counts.total, plain && !split)}
                {READY_SPLITS.map((k) =>
                    tab(withFilters(`/admin/ready-to-assign?split=${k}`), READY_SPLIT_LABEL[k], counts.split[k], split === k && plain),
                )}
                {tab(
                    withFilters("/admin/ready-to-assign?past=hot"),
                    `Hot past ${counts.hotLimitHours} working hours`,
                    counts.hotPast,
                    past === "hot" && !split,
                )}
                {tab(
                    withFilters("/admin/ready-to-assign?past=other"),
                    `Others past ${wd(overdueDays)}`,
                    counts.otherPast,
                    past === "other" && !split,
                )}
                {counts.oldestDays != null && (
                    <span className="text-xs text-gray-500">Longest wait: {wd(counts.oldestDays)}</span>
                )}
                <Link
                    href={withFilters(`/leads?ready_no_owner=1${split ? `&ready_split=${split}` : ""}`)}
                    className="text-xs font-medium text-brand-600 hover:underline"
                >
                    Same list in Leads (download)
                </Link>
            </div>

            {rows.length === 0 ? (
                <p className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500">
                    {past && counts.total > 0
                        ? `No lead here is past its limit. ${counts.total.toLocaleString("en-IN")} are waiting in all.`
                        : minDays > 0 && counts.total > 0
                          ? `No lead has been waiting ${wd(minDays)} or more. ${counts.total.toLocaleString("en-IN")} are waiting in all.`
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
                        overdueDays={overdueDays}
                        rows={rows.map((r) => ({
                            id: r.id,
                            dealer_name: r.dealer_name,
                            location: [r.city, r.state].filter(Boolean).join(", ") || "—",
                            status: r.lead_status ? (LEAD_STATUS_LABEL[r.lead_status as LeadStatus] ?? r.lead_status) : "—",
                            interest_level: r.interest_level,
                            reason: salesReadyReasonLabel(r.sales_ready_reason),
                            days_waiting: r.days_waiting,
                            past_limit: Boolean(r.past_limit),
                        }))}
                    />
                </>
            )}
        </div>
    );
}
