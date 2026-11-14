// ID 233 — sandbox check: a lead closed Lost with reason "Test lead" leaves the counts and
// stays in the download, marked. Creates its own TEST lead; refuses live (database-2).
//
//   node --import tsx --env-file=.env.local scripts/verify-test-lead-233.ts
//
// Counts read with the app's own code: the CEO overview (buildControlTower: Leads in), the
// Lost analysis (runReport lost_analysis: Lost by reason) and the Leads download
// (countLeadsForExport / fetchLeadsForExport). Each is read before and after the close.

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { countLeadsForExport, fetchLeadsForExport } from "@/lib/admin/leadsExport";
import { runReport } from "@/lib/admin/reports";
import { buildControlTower } from "@/lib/dashboard/ceoControlTower";
import { markLeadLost, TestLeadRoleError } from "@/lib/leads/markLost";
import { datasetById } from "@/lib/exports/datasets/registry";

function check(ok: boolean, what: string) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
    if (!ok) process.exitCode = 1;
}

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(Date.now() + 86_400_000));

async function counts(phone: string) {
    // The CEO page's window is [start, end): today only = today → tomorrow.
    const tower = await buildControlTower({ startStr: today, endStr: tomorrow });
    const lost = await runReport("lost_analysis", { date_from: today, date_to: today });
    const lostRows = (lost as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [];
    const exportCount = await countLeadsForExport({ search: phone } as never);
    return {
        leadsIn: Number((tower as unknown as { engine?: { leads_in?: { now?: number } } }).engine?.leads_in?.now ?? NaN),
        lostTestRows: lostRows.filter((r) => r.reason === "test_lead").length,
        lostTotal: lostRows.filter((r) => r.category === "Sales lost").reduce((s, r) => s + Number(r.count ?? 0), 0),
        exportCount,
    };
}

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[:/].*$/, "");
    if (host.startsWith("database-2")) throw new Error("refusing to run against live (database-2)");
    console.log(`DB host: ${host}  day ${today}\n`);

    const id = `TEST-233-${Date.now().toString(36)}`;
    const phone = `9${String(Date.now()).slice(-9)}`;
    const admin = ((await db.execute(sql`SELECT id::text AS id FROM users WHERE role = 'admin' AND is_active LIMIT 1`)) as unknown as Array<{ id: string }>)[0];
    const isr = ((await db.execute(sql`SELECT id::text AS id FROM users WHERE role = 'inside_sales_rep' AND is_active LIMIT 1`)) as unknown as Array<{ id: string }>)[0];
    if (!admin || !isr) throw new Error("need an active admin and ISR on the sandbox");
    await db.execute(sql`
        INSERT INTO dealer_leads (id, dealer_name, shop_name, phone, lead_status, current_owner_id, created_at, updated_at)
        VALUES (${id}, 'TEST 233 lead', 'TEST 233 lead', ${phone}, 'Assigned_Not_Contacted', ${isr.id}, NOW(), NOW())
    `);
    console.log(`Created ${id} today.`);

    const before = await counts(phone);
    console.log(`before: Leads in ${before.leadsIn}, Lost total ${before.lostTotal}, in the download ${before.exportCount}`);

    let refused = false;
    try {
        await markLeadLost({ leadId: id, actor: { id: isr.id, role: "inside_sales_rep" }, reason: "test_lead", notes: "x" });
    } catch (e) {
        refused = e instanceof TestLeadRoleError;
    }
    check(refused, "an ISR cannot close a lead as a test lead");

    await markLeadLost({ leadId: id, actor: { id: admin.id, role: "admin" }, reason: "test_lead", notes: "TEST 233" });
    const after = await counts(phone);
    console.log(`after:  Leads in ${after.leadsIn}, Lost total ${after.lostTotal}, in the download ${after.exportCount}`);

    check(after.leadsIn === before.leadsIn - 1, `CEO overview Leads in drops by one (${before.leadsIn} → ${after.leadsIn})`);
    check(after.lostTotal === before.lostTotal && after.lostTestRows === 0, "Lost analysis: not counted, no 'Test lead' row");
    check(before.exportCount === 1 && after.exportCount === 1, `the Leads download still lists it (${before.exportCount} → ${after.exportCount})`);
    const raw = (await fetchLeadsForExport({ search: phone } as never, 10)) as unknown as Array<Record<string, unknown>>;
    check(raw.length === 1, "the export query returns the row");
    // The Data downloads › Leads file, built by the same code the download route runs.
    const dataset = datasetById("leads")!;
    const sheets = await dataset.build({
        params: new URLSearchParams({ search: phone }),
        user: { id: admin.id, role: "admin", email: "verify@itarang.invalid", name: "verify" } as never,
        ownOnly: false,
        maxRows: 10,
    });
    const row = (sheets[0]?.rows ?? [])[0] as Record<string, unknown> | undefined;
    console.log(`  download row: status "${String(row?.lead_status ?? "")}", lost reason "${String(row?.lost_reason ?? "")}"`);
    check(row?.lead_status === "Lost (test lead)" && row?.lost_reason === "Test lead", "the download marks it as a test lead");
    const list = (await db.execute(sql`SELECT is_active FROM dealer_leads WHERE id = ${id}`)) as unknown as Array<{ is_active: boolean }>;
    check(list[0]?.is_active === false, "the lead is out of the working lists (is_active false)");
}

main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((e) => {
        console.error(e instanceof Error ? e.stack : e);
        process.exit(1);
    });
