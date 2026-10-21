/**
 * READ-ONLY: do the WhatsApp Assistant's read tools say what the CRM screens say?
 *
 *   node --import tsx --env-file=.env.local scripts/verify-assistant-parity.ts [name-or-email]
 *
 * For every active ASM and ISR (or the one matching the argument) this calls
 * the REAL code paths side by side — nothing restated:
 *
 *   1. my_queue total per OWN tab (queueRowsForTool) == the screen's tab badge
 *      (fetchAllTabCounts / fetchAllAsmTabCounts with the viewer's team, as
 *      /api/{inside-sales,asm}/queue/counts call them) — ID 155 managers incl.
 *   2. Hot / Warm / Cold: my_leads_by_temperature total == the performance
 *      page's card (buildSalesDashboard with my_numbers' own inputs), and its
 *      row count == min(total, 10).
 *   3. Every row my_queue's first page, every temperature report and the
 *      quote_status list hand the model opens with findLeadInScope (a list
 *      row that then reads "not found" is the bug this guards).
 *   4. status_label == LEAD_STATUS_LABEL[status] on every row.
 *   5. my_numbers' activity == buildSalesDashboard's totals.
 *   6. search_lead by the first queue row's phone (as "+91 …") finds that lead.
 *
 * Read-only by construction: the connection runs with
 * default_transaction_read_only=on. Any mismatch exits 1.
 */
export {};

const base = process.env.DATABASE_URL ?? "";
process.env.DATABASE_URL = base + (base.includes("?") ? "&" : "?") + "default_transaction_read_only=on";

