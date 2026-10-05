/**
 * Verifier for tracker ID 83 — ownership events from NeoDove calls (review of
 * 30 Sep): the release-safe backfill, "caller not linked", and "called on your
 * behalf".
 *
 *   node --import tsx --env-file=.env.local scripts/verify-neodove-ownership.ts
 *
 * Runs the REAL functions (ownerFromCall.ts) against whatever DATABASE_URL
 * points at. Read-only: every write happens inside a transaction that is ALWAYS
 * rolled back. Exit code 1 if anything FAILs; a check SKIPs when the database
 * has no lead / user in the shape it needs.
 */
import { sql } from "drizzle-orm";

import { db } from "../src/lib/db";
import {
    backfillOwnersForLinkedAgent,
    callerNotLinkedCounts,
    callerNotLinkedFor,
    resolveCallOwnership,
} from "../src/lib/neodove/ownerFromCall";
import { writeTouchpoint } from "../src/lib/touchpoints/write";
import { createInsideSalesLead } from "../src/lib/inside-sales/createLead";

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

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR);

/** An unowned, open lead with no ownership hop and no NeoDove call — a clean slate. */
async function cleanUnownedLead(): Promise<string | null> {
    const rows = (await db.execute<{ id: string }>(sql`
        SELECT dl.id FROM dealer_leads dl
         WHERE dl.current_owner_id IS NULL AND dl.is_active IS NOT FALSE
           AND dl.lead_status IS DISTINCT FROM 'Converted' AND dl.lead_status IS DISTINCT FROM 'Lost'
           AND NOT EXISTS (SELECT 1 FROM lead_touchpoints t WHERE t.dealer_lead_id = dl.id
                              AND (t.from_owner_id IS NOT NULL OR t.to_owner_id IS NOT NULL
                                   OR (t.external_system = 'neodove' AND t.touchpoint_type = 'inside_sales_call')))
         LIMIT 1
    `)) as unknown as Array<{ id: string }>;
    return rows[0]?.id ?? null;
}
async function someRep(): Promise<string | null> {
    const rows = (await db.execute<{ id: string }>(sql`
        SELECT id::text AS id FROM users WHERE role = 'inside_sales_rep' AND is_active = TRUE ORDER BY created_at LIMIT 1
    `)) as unknown as Array<{ id: string }>;
    return rows[0]?.id ?? null;
}
/** A NeoDove call on the lead, by a linked user or (null) an agent nobody has linked. */
async function neodoveCall(tx: Tx, leadId: string, by: string | null, at: Date, agentName = "Verify Agent"): Promise<string> {
    const { touchpointId } = await writeTouchpoint(
        {
            dealerLeadId: leadId,
            touchpointType: "inside_sales_call",
            performedBy: by,
            performedAt: at,
            callStatus: "connected",
            remarks: "verify-neodove-ownership (rolled back)",
            externalSystem: "neodove",
            syncMethod: "api",
        },
        { tx },
    );
    await tx.execute(sql`
        UPDATE lead_touchpoints SET external_agent_name = ${agentName} WHERE touchpoint_id = ${touchpointId}::uuid
    `);
    return touchpointId;
}
async function ownerOf(tx: Tx, leadId: string): Promise<{ owner: string | null; assigned_at: Date | null }> {
    const rows = (await tx.execute<{ owner: string | null; assigned_at: Date | string | null }>(sql`
        SELECT current_owner_id AS owner, assigned_at FROM dealer_leads WHERE id = ${leadId}
    `)) as unknown as Array<{ owner: string | null; assigned_at: Date | string | null }>;
    const r = rows[0];
    return { owner: r?.owner ?? null, assigned_at: r?.assigned_at ? new Date(r.assigned_at) : null };
}
const sameInstant = (a: Date | null, b: Date) => !!a && Math.abs(a.getTime() - b.getTime()) < 1000;

