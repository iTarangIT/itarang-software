/**
 * Tracker ID 80 — "every status change has an event behind it": the three
 * points of the 30 Sep review, checked against the database in DATABASE_URL.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-id80-status.ts
 *
 * Uses the REAL writers (logLeadTouchpoint, writeTouchpoint). Since 9 Oct (ID 136)
 * "Correct status" is gone — scripts/verify-id80-undo-lost-reason.ts checks what
 * replaced it (Undo Mark Won, Change Lost reason).
 * Leaves nothing behind: every write happens inside a transaction that is
 * always rolled back. Exit code 1 if anything FAILs.
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { applyVisitStatus } from "@/lib/asm/visitStatus";
import { logLeadTouchpoint } from "@/lib/inside-sales/logTouchpoint";
import { existsSync } from "node:fs";
import { writeTouchpoint } from "@/lib/touchpoints/write";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Lead = { id: string; lead_status: string; current_owner_id: string | null; last_worked_at: string | null };
class Rollback extends Error {}

let failed = 0;
const say = (outcome: "PASS" | "FAIL" | "SKIP", label: string, detail = "") => {
    if (outcome === "FAIL") failed += 1;
    console.log(`${outcome}  ${label}${detail ? ` — ${detail}` : ""}`);
};

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

const state = async (tx: Tx, id: string) =>
    ((await tx.execute(sql`
        SELECT lead_status, last_worked_at::text AS last_worked_at, lost_reason FROM dealer_leads WHERE id = ${id}
    `)) as unknown as Array<{ lead_status: string; last_worked_at: string | null; lost_reason: string | null }>)[0];

async function pick(where: ReturnType<typeof sql>): Promise<Lead | undefined> {
    return ((await db.execute(sql`
        SELECT id, lead_status, current_owner_id::text AS current_owner_id, last_worked_at::text AS last_worked_at
          FROM dealer_leads WHERE is_active IS NOT FALSE AND ${where}
         ORDER BY updated_at DESC LIMIT 1
    `)) as unknown as Lead[])[0];
}

async function main() {
    console.log("database:", new URL(process.env.DATABASE_URL!).host.split(".")[0], "\n");

    // ── 1. the log API cannot be asked for a status ───────────────────────
    const fresh = await pick(sql`lead_status = 'Assigned_Not_Contacted' AND current_owner_id IS NOT NULL`);
    if (!fresh) {
        say("SKIP", "point 1 — no Assigned_Not_Contacted lead with an owner");
    } else {
        for (const [label, body] of [
            ["a note that asks for Under discussion", { touchpoint_type: "status_change_note", remarks: "spoke to the dealer" }],
            ["a WhatsApp entry that asks for Under discussion", { touchpoint_type: "whatsapp", remarks: "chatted" }],
            ["a call with no outcome that asks for Under discussion", { touchpoint_type: "inside_sales_call", call_status: "connected" }],
        ] as const) {
            await rolledBack(async (tx) => {
                const res = await logLeadTouchpoint(
                    {
                        leadId: fresh.id,
                        actorId: fresh.current_owner_id!,
                        body: { ...body, status_change: { to: "Under_Discussion", reason_notes: "asked by hand" } } as never,
                    },
                    { tx },
                );
                const after = await state(tx, fresh.id);
                const ok = after.lead_status === "Assigned_Not_Contacted" && res.historyId === null && !!res.touchpointId;
                say(ok ? "PASS" : "FAIL", `point 1 — ${label}: saved, status unchanged`, `status ${after.lead_status}, history row ${res.historyId ?? "none"}`);
            });
        }
        // The event that DOES earn first contact still works.
        await rolledBack(async (tx) => {
            const res = await logLeadTouchpoint(
                {
                    leadId: fresh.id,
                    actorId: fresh.current_owner_id!,
                    body: { touchpoint_type: "inside_sales_call", disposition: { connect_status: "connected", label: "As to Call Back", bucket: "Warm" } } as never,
                },
                { tx },
            );
            const after = await state(tx, fresh.id);
            say(
                after.lead_status === "Under_Discussion" && res.historyId !== null ? "PASS" : "FAIL",
                "point 1 — a connected call with its outcome moves the lead to Under discussion",
                `status ${after.lead_status}`,
            );
        });
    }

    // ── a visit cannot be asked for a status either (gap check, 01 Oct) ────
    if (fresh) {
        for (const [outcome, expected] of [
            ["dealer_not_present", "Assigned_Not_Contacted"],
            ["productive", "Under_Discussion"],
        ] as const) {
            await rolledBack(async (tx) => {
                const res = await applyVisitStatus(tx, {
                    leadId: fresh.id,
                    actorId: fresh.current_owner_id!,
                    // A hand-crafted request asking for first contact.
                    requested: "Under_Discussion",
                    outcome,
                    interest: null,
                    remarks: "verify script",
                });
                const after = await state(tx, fresh.id);
                say(
                    after.lead_status === expected ? "PASS" : "FAIL",
                    `visit — outcome "${outcome}" with Under discussion asked for → ${expected.replace(/_/g, " ")}`,
                    `status ${after.lead_status}, history row ${res.historyId ?? "none"}`,
                );
            });
        }
    }

    // ── 3. Correct status ─────────────────────────────────────────────────
    const worked = await pick(sql`lead_status = 'Under_Discussion' AND last_worked_at IS NOT NULL`);
    const anyOpen = worked ?? (await pick(sql`lead_status = 'Under_Discussion'`));
    if (!anyOpen) {
        say("SKIP", "point 3 — no Under_Discussion lead");
    } else {
        await rolledBack(async (tx) => {
            const before = await state(tx, anyOpen.id);
            const res = await writeTouchpoint(
                {
                    dealerLeadId: anyOpen.id,
                    touchpointType: "status_change_note",
                    performedBy: null,
                    remarks: "Status corrected by admin — verify script",
                    statusChange: {
                        from: before.lead_status as never,
                        to: "Assigned_Not_Contacted",
                        reasonNotes: "Correct status: verify script",
                        closingRole: "admin",
                        event: "correction",
                    },
                },
                { tx },
            );
            const after = await state(tx, anyOpen.id);
            say(
                after.lead_status === "Assigned_Not_Contacted" && res.historyId !== null ? "PASS" : "FAIL",
                "point 3 — a correction may move a lead backwards, and is logged",
                `${before.lead_status} → ${after.lead_status}`,
            );
            say(
                after.last_worked_at === before.last_worked_at ? "PASS" : "FAIL",
                "point 3 — a correction does not reset the idle clock",
                `last worked ${before.last_worked_at ?? "never"} → ${after.last_worked_at ?? "never"}`,
            );
        });

        // Mark Lost (same touchpoint type, a real event) still counts as work.
        await rolledBack(async (tx) => {
            const before = await state(tx, anyOpen.id);
            await writeTouchpoint(
                {
                    dealerLeadId: anyOpen.id,
                    touchpointType: "status_change_note",
                    performedBy: null,
                    statusChange: { from: before.lead_status as never, to: "Lost", toLostReason: "price_high", event: "mark_lost" },
                },
                { tx },
            );
            const after = await state(tx, anyOpen.id);
            say(
                after.last_worked_at !== before.last_worked_at ? "PASS" : "FAIL",
                "point 3 — Mark Lost still counts as working the lead",
                `last worked ${before.last_worked_at ?? "never"} → ${after.last_worked_at ?? "never"}`,
            );
        });
    }

    // ID 136: nobody picks a status by hand any more — the route is gone.
    say(
        existsSync("src/app/api/admin/leads/[id]/correct-status/route.ts") ? "FAIL" : "PASS",
        "ID 136 — the Correct status route no longer exists",
    );

    console.log(failed ? `\n${failed} FAILED` : "\nall checks passed");
}

main()
    .catch((e) => {
        console.error(e);
        failed += 1;
    })
    .finally(() => process.exit(failed ? 1 : 0));
