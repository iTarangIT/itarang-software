import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// "Leads Info" merged into the Leads tab at /leads.
//
// The two pages were separate views over the same `dealer_leads` table — the
// same lead appeared on both, with different status vocabularies (this page read
// `lead_status`, /leads read `current_status`) and different row sets (this page
// `is_active IS NOT FALSE`, /leads `phone IS NOT NULL`). Acting on a lead meant
// choosing which half of the truth to look at. There is now one list.
//
// The route is KEPT as a redirect rather than deleted: it is linked from
// bookmarks, tests/e2e/coverage/route-manifest.ts and scripts/perf-audit/
// pages.json, all of which would 404 otherwise.
//
// Filter params are passed straight through — the merged filter bar reads the
// same names this page used (status, owner_id, asm_id, source, state, city,
// search), so a bookmarked "/admin/leads-info?status=Lost&owner_id=…" lands on
// exactly the view it always did.
//
// No requireRole here any more. It used to be ["admin","sales_head"], which
// threw an uncaught ForbiddenError for the CEO — middleware lets ceo through to
// /admin/* but the page then refused them. Redirecting instead means /leads
// applies its own gate (LEADS_PAGE_ROLES), and the CEO path works.
export default async function LeadsInfoPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const sp = new URLSearchParams();
    sp.set("tab", "leads");
    for (const [key, value] of Object.entries(await searchParams)) {
        if (key === "tab") continue;
        if (typeof value === "string" && value) sp.set(key, value);
    }
    redirect(`/leads?${sp.toString()}`);
}
