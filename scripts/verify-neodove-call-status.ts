/**
 * Verifier for tracker ID 116 — a NeoDove call is a call event only (review of
 * 30 Sep): a connected call is first contact (Under discussion) when the lead
 * is earlier than that, and NOTHING else; it never moves a lead backwards, never
 * ends Awaiting field visit, and is never dropped.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-neodove-call-status.ts
 *
 * Runs the REAL mapper (callOutcomeFor) and writer (writeTouchpoint) — the two
 * calls the webhook makes — against whatever DATABASE_URL points at. Read-only:
 * every write happens inside a transaction that is ALWAYS rolled back. Exit code
 * 1 if anything FAILs.
 */
import { sql } from "drizzle-orm";

import { db } from "../src/lib/db";
import { callOutcomeFor, callStatusFor } from "../src/lib/neodove/mapper";
import type { NeodoveInboundEvent } from "../src/lib/neodove/types";
import { writeTouchpoint } from "../src/lib/touchpoints/write";

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

/** A NeoDove call event, as the mapper hands it to the webhook handler. */
function event(over: Partial<NeodoveInboundEvent>): NeodoveInboundEvent {
    return {
        eventType: "call_connected",
        externalEventId: `verify-${Date.now()}-${Math.random()}`,
        mobile: null,
        neodoveLeadId: null,
        itarangLeadId: null,
        campaignName: null,
        campaignId: null,
        callConnected: true,
        disposition: null,
        dispositionCode: null,
        stage: null,
        tag: null,
        agentName: "Verify Agent",
        callDurationSec: 90,
        ...over,
    } as NeodoveInboundEvent;
}

/** Exactly what handleDisposition writes for a call. */
function neodoveCall(tx: Tx, leadId: string, ev: NeodoveInboundEvent) {
    return writeTouchpoint(
        {
            dealerLeadId: leadId,
            touchpointType: "inside_sales_call",
            performedBy: null,
            callStatus: callStatusFor(ev),
            callDurationSec: ev.callDurationSec,
            remarks: "verify-neodove-call-status (rolled back)",
            externalSystem: "neodove",
            syncMethod: "api",
            outcome: callOutcomeFor(ev),
            interestReason: "Auto: from NeoDove call outcome",
        },
        { tx },
    );
}
async function statusOf(tx: Tx, id: string): Promise<string | null> {
    const rows = (await tx.execute<{ s: string | null }>(sql`SELECT lead_status AS s FROM dealer_leads WHERE id = ${id}`)) as unknown as Array<{ s: string | null }>;
    return rows[0]?.s ?? null;
}
async function callsOn(tx: Tx, id: string): Promise<number> {
    const rows = (await tx.execute<{ n: number }>(sql`
        SELECT COUNT(*)::int AS n FROM lead_touchpoints
         WHERE dealer_lead_id = ${id} AND remarks = 'verify-neodove-call-status (rolled back)'
    `)) as unknown as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
}

