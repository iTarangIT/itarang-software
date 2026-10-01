/**
 * Verifier for the outcome rule in the central status writer (tracker ID 114)
 * and the Won corrections (ID 74), 01 Oct 2026.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-status-outcome.ts
 *
 * Runs the REAL writers against whatever DATABASE_URL points at. Every check
 * writes inside a transaction that is ALWAYS rolled back — nothing is left
 * behind. Run it on the sandbox database; exit code 1 if anything FAILs.
 */
import { sql } from "drizzle-orm";

import { db } from "../src/lib/db";
import { writeTouchpoint } from "../src/lib/touchpoints/write";
import { applyVisitStatus } from "../src/lib/asm/visitStatus";
import { logLeadTouchpoint } from "../src/lib/inside-sales/logTouchpoint";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Outcome = "PASS" | "FAIL" | "SKIP";
const results: Array<{ id: string; outcome: Outcome; note: string }> = [];
class Rollback extends Error {}

async function check(id: string, fn: () => Promise<string>) {
    try {
        results.push({ id, outcome: "PASS", note: await fn() });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        results.push({ id, outcome: msg.startsWith("SKIP") ? "SKIP" : "FAIL", note: msg });
    }
}
function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new Error(msg);
}
async function rolledBack(fn: (tx: Tx) => Promise<void>) {
    try {
        await db.transaction(async (tx) => {
            await fn(tx);
            throw new Rollback();
        });
    } catch (e) {
        if (!(e instanceof Rollback)) throw e;
    }
}

type Lead = {
    id: string;
    lead_status: string | null;
    interest_level: string | null;
    current_owner_id: string | null;
    pre_transfer_status: string | null;
    closed_at: string | null;
    closing_owner_id: string | null;
    lost_reason: string | null;
};
const COLS = sql`id, lead_status, interest_level, current_owner_id, pre_transfer_status,
                 closed_at::text AS closed_at, closing_owner_id, lost_reason`;

async function findLead(where: ReturnType<typeof sql>): Promise<Lead | null> {
    const rows = (await db.execute<Lead>(sql`
        SELECT ${COLS} FROM dealer_leads dl WHERE dl.is_active IS NOT FALSE AND ${where} LIMIT 1
    `)) as unknown as Lead[];
    return rows[0] ?? null;
}
async function reread(tx: Tx, id: string): Promise<Lead> {
    const rows = (await tx.execute<Lead>(sql`SELECT ${COLS} FROM dealer_leads WHERE id = ${id}`)) as unknown as Lead[];
    return rows[0]!;
}
/** Owned by a real user, so the owner can be the actor. */
const OWNED = sql`dl.current_owner_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM users u WHERE u.id::text = dl.current_owner_id)`;
/** A connected outcome whose bucket differs from the lead's temperature. */
const outcomeFor = (interest: string | null) =>
    (interest ?? "").toLowerCase() === "hot"
        ? { label: "Need Some Time", to: "cold" }
        : { label: "Commercials Finalised", to: "hot" };

