/**
 * Verifier for tracker ID 79 — a WhatsApp chat counts only with a screenshot.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-whatsapp-contact.ts
 *
 * Runs the REAL writer (recordWhatsappContact — the one the CRM's Log
 * Touchpoint and the WhatsApp Assistant's log_call both use) and the Sales Head
 * view's query against whatever DATABASE_URL points at. Read-only: every write
 * happens inside a transaction that is ALWAYS rolled back. Exit code 1 if
 * anything FAILs; a check SKIPs when the database has no lead in the shape it
 * needs.
 */
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../src/lib/db";
import { listWhatsappScreenshots, recordWhatsappContact, screenshotHash } from "../src/lib/leads/whatsappContact";

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

type Lead = { id: string; lead_status: string | null; owner: string | null; last_worked_at: string | null };

/** An owned lead that has not reached first contact yet. */
async function uncontactedLead(): Promise<Lead | null> {
    const rows = (await db.execute<Lead>(sql`
        SELECT id, lead_status, current_owner_id AS owner, last_worked_at::text AS last_worked_at
          FROM dealer_leads
         WHERE lead_status = 'Assigned_Not_Contacted' AND current_owner_id IS NOT NULL AND is_active IS NOT FALSE
         LIMIT 1
    `)) as unknown as Lead[];
    return rows[0] ?? null;
}
async function leadNow(tx: Tx, id: string): Promise<{ lead_status: string | null; last_worked_at: string | null }> {
    const rows = (await tx.execute<{ lead_status: string | null; last_worked_at: string | null }>(sql`
        SELECT lead_status, last_worked_at::text AS last_worked_at FROM dealer_leads WHERE id = ${id}
    `)) as unknown as Array<{ lead_status: string | null; last_worked_at: string | null }>;
    return rows[0];
}
/** A screenshot no touchpoint has ever carried. */
const freshShot = () => ({ url: "/api/files/documents/verify/not-a-real-file.jpg", sha256: screenshotHash(randomBytes(32)) });

async function main() {
    await check("dealer replied + a fresh screenshot → Under discussion, engaged, idle clock reset", async () => {
        const lead = await uncontactedLead();
        if (!lead) throw new Error("SKIP: no owned Assigned_Not_Contacted lead");
        let note = "";
        await rolledBack(async (tx) => {
            const res = await recordWhatsappContact(tx, {
                leadId: lead.id, actorId: lead.owner!, remarks: "verify (rolled back)", dealerReplied: true, screenshot: freshShot(),
            });
            assert(res.countedAsContact && !res.reused, `not counted: ${JSON.stringify(res)}`);
            assert(res.statusTo === "Under_Discussion", `statusTo ${res.statusTo}`);
            const after = await leadNow(tx, lead.id);
            assert(after.lead_status === "Under_Discussion", `lead is ${after.lead_status}`);
            assert(after.last_worked_at && after.last_worked_at !== lead.last_worked_at, "idle clock (last_worked_at) did not move");
            const [tp] = (await tx.execute<{ is_engaged: boolean | null; sha: string | null }>(sql`
                SELECT is_engaged, screenshot_sha256 AS sha FROM lead_touchpoints WHERE touchpoint_id = ${res.touchpointId}::uuid
            `)) as unknown as Array<{ is_engaged: boolean | null; sha: string | null }>;
            assert(tp.is_engaged === true && !!tp.sha, "touchpoint is not engaged / carries no hash");
            note = `${lead.id}: Assigned_Not_Contacted → Under_Discussion`;
        });
        return note;
    });

    await check("no screenshot → a note: no status, no idle clock, not engaged", async () => {
        const lead = await uncontactedLead();
        if (!lead) throw new Error("SKIP: no owned Assigned_Not_Contacted lead");
        await rolledBack(async (tx) => {
            const res = await recordWhatsappContact(tx, {
                leadId: lead.id, actorId: lead.owner!, remarks: "verify (rolled back)", dealerReplied: true, screenshot: null,
            });
            assert(!res.countedAsContact && res.statusTo === null, `counted: ${JSON.stringify(res)}`);
            const after = await leadNow(tx, lead.id);
            assert(after.lead_status === lead.lead_status, `lead moved to ${after.lead_status}`);
            assert(after.last_worked_at === lead.last_worked_at, "idle clock moved for a note");
        });
        return "status and idle clock unchanged";
    });

    await check("a screenshot with no reply from the dealer is a note too", async () => {
        const lead = await uncontactedLead();
        if (!lead) throw new Error("SKIP: no owned Assigned_Not_Contacted lead");
        await rolledBack(async (tx) => {
            const res = await recordWhatsappContact(tx, {
                leadId: lead.id, actorId: lead.owner!, remarks: "verify (rolled back)", dealerReplied: false, screenshot: freshShot(),
            });
            assert(!res.countedAsContact && !res.reused && res.statusTo === null, `counted: ${JSON.stringify(res)}`);
            assert((await leadNow(tx, lead.id)).lead_status === lead.lead_status, "lead moved");
        });
        return "saved, not counted";
    });

    await check("the same image a second time is REUSED: saved, flagged, never counted", async () => {
        const lead = await uncontactedLead();
        if (!lead) throw new Error("SKIP: no owned Assigned_Not_Contacted lead");
        const shot = freshShot();
        await rolledBack(async (tx) => {
            const first = await recordWhatsappContact(tx, {
                leadId: lead.id, actorId: lead.owner!, remarks: "verify 1 (rolled back)", dealerReplied: true, screenshot: shot,
            });
            const second = await recordWhatsappContact(tx, {
                leadId: lead.id, actorId: lead.owner!, remarks: "verify 2 (rolled back)", dealerReplied: true, screenshot: shot,
            });
            assert(first.countedAsContact, "the first use was not counted");
            assert(second.reused && !second.countedAsContact, `second use: ${JSON.stringify(second)}`);
            const [tp] = (await tx.execute<{ reused: string | null; is_engaged: boolean | null }>(sql`
                SELECT attachments -> 0 ->> 'reused' AS reused, is_engaged
                  FROM lead_touchpoints WHERE touchpoint_id = ${second.touchpointId}::uuid
            `)) as unknown as Array<{ reused: string | null; is_engaged: boolean | null }>;
            assert(tp.reused === "true" && tp.is_engaged !== true, "the reused entry is not flagged, or is engaged");
        });
        return "second use flagged reused and not engaged";
    });

    await check("the Sales Head view's query runs; reused rows first, each naming the earlier entry", async () => {
        const rows = await listWhatsappScreenshots(90);
        let seenFresh = false;
        for (const r of rows) {
            if (!r.reused) seenFresh = true;
            assert(!(r.reused && seenFresh), "a reused row is listed after a fresh one");
            assert(!(r.reused && r.counted), `${r.touchpoint_id}: reused but counted as contact`);
        }
        const reused = rows.filter((r) => r.reused);
        const named = reused.filter((r) => r.first_used_at).length;
        return `${rows.length} screenshots in 90 days, ${reused.length} reused (${named} name the earlier entry)`;
    });

    for (const r of results) console.log(`${r.outcome.padEnd(4)}  ${r.id} — ${r.note}`);
    const failed = results.filter((r) => r.outcome === "FAIL").length;
    console.log(`\n${results.length - failed} ok / ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

void main();
