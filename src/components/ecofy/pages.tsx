// Server-side page bodies shared by the Sales Head, ASM and ISR Ecofy routes
// (E-307). Each route file only picks the roles, the URL prefix and the view.

import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuth, requireRole } from "@/lib/auth-utils";
import { ecofyViewerKind } from "@/lib/ecofy/access";
import type { EcofyListTab } from "@/lib/ecofy/listTypes";
import { EcofyNotFoundError, ecofyCounts, getEcofyLeadForViewer, safeEcofyUrl } from "@/lib/ecofy/queries";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { EcofyLeadDetail } from "./EcofyLeadDetail";
import { EcofyLeadsWorkspace } from "./EcofyLeadsWorkspace";

/**
 * The Ecofy leads list page: header + the My-Visits-style workspace (tabs,
 * search, filters, CSV, table). The rows come from /api/ecofy/leads on the
 * client, so this server component only gates the role and threads the
 * viewer down for the "You" indicator and the manager-only controls.
 */
export async function EcofyListPage(p: { roles: string[]; title: string; subtitle: string; hrefBase: string; initialTab: EcofyListTab }) {
    const user = await requireRole(p.roles);
    const kind = ecofyViewerKind(user.role);
    if (!kind) notFound();

    return (
        <div className="mx-auto max-w-[1600px] space-y-5 px-4 py-6 sm:px-6 md:px-8">
            <header className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight text-gray-900">{p.title}</h1>
                    <p className="mt-1 text-sm text-gray-600">{p.subtitle}</p>
                </div>
            </header>
            <Suspense>
                <EcofyLeadsWorkspace kind={kind} hrefBase={p.hrefBase} initialTab={p.initialTab} viewerId={user.id} />
            </Suspense>
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