async function main() {
    const host = new URL(process.env.DATABASE_URL ?? "postgres://x@unknown/x").host.split(".")[0];
    console.log(`DB host: ${host}`);

    await check("ID 114 a call outcome moves an owned lead to first contact and sets the bucket's temperature", async () => {
        const lead = await findLead(sql`dl.lead_status = 'Assigned_Not_Contacted' AND ${OWNED}`);
        if (!lead) throw new Error("SKIP: no owned Assigned_Not_Contacted lead");
        const o = outcomeFor(lead.interest_level);
        let after: Lead | null = null;
        let history = 0;
        let overrides = 0;
        await rolledBack(async (tx) => {
            const r = await writeTouchpoint(
                {
                    dealerLeadId: lead.id,
                    touchpointType: "inside_sales_call",
                    performedBy: lead.current_owner_id,
                    callStatus: "connected",
                    outcome: { kind: "call", connected: true, label: o.label, bucket: null },
                },
                { tx },
            );
            after = await reread(tx, lead.id);
            history = r.historyId ? 1 : 0;
            const [n] = (await tx.execute<{ n: string }>(sql`
                SELECT COUNT(*)::text AS n FROM interest_level_overrides
                 WHERE dealer_lead_id = ${lead.id} AND to_value = ${o.to} AND changed_at >= now() - INTERVAL '1 minute'
            `)) as unknown as Array<{ n: string }>;
            overrides = Number(n.n);
        });
        assert(after!.lead_status === "Under_Discussion", `status is ${after!.lead_status}, expected Under_Discussion`);
        assert(after!.interest_level === o.to, `temperature is ${after!.interest_level}, expected ${o.to}`);
        assert(history === 1, "no status history row");
        assert(overrides === 1, `${overrides} temperature audit rows, expected 1`);
        return `${lead.id}: Assigned → Under discussion, ${lead.interest_level ?? "none"} → ${o.to} ("${o.label}"), history + audit rows written`;
    });

    await check("ID 114 interest: null leaves the temperature alone; no outcome changes nothing", async () => {
        const lead = await findLead(sql`dl.lead_status = 'Assigned_Not_Contacted' AND ${OWNED}`);
        if (!lead) throw new Error("SKIP: no owned Assigned_Not_Contacted lead");
        const o = outcomeFor(lead.interest_level);
        let kept: Lead | null = null;
        let plain: Lead | null = null;
        await rolledBack(async (tx) => {
            await writeTouchpoint(
                {
                    dealerLeadId: lead.id,
                    touchpointType: "inside_sales_call",
                    performedBy: lead.current_owner_id,
                    outcome: { kind: "call", connected: true, label: o.label, bucket: null },
                    interest: null,
                },
                { tx },
            );
            kept = await reread(tx, lead.id);
        });
        await rolledBack(async (tx) => {
            await writeTouchpoint(
                { dealerLeadId: lead.id, touchpointType: "inside_sales_call", performedBy: lead.current_owner_id, callStatus: "connected" },
                { tx },
            );
            plain = await reread(tx, lead.id);
        });
        assert(kept!.lead_status === "Under_Discussion", "the status move was lost with interest: null");
        assert(kept!.interest_level === lead.interest_level, `temperature changed to ${kept!.interest_level} despite "leave it"`);
        assert(
            plain!.lead_status === lead.lead_status && plain!.interest_level === lead.interest_level,
            "a touchpoint with no outcome changed the lead",
        );
        return `${lead.id}: "leave it" kept ${lead.interest_level ?? "none"}; a plain call left status and temperature as they were`;
    });

    await check("ID 114 someone else's call moves the status but not the owner's temperature (P0-10)", async () => {
        const lead = await findLead(sql`dl.lead_status = 'Assigned_Not_Contacted' AND ${OWNED}`);
        if (!lead) throw new Error("SKIP: no owned Assigned_Not_Contacted lead");
        const [other] = (await db.execute<{ id: string }>(sql`
            SELECT id::text AS id FROM users WHERE id::text <> ${lead.current_owner_id} AND is_active IS NOT FALSE LIMIT 1
        `)) as unknown as Array<{ id: string }>;
        if (!other) throw new Error("SKIP: no second user");
        const o = outcomeFor(lead.interest_level);
        let after: Lead | null = null;
        await rolledBack(async (tx) => {
            await writeTouchpoint(
                {
                    dealerLeadId: lead.id,
                    touchpointType: "inside_sales_call",
                    performedBy: other.id,
                    outcome: { kind: "call", connected: true, label: o.label, bucket: null, firstContactOnConnect: true },
                },
                { tx },
            );
            after = await reread(tx, lead.id);
        });
        assert(after!.lead_status === "Under_Discussion", `status is ${after!.lead_status}`);
        assert(after!.interest_level === lead.interest_level, `a non-owner's call changed the temperature to ${after!.interest_level}`);
        return `${lead.id}: first contact recorded, temperature stayed ${lead.interest_level ?? "none"}`;
    });

    await check("ID 116 an inbound connected call with a Lost-type outcome is first contact, with no temperature", async () => {
        const lead = await findLead(sql`dl.lead_status = 'Assigned_Not_Contacted' AND ${OWNED}`);
        if (!lead) throw new Error("SKIP: no owned Assigned_Not_Contacted lead");
        let after: Lead | null = null;
        await rolledBack(async (tx) => {
            await writeTouchpoint(
                {
                    dealerLeadId: lead.id,
                    touchpointType: "inside_sales_call",
                    performedBy: lead.current_owner_id,
                    externalSystem: "neodove",
                    externalEventId: "verify-status-outcome-lost",
                    outcome: { kind: "call", connected: true, label: "Not Interested", bucket: null, firstContactOnConnect: true },
                },
                { tx },
            );
            after = await reread(tx, lead.id);
        });
        assert(after!.lead_status === "Under_Discussion", `status is ${after!.lead_status}`);
        assert(after!.interest_level === lead.interest_level, "a Lost-type outcome changed the temperature");
        return `${lead.id}: Under discussion, temperature untouched, lead not closed`;
    });

    await check("ID 77 / 115 a call never ends Awaiting field visit, never moves a later stage back — and never throws", async () => {
        const notes: string[] = [];
        for (const status of ["Transferred_to_ASM", "Commercials_Explained", "Commercials_Finalised", "Won"]) {
            const lead = await findLead(sql`dl.lead_status = ${status}`);
            if (!lead) continue;
            let after: Lead | null = null;
            await rolledBack(async (tx) => {
                await writeTouchpoint(
                    {
                        dealerLeadId: lead.id,
                        touchpointType: "inside_sales_call",
                        performedBy: lead.current_owner_id,
                        outcome: { kind: "call", connected: true, label: "Details Shared", bucket: null, firstContactOnConnect: true },
                        interest: null,
                    },
                    { tx },
                );
                after = await reread(tx, lead.id);
            });
            assert(after!.lead_status === status, `${lead.id}: ${status} became ${after!.lead_status}`);
            notes.push(status);
        }
        if (!notes.length) throw new Error("SKIP: no lead at Transferred / commercials / Won");
        return `stayed put: ${notes.join(", ")}`;
    });

    await check("ID 114 / 77 a done visit, derived on the server, ends Awaiting field visit and sets the temperature", async () => {
        const lead = await findLead(sql`dl.lead_status = 'Transferred_to_ASM' AND ${OWNED}`);
        if (!lead) throw new Error("SKIP: no owned lead Awaiting field visit");
        const expectHot = (lead.interest_level ?? "").toLowerCase() !== "hot";
        let after: Lead | null = null;
        let status: string | null = null;
        await rolledBack(async (tx) => {
            const r = await applyVisitStatus(tx, {
                leadId: lead.id,
                actorId: lead.current_owner_id!,
                requested: null,
                remarks: "verify-status-outcome",
                outcome: "commercials_progressed",
            });
            status = r.status;
            after = await reread(tx, lead.id);
        });
        assert(status && after!.lead_status === status, `visit returned ${status}, lead is ${after!.lead_status}`);
        assert(after!.lead_status !== "Transferred_to_ASM", "the visit did not end Awaiting field visit");
        assert(!expectHot || after!.interest_level === "hot", `temperature is ${after!.interest_level}, expected hot`);
        return `${lead.id}: Awaiting field visit → ${after!.lead_status} (was ${lead.pre_transfer_status ?? "—"} before transfer), temperature ${after!.interest_level}`;
    });

    // ── Review of 30 Sep, the three open points, through the services the routes call ──

    await check("ID 114 review 1: a productive visit on an Assigned lead moves it with NO status sent", async () => {
        const lead = await findLead(sql`dl.lead_status = 'Assigned_Not_Contacted' AND ${OWNED}`);
        if (!lead) throw new Error("SKIP: no owned Assigned_Not_Contacted lead");
        let after: Lead | null = null;
        let history: string | null = null;
        await rolledBack(async (tx) => {
            // Exactly what POST /api/asm/lead/[id]/visit passes: requested null,
            // the outcome, and no interest — nothing from the client decides.
            const r = await applyVisitStatus(tx, {
                leadId: lead.id,
                actorId: lead.current_owner_id!,
                requested: null,
                remarks: "verify-status-outcome",
                outcome: "productive",
            });
            history = r.historyId;
            after = await reread(tx, lead.id);
        });
        assert(after!.lead_status === "Under_Discussion", `status is ${after!.lead_status}, expected Under_Discussion`);
        assert(history, "no status history row");
        assert(after!.interest_level === lead.interest_level, "a productive visit changed the temperature");
        return `${lead.id}: Assigned → Under discussion from the outcome alone; temperature left as it was`;
    });

    await check("ID 114 review 2: an API call that sends no temperature gets one, in the same transaction", async () => {
        const lead = await findLead(sql`dl.lead_status = 'Assigned_Not_Contacted' AND ${OWNED}`);
        if (!lead) throw new Error("SKIP: no owned Assigned_Not_Contacted lead");
        const o = outcomeFor(lead.interest_level);
        let after: Lead | null = null;
        await rolledBack(async (tx) => {
            // The touchpoints API body with no interest_level and no status_change —
            // an API client or the Assistant, not the form.
            await logLeadTouchpoint(
                {
                    leadId: lead.id,
                    actorId: lead.current_owner_id!,
                    body: {
                        touchpoint_type: "inside_sales_call",
                        disposition: { connect_status: "connected", label: o.label },
                        remarks: "verify-status-outcome",
                    },
                },
                { tx },
            );
            after = await reread(tx, lead.id);
        });
        assert(after!.lead_status === "Under_Discussion", `status is ${after!.lead_status}, expected Under_Discussion`);
        assert(after!.interest_level === o.to, `temperature is ${after!.interest_level}, expected ${o.to}`);
        const gone = await findLead(sql`dl.id = ${lead.id}`);
        assert(
            gone!.lead_status === lead.lead_status && gone!.interest_level === lead.interest_level,
            "status / temperature did not roll back together",
        );
        return `${lead.id}: one write set Under discussion and ${o.to}; rolled back together`;
    });

    await check("ID 114 review 3 / ID 115: a rep asking for Under discussion on a note is not obeyed", async () => {
        const lead = await findLead(sql`dl.lead_status = 'Assigned_Not_Contacted' AND ${OWNED}`);
        if (!lead) throw new Error("SKIP: no owned Assigned_Not_Contacted lead");
        let after: Lead | null = null;
        let history: string | null = null;
        await rolledBack(async (tx) => {
            const r = await logLeadTouchpoint(
                {
                    leadId: lead.id,
                    actorId: lead.current_owner_id!,
                    body: {
                        touchpoint_type: "status_change_note",
                        remarks: "verify-status-outcome: spoke to the dealer",
                        status_change: { to: "Under_Discussion", reason_notes: "asked for by hand" },
                    },
                },
                { tx },
            );
            history = r.historyId;
            after = await reread(tx, lead.id);
        });
        assert(after!.lead_status === "Assigned_Not_Contacted", `status is ${after!.lead_status}, expected no move`);
        assert(!history, "a status history row was written");
        return `${lead.id}: the note was saved, the status stayed Assigned`;
    });

    await check("ID 115 reactivation goes through the guard: Lost → Assigned clears the closing fields", async () => {
        const lead = await findLead(sql`dl.lead_status = 'Lost'`);
        if (!lead) throw new Error("SKIP: no Lost lead");
        let after: Lead | null = null;
        let history = false;
        await rolledBack(async (tx) => {
            const r = await writeTouchpoint(
                {
                    dealerLeadId: lead.id,
                    touchpointType: "reactivated_via_admin",
                    performedBy: null,
                    remarks: "verify-status-outcome",
                    statusChange: { from: "Lost", to: "Assigned_Not_Contacted", event: "reactivation", reasonNotes: "verify" },
                },
                { tx },
            );
            history = !!r.historyId;
            after = await reread(tx, lead.id);
        });
        assert(after!.lead_status === "Assigned_Not_Contacted", `status is ${after!.lead_status}`);
        assert(after!.closed_at === null && after!.closing_owner_id === null && after!.lost_reason === null, "closing fields not cleared");
        assert(history, "no status history row");
        return `${lead.id}: Lost → Assigned, closed_at / closing owner / lost reason cleared`;
    });

    await check("ID 74 a correction Converted → Won reopens the lead and keeps the closing owner", async () => {
        const [e314] = (await db.execute<{ ok: boolean }>(sql`
            SELECT EXISTS (SELECT 1 FROM information_schema.columns
                            WHERE table_name = 'dealer_leads' AND column_name = 'won_at') AS ok
        `)) as unknown as Array<{ ok: boolean }>;
        if (!e314.ok) throw new Error("SKIP: E-314 not applied (no won_at)");
        const lead = await findLead(sql`dl.lead_status = 'Converted' AND dl.closing_owner_id IS NOT NULL`);
        if (!lead) throw new Error("SKIP: no Converted lead with a closing owner");
        let after: Lead | null = null;
        await rolledBack(async (tx) => {
            await writeTouchpoint(
                {
                    dealerLeadId: lead.id,
                    touchpointType: "status_change_note",
                    performedBy: null,
                    syncMethod: "reconciliation",
                    statusChange: { from: "Converted", to: "Won", event: "correction", reasonNotes: "verify-status-outcome" },
                },
                { tx },
            );
            after = await reread(tx, lead.id);
        });
        assert(after!.lead_status === "Won", `status is ${after!.lead_status}`);
        assert(after!.closed_at === null, "closed_at not cleared — the lead would still count as closed");
        assert(after!.closing_owner_id === lead.closing_owner_id, `closing owner moved ${lead.closing_owner_id} → ${after!.closing_owner_id}`);
        return `${lead.id}: Won, open again, closing owner kept`;
    });

    for (const r of results) console.log(`${r.outcome.padEnd(4)}  ${r.id} — ${r.note}`);
    const failed = results.filter((r) => r.outcome === "FAIL").length;
    console.log(`\n${results.length - failed} ok / ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

void main();
