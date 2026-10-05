/**
 * Verifier for tracker ID 117 — a conversion is credited to the lead's closing
 * owner, once, and never moves with a reassignment — in the two reports the
 * 30 Sep review found still wrong (Funnel by Owner, ASM Handoff), in the
 * leads.xlsx download, and in the evidence the closing-owner backfill reads.
 * 01 Oct 2026.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-id117-closing-owner.ts
 *
 * Runs the REAL report builders (src/lib/admin/reports.ts). The checks need a
 * converted lead that is then reassigned, so they seed one inside ONE
 * transaction that is ALWAYS rolled back; for its length every `db.*` call in
 * the process is routed into that transaction, so the unmodified builders read
 * the seeded rows. Nothing is left behind. Sandbox only (database-1).
 * Exit code 1 if anything FAILs.
 */
import { sql } from "drizzle-orm";

import { db } from "../src/lib/db";
import { funnelByOwnerLeads, runReport } from "../src/lib/admin/reports";
import { fetchLeadsForExport } from "../src/lib/admin/leadsExport";
import { closedLeadVerdicts } from "../src/lib/leads/closingOwnerFacts";
import { buildSalesDashboard } from "../src/lib/admin/salesDashboard";
import { writeTouchpoint } from "../src/lib/touchpoints/write";