async function main() {
    const { sql } = await import("drizzle-orm");
    const { db } = await import("@/lib/db");
    const { buildSalesDashboard } = await import("@/lib/admin/salesDashboard");
    const { fetchAllTabCounts } = await import("@/lib/inside-sales/queryBuilder");
    const { fetchAllAsmTabCounts } = await import("@/lib/asm/queryBuilder");
    const { readQueueFilters, LEAD_STATUS_LABEL } = await import("@/lib/leads/queueFilters");
    const { readAsmQueueFilters } = await import("@/lib/asm/queueFilterParams");
    const { teamForOwnScopedViewer } = await import("@/lib/users/team");
    const { numbersInputs, shapeNumbers } = await import("@/lib/assistant/tools/read/myNumbers");
    const { temperatureRowsForTool, TEMPERATURES } = await import("@/lib/assistant/tools/read/myLeadsByTemperature");
    const { queueRowsForTool } = await import("@/lib/assistant/tools/read/myQueue");
    const { searchLead } = await import("@/lib/assistant/tools/read/searchLead");
    const { quoteStatus } = await import("@/lib/assistant/tools/read/quoteStatus");
    const { toLeadSummary } = await import("@/lib/assistant/tools/leads");
    const { findLeadInScope, ASM_OWN_TABS, ISR_OWN_TABS } = await import("@/lib/assistant/scope");
    const { istNow } = await import("@/lib/assistant/prompt");
    const { MAX_TOOL_ROWS } = await import("@/lib/assistant/types");
    type AssistantUser = import("@/lib/assistant/types").AssistantUser;
    type LeadSummary = import("@/lib/assistant/types").LeadSummary;
    type ToolContext = import("@/lib/assistant/types").ToolContext;

    const who = process.argv[2]?.trim() ?? "";
    const users = (await db.execute(sql`
        SELECT id::text AS id, name, role
          FROM users
         WHERE role IN ('asm', 'inside_sales_rep') AND is_active
           ${who ? sql`AND (name ILIKE ${"%" + who + "%"} OR email ILIKE ${"%" + who + "%"})` : sql``}
         ORDER BY role, name
    `)) as unknown as AssistantUser[];
    if (users.length === 0) throw new Error(`no active ASM / ISR matches "${who}"`);

    const now = new Date();
    const today = istNow(now).isoDate;
    let bad = 0;
    const fail = (u: AssistantUser, msg: string) => {
        bad++;
        console.log(`   ✗ ${u.name}: ${msg}`);
    };
    const labelOk = (r: LeadSummary) =>
        r.status == null
            ? r.status_label == null
            : r.status_label === ((LEAD_STATUS_LABEL as Record<string, string>)[r.status] ?? r.status.replace(/_/g, " "));
    let rowsChecked = 0;

    for (const u of users) {
        const ctx: ToolContext = { user: u, messageId: null, now, writesEnabled: false };
        const team = await teamForOwnScopedViewer(u);
        const cells: string[] = [];

        // 1. my_queue total per own tab == the screen's badge (with the team).
        const tabs: readonly string[] = u.role === "asm" ? ASM_OWN_TABS : ISR_OWN_TABS;
        const badges: Record<string, number> =
            u.role === "asm"
                ? await fetchAllAsmTabCounts(u.id, { ...readAsmQueueFilters(new URLSearchParams()), teamMemberIds: team })
                : await fetchAllTabCounts(u.id, { filters: readQueueFilters(new URLSearchParams()), teamMemberIds: team });
        const readable: LeadSummary[] = [];
        let firstPhone: { id: string; phone: string } | null = null;
        for (const tab of tabs) {
            const { rows, total } = await queueRowsForTool(u, tab);
            if (total !== badges[tab]) fail(u, `my_queue ${tab} total ${total} ≠ screen badge ${badges[tab]}`);
            if (rows.length !== Math.min(total, MAX_TOOL_ROWS)) fail(u, `my_queue ${tab} returned ${rows.length} rows of ${total}`);
            const summaries = rows.map((r) => toLeadSummary(r, u));
            readable.push(...summaries);
            const own = summaries.find((s) => s.owned_by_you && (s.phone ?? "").replace(/\D/g, "").length === 10);
            if (!firstPhone && own) firstPhone = { id: own.id, phone: own.phone! };
            cells.push(`${tab} ${total}`);
        }

        // 2. Hot / Warm / Cold == the performance page's cards.
        const { dashboardInput, from, to } = numbersInputs(u, "this_month", now);
        const dash = await buildSalesDashboard(dashboardInput);
        const card = (l: string) => dash.interest.rows.find((r) => r.interest_level === l)?.total ?? 0;
        for (const level of TEMPERATURES) {
            const { rows, total } = await temperatureRowsForTool(u, level, today);
            if (total !== card(level)) fail(u, `${level}: card ${card(level)} ≠ tool ${total}`);
            if (rows.length !== Math.min(total, MAX_TOOL_ROWS)) fail(u, `${level}: ${rows.length} rows of ${total}`);
            readable.push(
                ...rows.map((r) =>
                    toLeadSummary(u.role === "asm" ? { ...r, scheduled_date: r.next_date } : { ...r, next_follow_up_at: r.next_date }, u),
                ),
            );
            cells.push(`${level} ${total}`);
        }

        // quote_status's own list (no lead).
        const quotes = await quoteStatus(u.role).run(ctx, {});
        if (quotes.kind === "leads") readable.push(...quotes.rows.map((r) => ({ ...r, status: null, status_label: null })));

        // 3 + 4. Every row opens, and reads with the screens' label.
        for (const r of readable) {
            rowsChecked++;
            if (!labelOk(r)) fail(u, `${r.id}: status_label "${r.status_label}" ≠ LEAD_STATUS_LABEL[${r.status}]`);
            if (!(await findLeadInScope(u, r.id))) fail(u, `${r.id} is listed but findLeadInScope says not found`);
        }

        // 5. my_numbers == buildSalesDashboard.
        const shaped = shapeNumbers(u, "this_month", { from, to }, dash, []);
        const act = shaped.activity as Record<string, number>;
        for (const k of ["visits", "unique_visits", "new_visits", "calls", "converted"] as const) {
            if (act[k] !== dash.totals[k]) fail(u, `my_numbers ${k} ${act[k]} ≠ dashboard ${dash.totals[k]}`);
        }
        // ID 185: Fresh = the dashboard's, and Fresh + Repeat = Visits.
        if (act.fresh_visits !== Math.min(dash.totals.fresh_visits ?? 0, dash.totals.visits)) fail(u, `my_numbers fresh_visits ${act.fresh_visits} ≠ dashboard ${dash.totals.fresh_visits}`);
        if (act.fresh_visits + act.repeat_visits !== act.visits) fail(u, `my_numbers fresh + repeat ≠ visits`);

        // 6. search_lead by phone, typed with a country code.
        if (firstPhone) {
            const typed = `+91 ${firstPhone.phone.replace(/\D/g, "").slice(0, 5)} ${firstPhone.phone.replace(/\D/g, "").slice(5)}`;
            const r = await searchLead(u.role).run(ctx, { query: typed });
            const ids = r.kind === "leads" || r.kind === "candidates" ? r.rows.map((x) => x.id) : [];
            if (!ids.includes(firstPhone.id)) fail(u, `search_lead "${typed}" did not find ${firstPhone.id}`);
            cells.push(`search ✓`);
        }

        console.log(`${u.role.padEnd(16)} ${u.name.padEnd(24)} team ${team.length} · ${cells.join(" · ")}`);
    }
    console.log(
        bad === 0
            ? `\nOK — ${users.length} users, ${rowsChecked} rows: queue = badges, cards = tool, every row readable, labels = screens.`
            : `\n${bad} mismatch(es).`,
    );
    process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
