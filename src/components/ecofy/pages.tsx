// Server-side page bodies shared by the Sales Head, ASM and ISR Ecofy routes
// (E-307). Each route file only picks the roles, the URL prefix and the view.

import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuth, requireRole } from "@/lib/auth-utils";
import { ecofyViewerKind } from "@/lib/ecofy/access";
import {
    EcofyNotFoundError,
    ecofyCounts,
    getEcofyLeadForViewer,
    listEcofyLeads,
    safeEcofyUrl,
    type EcofyListFilter,
} from "@/lib/ecofy/queries";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { EcofyLeadDetail } from "./EcofyLeadDetail";
import { EcofyLeadTable } from "./EcofyLeadTable";
import { toTableRow } from "./rows";

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

export async function EcofyListPage(p: {
    roles: string[];
    title: string;
    subtitle: string;
    hrefBase: string;
    view: "open" | "queue" | "all";
    searchParams: SP;
    emptyText: string;
    tabs?: Array<{ label: string; href: string; active: boolean }>;
}) {
    const user = await requireRole(p.roles);
    const kind = ecofyViewerKind(user.role);
    const sp = await p.searchParams;
    const filter: EcofyListFilter = {
        view: p.view,
        stage: one(sp.stage),
        temperature: one(sp.temperature),
        assignee: kind === "manager" ? one(sp.assignee) : null,
        ownerId: kind === "worker" ? user.id : null,
        q: one(sp.q),
    };
    const [rows, counts] = await Promise.all([listEcofyLeads(filter), ecofyCounts(user)]);

    return (
        <div className="mx-auto max-w-[1600px] space-y-5 px-4 py-6 sm:px-6 md:px-8">
            <header className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight text-gray-900">{p.title}</h1>
                    <p className="mt-1 text-sm text-gray-600">{p.subtitle}</p>
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                    <Stat label="Open" value={counts.open} />
                    {kind === "manager" && <Stat label="In pickup queue" value={counts.queue} tone={counts.queueHot ? "red" : undefined} sub={counts.queueHot ? `${counts.queueHot} hot` : undefined} />}
                    <Stat label="Follow-ups due" value={counts.followUpsDue} tone={counts.followUpsDue ? "amber" : undefined} />
                    <Stat label="Meetings today" value={counts.meetingsToday} />
                </div>
            </header>
            {p.tabs && (
                <nav className="flex w-fit rounded-lg border border-gray-200 bg-white p-0.5 text-sm">
                    {p.tabs.map((t) => (
                        <Link key={t.href} href={t.href} className={`rounded-md px-3 py-1.5 ${t.active ? "bg-gray-900 text-white" : "text-gray-600 hover:text-gray-900"}`}>
                            {t.label}
                        </Link>
                    ))}
                </nav>
            )}
            <Suspense>
                <EcofyLeadTable
                    rows={rows.map(toTableRow)}
                    hrefBase={p.hrefBase}
                    selectable={kind === "manager"}
                    showAssignee={kind === "manager"}
                    emptyText={p.emptyText}
                />
            </Suspense>
        </div>
    );
}

function Stat({ label, value, sub, tone }: { label: string; value: number; sub?: string; tone?: "red" | "amber" }) {
    const cls = tone === "red" ? "border-red-200 bg-red-50 text-red-800" : tone === "amber" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-gray-200 bg-white text-gray-900";
    return (
        <div className={`rounded-lg border px-3 py-2 ${cls}`}>
            <div className="text-[11px] uppercase tracking-wide opacity-70">{label}</div>
            <div className="text-lg font-semibold leading-tight">
                {value}
                {sub ? <span className="ml-1 text-xs font-normal">({sub})</span> : null}
            </div>
        </div>
    );
}

export async function EcofyDetailPage(p: { roles: string[]; id: string; backHref: string }) {
    const user = await requireRole(p.roles);
    let lead;
    try {
        lead = await getEcofyLeadForViewer(p.id, user);
    } catch (err) {
        if (err instanceof EcofyNotFoundError) notFound();
        throw err;
    }
    const [assignee] = lead.assigned_to_user_id
        ? await db.select({ name: users.name }).from(users).where(eq(users.id, lead.assigned_to_user_id)).limit(1)
        : [];

    return (
        <EcofyLeadDetail
            leadId={lead.id}
            viewer={{ id: user.id, role: user.role }}
            backHref={p.backHref}
            ecofyUrl={safeEcofyUrl(lead.ecofy_url)}
            local={{
                caseNo: lead.case_no,
                customerName: lead.customer_name,
                stage: lead.stage,
                temperature: lead.temperature,
                assignedTo: lead.assigned_to_user_id,
                assigneeName: assignee?.name ?? null,
                assignedAt: lead.assigned_at?.toISOString() ?? null,
                nextFollowUpAt: lead.next_follow_up_at?.toISOString() ?? null,
                nextAppointmentAt: lead.next_appointment_at?.toISOString() ?? null,
                snapshot: [
                    ["Mobile", [lead.customer_mobile, lead.customer_alt_mobile].filter(Boolean).join(" / ") || null],
                    ["Email", lead.customer_email],
                    ["Type", [lead.customer_type, lead.business_name].filter(Boolean).join(" · ") || null],
                    ["Address", [lead.address, lead.city, lead.state, lead.pincode].filter(Boolean).join(", ") || null],
                    ["Language", lead.preferred_language],
                    ["Property", lead.property_type],
                    ["Segment", lead.segment],
                    ["Product interest", lead.product_interest],
                    ["Avg monthly bill", lead.avg_monthly_bill_inr ? `₹${Number(lead.avg_monthly_bill_inr).toLocaleString("en-IN")}` : null],
                    ["Sanctioned load", lead.sanctioned_load_kw ? `${lead.sanctioned_load_kw} kW` : null],
                    ["Existing backup", lead.existing_backup],
                    ["Call time", lead.preferred_call_time],
                    ["Qualified by", lead.qualified_by_name],
                ],
            }}
        />
    );
}

/** Small card for the ASM / ISR home dashboards. */
export async function EcofyMyLeadsCard({ href }: { href: string }) {
    const user = await requireAuth();
    if (ecofyViewerKind(user.role) !== "worker") return null;
    let counts;
    try {
        counts = await ecofyCounts(user);
    } catch {
        return null; // DB without E-307 — the card simply does not show.
    }
    if (!counts.open) return null;
    return (
        <Link
            href={href}
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900 hover:bg-sky-100"
        >
            <span>
                <b>{counts.open}</b> Ecofy lead{counts.open === 1 ? "" : "s"} assigned to you
                {counts.followUpsDue ? <> · <b className="text-red-700">{counts.followUpsDue}</b> follow-up{counts.followUpsDue === 1 ? "" : "s"} due</> : null}
                {counts.meetingsToday ? <> · {counts.meetingsToday} meeting{counts.meetingsToday === 1 ? "" : "s"} today</> : null}
            </span>
            <span className="font-medium">Open Ecofy leads →</span>
        </Link>
    );
}