const host = new URL(process.env.DATABASE_URL ?? "postgres://none").hostname;
if (!host.startsWith("database-1.")) {
    console.error(`Refusing to run against ${host.split(".")[0]} — sandbox (database-1) only.`);
    process.exit(1);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const results: Array<{ id: string; outcome: "PASS" | "FAIL"; note: string }> = [];
class Rollback extends Error {}
let tx!: Tx;

function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new Error(msg);
}
const eq = (got: unknown, want: unknown, what: string) =>
    assert(got === want, `${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

async function check(id: string, fn: () => Promise<string>) {
    try {
        let note = "";
        await tx.transaction(async () => {
            note = await fn();
        });
        results.push({ id, outcome: "PASS", note });
    } catch (e) {
        results.push({ id, outcome: "FAIL", note: e instanceof Error ? e.message : String(e) });
    }
}

const F = {}; // the reports' default window: the last 30 days

/** person_id → Converted, from the real Funnel by Owner report. */
async function funnelConverted(): Promise<Map<string, number>> {
    const r = await runReport("funnel_by_owner", F);
    return new Map(r.rows.map((row) => [String(row.person_id), Number(row.converted ?? 0)]));
}
/** ASM name → { handoffs, converted }, from the real ASM Handoff report. */
async function handoff(): Promise<Map<string, { handoffs: number; converted: number }>> {
    const r = await runReport("asm_handoff", F);
    const out = new Map<string, { handoffs: number; converted: number }>();
    for (const row of r.rows) {
        const k = String(row.asm_name);
        const cur = out.get(k) ?? { handoffs: 0, converted: 0 };
        out.set(k, { handoffs: cur.handoffs + Number(row.handoffs ?? 0), converted: cur.converted + Number(row.converted ?? 0) });
    }
    return out;
}

async function seedLead(p: {
    owner: string;
    asm: string;
    closingOwner: string;
    handedTo: string;
    touchedBy: string;
}): Promise<string> {
    const id = `DL-V117-${Math.random().toString(36).slice(2, 10)}`;
    const phone = `+9199${Math.floor(10000000 + Math.random() * 89999999)}`;
    await tx.execute(sql`
        INSERT INTO dealer_leads (id, phone, dealer_name, current_status, source, lead_status, current_owner_id, asm_id,
                                  closing_owner_id, closed_at, total_attempts, is_active, created_at, updated_at)
        VALUES (${id}, ${phone}, 'V117 Dealer', 'new', 'manual_upload_lead', 'Converted', ${p.owner}, ${p.asm},
                ${p.closingOwner}, NOW() - INTERVAL '1 day', 0, TRUE, NOW() - INTERVAL '10 days', NOW())`);
    // The hand-off to the ASM, with its recipient recorded (E-295)…
    await tx.execute(sql`
        INSERT INTO lead_touchpoints (dealer_lead_id, touchpoint_type, performed_by, performed_at, remarks, sync_method, to_owner_id)
        VALUES (${id}, 'asm_transfer', ${p.touchedBy}, NOW() - INTERVAL '5 days', 'verify-id117', 'manual', ${p.handedTo})`);
    // …and someone else logging a call on it inside the report window.
    await tx.execute(sql`
        INSERT INTO lead_touchpoints (dealer_lead_id, touchpoint_type, performed_by, performed_at, call_status, remarks, sync_method)
        VALUES (${id}, 'inside_sales_call', ${p.touchedBy}, NOW() - INTERVAL '2 hours', 'connected', 'verify-id117', 'manual')`);
    return id;
}

async function run() {
    const people = (await tx.execute(sql`
        SELECT id::text AS id, name, lower(role) AS role FROM users
         WHERE is_active = TRUE AND name IS NOT NULL AND lower(role) IN ('asm', 'inside_sales_rep')
         ORDER BY created_at`)) as unknown as Array<{ id: string; name: string; role: string }>;
    const asms = people.filter((u) => u.role === "asm");
    const rep = people.find((u) => u.role === "inside_sales_rep");
    // Two ASMs with different names (the handoff report is read by name).
    const asmA = asms[0];
    const asmB = asms.find((u) => u.name !== asmA?.name);
    assert(asmA && asmB && rep, "need two active ASMs with different names and an inside_sales_rep on this database");

    const funnel0 = await funnelConverted();
    const handoff0 = await handoff();
    const fc = (m: Map<string, number>, id: string) => m.get(id) ?? 0;
    const hc = (m: Map<string, { handoffs: number; converted: number }>, name: string) => m.get(name) ?? { handoffs: 0, converted: 0 };

    // ASM A is handed the lead and closes it; the rep logs a call on it in the window.
    const lead = await seedLead({ owner: asmA.id, asm: asmA.id, closingOwner: asmA.id, handedTo: asmA.id, touchedBy: rep.id });

    await check("funnel.credit_to_closing_owner", async () => {
        const f = await funnelConverted();
        eq(fc(f, asmA.id) - fc(funnel0, asmA.id), 1, "the closing owner's Converted");
        eq(fc(f, rep.id) - fc(funnel0, rep.id), 0, "Converted for the rep who only logged a call on it");
        return "the closing owner gets the conversion; the rep who touched the lead does not";
    });

    await check("funnel.each_conversion_once", async () => {
        const f = await funnelConverted();
        const reported = [...f.values()].reduce((a, b) => a + b, 0);
        const [truth] = (await tx.execute(sql`
            SELECT count(*)::int AS n FROM dealer_leads
             WHERE lead_status = 'Converted' AND closing_owner_id IS NOT NULL
               AND closed_at >= NOW() - INTERVAL '30 days'`)) as unknown as Array<{ n: number }>;
        eq(reported, truth.n, "sum of the Converted column vs leads converted in the window");
        return `${reported} conversion(s) in the window, each credited once`;
    });

    await check("funnel.drilldown_matches", async () => {
        const closer = await funnelByOwnerLeads(asmA.id, "converted", F);
        const toucher = await funnelByOwnerLeads(rep.id, "converted", F);
        const f = await funnelConverted();
        assert(closer.some((l) => l.id === lead), "the lead is in the closing owner's Converted list");
        assert(!toucher.some((l) => l.id === lead), "the lead is not in the toucher's Converted list");
        eq(closer.length, fc(f, asmA.id), "closing owner's list length vs their Converted number");
        eq(toucher.length, fc(f, rep.id), "toucher's list length vs their Converted number");
        return "each Converted number opens exactly the leads behind it";
    });

    await check("handoff.credit_to_recipient", async () => {
        const h = await handoff();
        eq(hc(h, asmA.name).handoffs - hc(handoff0, asmA.name).handoffs, 1, "Handoffs Received for the ASM it was handed to");
        eq(hc(h, asmA.name).converted - hc(handoff0, asmA.name).converted, 1, "Converted for that ASM");
        return "the receiving ASM gets the handoff and the conversion";
    });

    await check("reassign.credit_does_not_move", async () => {
        // The converted lead is reassigned: new owner AND new ASM.
        await tx.execute(sql`UPDATE dealer_leads SET current_owner_id = ${asmB.id}, asm_id = ${asmB.id} WHERE id = ${lead}`);
        const f = await funnelConverted();
        eq(fc(f, asmA.id) - fc(funnel0, asmA.id), 1, "Funnel: the closing owner's Converted after the reassignment");
        eq(fc(f, asmB.id) - fc(funnel0, asmB.id), 0, "Funnel: the new owner's Converted");
        const h = await handoff();
        eq(hc(h, asmA.name).handoffs - hc(handoff0, asmA.name).handoffs, 1, "Handoff: the original ASM's handoffs");
        eq(hc(h, asmA.name).converted - hc(handoff0, asmA.name).converted, 1, "Handoff: the original ASM's Converted");
        eq(hc(h, asmB.name).handoffs - hc(handoff0, asmB.name).handoffs, 0, "Handoff: the new ASM's handoffs");
        eq(hc(h, asmB.name).converted - hc(handoff0, asmB.name).converted, 0, "Handoff: the new ASM's Converted");
        return "reassigning the converted lead moved nothing in either report";
    });

    await check("handoff.closed_by_someone_else", async () => {
        const before = await handoff();
        // Handed to ASM B, but the rep is the closing owner.
        await seedLead({ owner: rep.id, asm: asmB.id, closingOwner: rep.id, handedTo: asmB.id, touchedBy: rep.id });
        const h = await handoff();
        eq(hc(h, asmB.name).handoffs - hc(before, asmB.name).handoffs, 1, "handoffs for the ASM it was handed to");
        eq(hc(h, asmB.name).converted - hc(before, asmB.name).converted, 0, "Converted for an ASM who did not close it");
        return "a handoff someone else closed is a handoff, not a conversion, for that ASM";
    });

    // ── transfers logged before the recipient was recorded ──────────────────
    await check("handoff.old_transfer_read_from_visit", async () => {
        const before = await handoff();
        // An old-style transfer: no to_owner_id on the touchpoint, but the
        // ASM's visit row written with it. The lead is closed by that ASM, then
        // moved to another ASM.
        const id = `DL-V117-${Math.random().toString(36).slice(2, 10)}`;
        await tx.execute(sql`
            INSERT INTO dealer_leads (id, phone, dealer_name, current_status, source, lead_status, current_owner_id, asm_id,
                                      closing_owner_id, closed_at, total_attempts, is_active, created_at, updated_at)
            VALUES (${id}, ${`+9198${Math.floor(10000000 + Math.random() * 89999999)}`}, 'V117 Old Transfer', 'new',
                    'manual_upload_lead', 'Converted', ${asmB.id}, ${asmB.id}, ${asmA.id}, NOW() - INTERVAL '1 day',
                    0, TRUE, NOW() - INTERVAL '10 days', NOW())`);
        await tx.execute(sql`
            INSERT INTO lead_touchpoints (dealer_lead_id, touchpoint_type, performed_by, performed_at, remarks, sync_method)
            VALUES (${id}, 'asm_transfer', ${rep.id}, NOW() - INTERVAL '5 days', 'verify-id117', 'manual')`);
        await tx.execute(sql`
            INSERT INTO lead_visits (dealer_lead_id, asm_id, visit_status, created_at, updated_at)
            VALUES (${id}, ${asmA.id}, 'pending_scheduling', NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days')`);
        const h = await handoff();
        eq(hc(h, asmA.name).handoffs - hc(before, asmA.name).handoffs, 1, "handoffs for the ASM named on the visit row");
        eq(hc(h, asmA.name).converted - hc(before, asmA.name).converted, 1, "Converted for that ASM");
        eq(hc(h, asmB.name).handoffs - hc(before, asmB.name).handoffs, 0, "handoffs for the lead's ASM today");
        return "an unrecorded transfer goes to the ASM on its visit row, not the lead's ASM today";
    });

    // ── leads.xlsx ──────────────────────────────────────────────────────────
    await check("download.closed_by_column", async () => {
        // `lead` was closed by ASM A and has since been reassigned to ASM B.
        const rows = await fetchLeadsForExport({ search: "V117 Dealer" } as never, 50);
        const row = rows.find((r) => r.lead_id === lead);
        assert(row, "the lead is in the export");
        eq(row.closed_by_name, asmA.name, "Closed by");
        eq(row.owner_name, asmB.name, "Sales POC (the current owner)");
        return "Closed by keeps the closing owner; Sales POC shows who holds it now";
    });

    // ── the evidence the backfill reads ─────────────────────────────────────
    await check("backfill.unrecorded_asm_transfer", async () => {
        // The lead the first backfill got wrong: claimed by a rep (recorded
        // hop), transferred to an ASM before hops were recorded, converted by
        // the ASM, handed back to the rep afterwards with no "from".
        const id = `DL-V117-${Math.random().toString(36).slice(2, 10)}`;
        await tx.execute(sql`
            INSERT INTO dealer_leads (id, phone, dealer_name, current_status, source, lead_status, current_owner_id, asm_id,
                                      closing_owner_id, closed_at, total_attempts, is_active, created_at, updated_at)
            VALUES (${id}, ${`+9197${Math.floor(10000000 + Math.random() * 89999999)}`}, 'V117 Handed Back', 'new',
                    'manual_upload_lead', 'Converted', ${rep.id}, ${asmA.id}, ${asmA.id}, NOW() - INTERVAL '3 days',
                    0, TRUE, NOW() - INTERVAL '10 days', NOW())`);
        await tx.execute(sql`
            INSERT INTO lead_touchpoints (dealer_lead_id, touchpoint_type, performed_by, performed_at, remarks, sync_method, to_owner_id)
            VALUES (${id}, 'lead_claimed', ${rep.id}, NOW() - INTERVAL '6 days', 'verify-id117', 'manual', ${rep.id})`);
        await tx.execute(sql`
            INSERT INTO lead_touchpoints (dealer_lead_id, touchpoint_type, performed_by, performed_at, remarks, sync_method)
            VALUES (${id}, 'asm_transfer', ${rep.id}, NOW() - INTERVAL '5 days', 'verify-id117', 'manual')`);
        await tx.execute(sql`
            INSERT INTO lead_visits (dealer_lead_id, asm_id, visit_status, created_at, updated_at)
            VALUES (${id}, ${asmA.id}, 'pending_scheduling', NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days')`);
        await tx.execute(sql`
            INSERT INTO lead_touchpoints (dealer_lead_id, touchpoint_type, performed_by, performed_at, remarks, sync_method, to_owner_id)
            VALUES (${id}, 'lead_assigned', ${asmB.id}, NOW() - INTERVAL '2 days', 'verify-id117', 'manual', ${rep.id})`);

        const [v] = await closedLeadVerdicts([id]);
        eq(v.owner_at_close, asmA.id, "owner at the close");
        eq(v.evidence, "hop_before", "evidence");
        eq(v.owner_at_close === v.closing_owner_id, true, "the ASM's conversion is left with the ASM");

        // The same history with NO visit row to read the transfer from: nothing
        // reliable is left, so the lead is left alone rather than given to the rep.
        await tx.execute(sql`DELETE FROM lead_visits WHERE dealer_lead_id = ${id}`);
        const [u] = await closedLeadVerdicts([id]);
        eq(u.owner_at_close, null, "owner at the close with no evidence");
        eq(u.evidence, "unknown", "evidence");
        return "the ASM keeps the conversion (read from the visit row); with no evidence nothing is changed";
    });

    await check("backfill.admin_pressed_the_button", async () => {
        // The bug the backfill exists for: a rep's lead closed by someone else
        // pressing the button, never moved since → the rep is the owner at close.
        const id = `DL-V117-${Math.random().toString(36).slice(2, 10)}`;
        await tx.execute(sql`
            INSERT INTO dealer_leads (id, phone, dealer_name, current_status, source, lead_status, current_owner_id,
                                      closing_owner_id, closed_at, total_attempts, is_active, created_at, updated_at)
            VALUES (${id}, ${`+9196${Math.floor(10000000 + Math.random() * 89999999)}`}, 'V117 Admin Closed', 'new',
                    'manual_upload_lead', 'Lost', ${rep.id}, ${asmB.id}, NOW() - INTERVAL '3 days',
                    0, TRUE, NOW() - INTERVAL '10 days', NOW())`);
        const [v] = await closedLeadVerdicts([id]);
        eq(v.owner_at_close, rep.id, "owner at the close");
        eq(v.evidence, "not_moved_since", "evidence");
        return "a lead closed by someone other than its owner is credited back to the owner";
    });

    // ── the writer, and the dashboard that the targets, the daily mail, the
    //    per-rep CSV and the Assistant all read ──────────────────────────────
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const window = { from: day(new Date(Date.now() - 30 * 86400_000)), to: day(new Date(Date.now() + 86400_000)) };
    const dashConverted = async (spocId: string) =>
        (await buildSalesDashboard({ ...window, granularity: "month", spoc_id: spocId })).totals.converted;
    const closingOwner = async (id: string) =>
        ((await tx.execute(sql`
            SELECT closing_owner_id, lead_status FROM dealer_leads WHERE id = ${id}`)) as unknown as Array<{
            closing_owner_id: string | null;
            lead_status: string;
        }>)[0];
    const seedOpen = async (owner: string) => {
        const id = `DL-V117-${Math.random().toString(36).slice(2, 10)}`;
        await tx.execute(sql`
            INSERT INTO dealer_leads (id, phone, dealer_name, current_status, source, lead_status, current_owner_id,
                                      total_attempts, is_active, created_at, updated_at)
            VALUES (${id}, ${`+9195${Math.floor(10000000 + Math.random() * 89999999)}`}, 'V117 Open', 'new',
                    'manual_upload_lead', 'Commercials_Finalised', ${owner}, 0, TRUE, NOW() - INTERVAL '10 days', NOW())`);
        return id;
    };

    await check("writer.won_then_reassigned_then_converted", async () => {
        const repBefore = await dashConverted(rep.id);
        const newOwnerBefore = await dashConverted(asmA.id);
        const presserBefore = await dashConverted(asmB.id);
        const id = await seedOpen(rep.id);

        // Someone who is NOT the owner presses Mark Won on the rep's lead.
        await writeTouchpoint({
            dealerLeadId: id,
            touchpointType: "status_change_note",
            performedBy: asmB.id,
            remarks: "verify-id117",
            statusChange: { from: "Commercials_Finalised", to: "Won", event: "mark_won" },
        });
        eq((await closingOwner(id)).closing_owner_id, rep.id, "closing owner at Won (the owner, not whoever pressed the button)");

        // The won lead is handed to someone else before onboarding is approved…
        await tx.execute(sql`UPDATE dealer_leads SET current_owner_id = ${asmA.id} WHERE id = ${id}`);
        // …and then the approval converts it.
        await writeTouchpoint({
            dealerLeadId: id,
            touchpointType: "status_change_note",
            performedBy: asmB.id,
            remarks: "verify-id117",
            statusChange: { from: "Won", to: "Converted", event: "onboarding_approved" },
        });
        const after = await closingOwner(id);
        eq(after.lead_status, "Converted", "status");
        eq(after.closing_owner_id, rep.id, "closing owner at Converted (kept from Won)");

        eq((await dashConverted(rep.id)) - repBefore, 1, "Sales dashboard: conversions for the owner who won it");
        eq((await dashConverted(asmA.id)) - newOwnerBefore, 0, "Sales dashboard: conversions for the owner it was handed to");
        eq((await dashConverted(asmB.id)) - presserBefore, 0, "Sales dashboard: conversions for whoever pressed the buttons");
        return "credit is fixed at Won, survives the reassignment, and the Sales dashboard counts it there";
    });

    await check("writer.lost_by_someone_else", async () => {
        const id = await seedOpen(rep.id);
        await writeTouchpoint({
            dealerLeadId: id,
            touchpointType: "status_change_note",
            performedBy: asmB.id,
            remarks: "verify-id117",
            statusChange: {
                from: "Commercials_Finalised", to: "Lost", toLostReason: "not_interested",
                reasonNotes: "verify-id117", event: "mark_lost",
            },
        });
        eq((await closingOwner(id)).closing_owner_id, rep.id, "closing owner at Lost");
        return "a lead marked Lost by someone else is still the owner's";
    });
}

// Every db.* call in the process goes into the one transaction while it is open.
async function main() {
    const real = { execute: db.execute, transaction: db.transaction, select: db.select, insert: db.insert, update: db.update, delete: db.delete, query: db.query };
    try {
        await db.transaction(async (t) => {
            tx = t;
            Object.assign(db, {
                execute: t.execute.bind(t),
                transaction: t.transaction.bind(t),
                select: t.select.bind(t),
                insert: t.insert.bind(t),
                update: t.update.bind(t),
                delete: t.delete.bind(t),
                query: t.query,
            });
            try {
                await run();
            } finally {
                Object.assign(db, real);
            }
            throw new Rollback();
        });
    } catch (e) {
        if (!(e instanceof Rollback)) {
            console.error("verifier crashed:", e);
            process.exit(1);
        }
    }

    console.table(results);
    const failed = results.filter((r) => r.outcome === "FAIL");
    console.log(failed.length ? `${failed.length} FAILED` : `all ${results.length} checks passed — rolled back, nothing was changed`);
    process.exit(failed.length ? 1 : 0);
}

void main();