async function main() {
    await check("backfill: a never-owned lead first called by the agent is assigned, dated at that call", async () => {
        const [leadId, rep] = await Promise.all([cleanUnownedLead(), someRep()]);
        if (!leadId || !rep) throw new Error("SKIP: no clean unowned lead / no active inside_sales_rep");
        const t1 = ago(72);
        await rolledBack(async (tx) => {
            await neodoveCall(tx, leadId, rep, t1);
            await backfillOwnersForLinkedAgent(tx, rep);
            const after = await ownerOf(tx, leadId);
            assert(after.owner === rep, `owner is ${after.owner}`);
            assert(sameInstant(after.assigned_at, t1), `assigned_at ${after.assigned_at?.toISOString()} is not the call time`);
            const [hop] = (await tx.execute<{ n: number }>(sql`
                SELECT COUNT(*)::int AS n FROM lead_touchpoints
                 WHERE dealer_lead_id = ${leadId} AND touchpoint_type = 'lead_assigned'
                   AND from_owner_id IS NULL AND to_owner_id = ${rep}
            `)) as unknown as Array<{ n: number }>;
            assert(hop.n === 1, `${hop.n} ownership hops written`);
        });
        return `${leadId}: assigned to the agent, dated 72h ago, with one hop`;
    });

    await check("backfill: a lead an admin RELEASED after that call is not re-grabbed", async () => {
        const [leadId, rep] = await Promise.all([cleanUnownedLead(), someRep()]);
        if (!leadId || !rep) throw new Error("SKIP: no clean unowned lead / no active inside_sales_rep");
        const t1 = ago(72);
        const released = ago(24);
        await rolledBack(async (tx) => {
            await neodoveCall(tx, leadId, rep, t1);
            // It had an owner, and an admin gave it back to the pool yesterday.
            await writeTouchpoint(
                { dealerLeadId: leadId, touchpointType: "ownership_transfer", performedBy: rep, performedAt: ago(48),
                  remarks: "verify: assigned (rolled back)", fromOwnerId: null, toOwnerId: rep },
                { tx },
            );
            await writeTouchpoint(
                { dealerLeadId: leadId, touchpointType: "ownership_transfer", performedBy: rep, performedAt: released,
                  remarks: "verify: released (rolled back)", fromOwnerId: rep, toOwnerId: null },
                { tx },
            );
            await backfillOwnersForLinkedAgent(tx, rep);
            assert((await ownerOf(tx, leadId)).owner === null, "the released lead was handed back on an old call");

            // A NEW call after the release does earn the lead — dated at the new call.
            const t3 = ago(2);
            await neodoveCall(tx, leadId, rep, t3);
            await backfillOwnersForLinkedAgent(tx, rep);
            const after = await ownerOf(tx, leadId);
            assert(after.owner === rep, `a call after the release did not assign (owner ${after.owner})`);
            assert(sameInstant(after.assigned_at, t3), `assigned_at ${after.assigned_at?.toISOString()} is not the NEW call time`);
        });
        return "old call ignored after the release; a new call assigns, dated at the new call";
    });

    await check("caller not linked: an unlinked agent's first call flags the lead and is counted for that agent", async () => {
        const leadId = await cleanUnownedLead();
        if (!leadId) throw new Error("SKIP: no clean unowned lead");
        const name = `Verify Unlinked ${Date.now()}`;
        const t1 = ago(5);
        await rolledBack(async (tx) => {
            assert((await callerNotLinkedFor(leadId, tx)) === null, "flag set before any call");
            await neodoveCall(tx, leadId, null, t1, name);
            const flag = await callerNotLinkedFor(leadId, tx);
            assert(flag && flag.agent_name === name, `flag: ${JSON.stringify(flag)}`);
            assert(sameInstant(new Date(flag.first_call_at), t1), "flag is not dated at the call");
            const counts = await callerNotLinkedCounts(tx);
            assert(counts.get(name.toLowerCase()) === 1, `count for the agent: ${counts.get(name.toLowerCase())}`);
        });
        return "flag carries the agent and the call time; the agent shows 1 lead waiting";
    });

    await check("called on your behalf: only after the OWNER's Call now, and also for an unlinked caller", async () => {
        const rows = (await db.execute<{ id: string; owner: string }>(sql`
            SELECT dl.id, dl.current_owner_id AS owner FROM dealer_leads dl
              JOIN users u ON u.id::text = dl.current_owner_id
             WHERE dl.lead_status IN ('Assigned_Not_Contacted', 'Under_Discussion') AND dl.is_active IS NOT FALSE
               AND NOT EXISTS (SELECT 1 FROM lead_touchpoints r WHERE r.dealer_lead_id = dl.id
                                  AND r.touchpoint_type = 'neodove_dial_request'
                                  AND r.performed_at >= NOW() - INTERVAL '2 days')
             LIMIT 1
        `)) as unknown as Array<{ id: string; owner: string }>;
        const lead = rows[0];
        if (!lead) throw new Error("SKIP: no owned open lead without a recent dial request");
        const other = (await db.execute<{ id: string }>(sql`
            SELECT id::text AS id FROM users WHERE is_active = TRUE AND id::text <> ${lead.owner} LIMIT 1
        `)) as unknown as Array<{ id: string }>;
        if (!other[0]) throw new Error("SKIP: no second active user");
        const someoneElse = other[0].id;
        const now = new Date();
        const behalfOf = async (tx: Tx, tp: string) =>
            ((await tx.execute<{ b: boolean | null }>(sql`
                SELECT called_on_behalf AS b FROM lead_touchpoints WHERE touchpoint_id = ${tp}::uuid
            `)) as unknown as Array<{ b: boolean | null }>)[0]?.b === true;

        // 1. No request at all → an ordinary call.
        await rolledBack(async (tx) => {
            const tp = await neodoveCall(tx, lead.id, null, now);
            const r = await resolveCallOwnership(tx, { leadId: lead.id, touchpointId: tp, agentUserId: null, callAt: now });
            assert(!r.onBehalf && !(await behalfOf(tx, tp)), "marked on-behalf with no Call now request");
        });
        // 2. Someone ELSE (an admin) asked → not on the owner's behalf.
        await rolledBack(async (tx) => {
            await writeTouchpoint(
                { dealerLeadId: lead.id, touchpointType: "neodove_dial_request", performedBy: someoneElse, performedAt: ago(1),
                  remarks: "verify (rolled back)", externalSystem: "neodove", syncMethod: "manual" },
                { tx },
            );
            const tp = await neodoveCall(tx, lead.id, null, now);
            const r = await resolveCallOwnership(tx, { leadId: lead.id, touchpointId: tp, agentUserId: null, callAt: now });
            assert(!r.onBehalf, "marked on-behalf when the request was not the owner's");
        });
        // 3. The OWNER asked; an unlinked agent, then a linked non-owner, calls → both marked; the owner is named.
        await rolledBack(async (tx) => {
            await writeTouchpoint(
                { dealerLeadId: lead.id, touchpointType: "neodove_dial_request", performedBy: lead.owner, performedAt: ago(1),
                  remarks: "verify (rolled back)", externalSystem: "neodove", syncMethod: "manual" },
                { tx },
            );
            const tp1 = await neodoveCall(tx, lead.id, null, now);
            const r1 = await resolveCallOwnership(tx, { leadId: lead.id, touchpointId: tp1, agentUserId: null, callAt: now });
            assert(r1.onBehalf && r1.owner?.id === lead.owner && (await behalfOf(tx, tp1)), "unlinked caller not marked");
            const tp2 = await neodoveCall(tx, lead.id, someoneElse, now);
            const r2 = await resolveCallOwnership(tx, { leadId: lead.id, touchpointId: tp2, agentUserId: someoneElse, callAt: now });
            assert(r2.onBehalf && !r2.assigned && (await behalfOf(tx, tp2)), "linked non-owner caller not marked");
            // 4. The owner's own call is never "on behalf".
            const tp3 = await neodoveCall(tx, lead.id, lead.owner, now);
            const r3 = await resolveCallOwnership(tx, { leadId: lead.id, touchpointId: tp3, agentUserId: lead.owner, callAt: now });
            assert(!r3.onBehalf && !(await behalfOf(tx, tp3)), "the owner's own call was marked on-behalf");
            assert((await ownerOf(tx, lead.id)).owner === lead.owner, "the owner changed");
        });
        return `${lead.id}: marked only after the owner's request, for an unlinked and a linked caller; never for the owner`;
    });

    await check("rep create-and-keep: an inside-sales rep's new lead is theirs, with a dated ownership hop", async () => {
        const rep = await someRep();
        if (!rep) throw new Error("SKIP: no active inside_sales_rep");
        // A number no lead has — a duplicate would be logged as a re-inquiry OUTSIDE the transaction.
        let phone = "";
        for (let i = 0; i < 20 && !phone; i++) {
            const candidate = `6${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
            const hit = (await db.execute<{ n: number }>(sql`
                SELECT COUNT(*)::int AS n FROM dealer_leads
                 WHERE right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = ${candidate}
            `)) as unknown as Array<{ n: number }>;
            if ((hit[0]?.n ?? 0) === 0) phone = candidate;
        }
        if (!phone) throw new Error("SKIP: could not find an unused phone number");
        let note = "";
        await rolledBack(async (tx) => {
            const created = await createInsideSalesLead(
                {
                    actor: { id: rep, role: "inside_sales_rep" },
                    dealerName: "Verify Keep (rolled back)",
                    phone,
                    city: "Pune",
                    origin: "dealer_referral",
                },
                { tx },
            );
            const [lead] = (await tx.execute<{ owner: string | null; lead_status: string | null; assigned_at: string | null }>(sql`
                SELECT current_owner_id AS owner, lead_status, assigned_at::text AS assigned_at
                  FROM dealer_leads WHERE id = ${created.id}
            `)) as unknown as Array<{ owner: string | null; lead_status: string | null; assigned_at: string | null }>;
            assert(lead.owner === rep, `owner is ${lead.owner}`);
            assert(lead.lead_status === "Assigned_Not_Contacted", `status is ${lead.lead_status}`);
            assert(!!lead.assigned_at, "assigned_at is not set");
            const [hop] = (await tx.execute<{ n: number }>(sql`
                SELECT COUNT(*)::int AS n FROM lead_touchpoints
                 WHERE dealer_lead_id = ${created.id} AND from_owner_id IS NULL AND to_owner_id = ${rep}
            `)) as unknown as Array<{ n: number }>;
            assert(hop.n === 1, `${hop.n} ownership hops written`);
            note = `owned by the rep at Assigned_Not_Contacted, one hop (nobody → rep)`;
        });
        return note;
    });

    await check("the live 'caller not linked' counts run on this database", async () => {
        const counts = await callerNotLinkedCounts();
        const total = [...counts.values()].reduce((a, b) => a + b, 0);
        return `${total} unowned lead(s) waiting on ${counts.size} unlinked agent(s)`;
    });

    for (const r of results) console.log(`${r.outcome.padEnd(4)}  ${r.id} — ${r.note}`);
    const failed = results.filter((r) => r.outcome === "FAIL").length;
    console.log(`\n${results.length - failed} ok / ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

void main();