async function main() {
    const [lead] = (await db.execute<{ id: string }>(sql`
        SELECT id FROM dealer_leads WHERE is_active IS NOT FALSE AND current_owner_id IS NOT NULL LIMIT 1
    `)) as unknown as Array<{ id: string }>;
    if (!lead) {
        console.log("SKIP  no owned lead on this database");
        process.exit(0);
    }
    // One real lead, put at each status inside the rolled-back transaction.
    const at = (tx: Tx, status: string, preTransfer: string | null = null) =>
        tx.execute(sql`UPDATE dealer_leads SET lead_status = ${status}, pre_transfer_status = ${preTransfer} WHERE id = ${lead.id}`);

    await check("review point 1: a connected call on a lead Awaiting field visit is RECORDED, and the status stays", async () => {
        await rolledBack(async (tx) => {
            await at(tx, "Transferred_to_ASM", "Under_Discussion");
            const { touchpointId } = await neodoveCall(tx, lead.id, event({ disposition: "Hot" }));
            assert(touchpointId, "no touchpoint written");
            assert((await callsOn(tx, lead.id)) === 1, "the call was not recorded");
            assert((await statusOf(tx, lead.id)) === "Transferred_to_ASM", `status moved to ${await statusOf(tx, lead.id)}`);
        });
        return "call written; lead still Transferred_to_ASM (only a visit ends it)";
    });

    await check("a connected call is first contact: Assigned not contacted → Under discussion", async () => {
        await rolledBack(async (tx) => {
            await at(tx, "Assigned_Not_Contacted");
            await neodoveCall(tx, lead.id, event({}));
            assert((await statusOf(tx, lead.id)) === "Under_Discussion", `status is ${await statusOf(tx, lead.id)}`);
        });
        return "moved to Under_Discussion, with no disposition label at all";
    });

    await check("review point 2: a second connected call on the SAME lead is recorded — no 'already Under discussion' refusal", async () => {
        await rolledBack(async (tx) => {
            await at(tx, "Assigned_Not_Contacted");
            await neodoveCall(tx, lead.id, event({}));
            // The status is now Under_Discussion. The second event derives its
            // move from the row as it is NOW, so it asks for nothing.
            await neodoveCall(tx, lead.id, event({}));
            assert((await callsOn(tx, lead.id)) === 2, `${await callsOn(tx, lead.id)} of 2 calls recorded`);
            assert((await statusOf(tx, lead.id)) === "Under_Discussion", "status changed again");
        });
        return "both calls recorded; the status moved once";
    });

    await check("review point 2: the status is read under a row lock, so two webhooks cannot both read the old status", async () => {
        let secondFinishedWhileFirstOpen = false;
        let releaseFirst: () => void = () => {};
        const firstHolds = new Promise<void>((r) => (releaseFirst = r));
        let firstWrote: () => void = () => {};
        const firstHasWritten = new Promise<void>((r) => (firstWrote = r));

        // Webhook A writes and keeps its transaction open.
        const a = rolledBack(async (tx) => {
            await at(tx, "Assigned_Not_Contacted");
            await neodoveCall(tx, lead.id, event({}));
            firstWrote();
            await firstHolds;
        });
        await firstHasWritten;
        // Webhook B, on its own connection, must WAIT for A before it can read the status.
        let bDone = false;
        const b = rolledBack(async (tx) => {
            await neodoveCall(tx, lead.id, event({}));
            bDone = true;
        });
        await new Promise((r) => setTimeout(r, 1500));
        secondFinishedWhileFirstOpen = bDone;
        releaseFirst();
        await Promise.all([a, b]);
        assert(!secondFinishedWhileFirstOpen, "the second write did not wait — the status is not read under a lock");
        assert(bDone, "the second write never completed after the first released the row");
        return "the second webhook waited for the first, then completed";
    });

    await check("no backward move: a 'hot' connected call on a later stage leaves the stage alone", async () => {
        const tried: string[] = [];
        for (const status of ["Under_Discussion", "Commercials_Explained", "Awaiting_Customer_Decision", "Commercials_Finalised", "Won"]) {
            await rolledBack(async (tx) => {
                await at(tx, status);
                await neodoveCall(tx, lead.id, event({ disposition: "Hot", stage: "Interested" }));
                assert((await statusOf(tx, lead.id)) === status, `${status} → ${await statusOf(tx, lead.id)}`);
                assert((await callsOn(tx, lead.id)) === 1, `call not recorded at ${status}`);
            });
            tried.push(status);
        }
        return `unchanged at ${tried.join(", ")}`;
    });

    await check("NeoDove stages and dispositions never set a commercials status", async () => {
        const tried: string[] = [];
        for (const [stage, disposition] of [["Negotiation", "Quote Sent"], ["Awaiting Decision", "Commercials Explained"], ["Quote Sent", "Hot"]]) {
            await rolledBack(async (tx) => {
                await at(tx, "Assigned_Not_Contacted");
                await neodoveCall(tx, lead.id, event({ stage, disposition }));
                const s = await statusOf(tx, lead.id);
                assert(s === "Under_Discussion", `stage "${stage}" / "${disposition}" set ${s}`);
            });
            tried.push(`${stage} / ${disposition}`);
        }
        return `first contact only, for: ${tried.join("; ")}`;
    });

    await check("a call that did not connect, and a call on a closed lead, are recorded and move nothing", async () => {
        await rolledBack(async (tx) => {
            await at(tx, "Assigned_Not_Contacted");
            await neodoveCall(tx, lead.id, event({ eventType: "call_not_connected", callConnected: false }));
            assert((await statusOf(tx, lead.id)) === "Assigned_Not_Contacted", "a not-connected call moved the lead");
            assert((await callsOn(tx, lead.id)) === 1, "the not-connected call was not recorded");
        });
        for (const status of ["Lost", "Converted"]) {
            await rolledBack(async (tx) => {
                await at(tx, status);
                await neodoveCall(tx, lead.id, event({}));
                assert((await statusOf(tx, lead.id)) === status, `${status} lead moved`);
                assert((await callsOn(tx, lead.id)) === 1, `call on a ${status} lead was not recorded`);
            });
        }
        return "not connected: recorded, no move; Lost and Converted: recorded, no move";
    });

    for (const r of results) console.log(`${r.outcome.padEnd(4)}  ${r.id} — ${r.note}`);
    const failed = results.filter((r) => r.outcome === "FAIL").length;
    console.log(`\n${results.length - failed} ok / ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

void main();
