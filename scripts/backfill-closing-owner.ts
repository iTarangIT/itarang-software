/**
 * One-off correction for tracker ID 117 / handover P0-13 (29 Sep 2026; reworked
 * 01 Oct after the 30 Sep review).
 *
 *   node --import tsx --env-file=.env.local scripts/backfill-closing-owner.ts          # dry run
 *   node --import tsx --env-file=.env.local scripts/backfill-closing-owner.ts --apply  # write
 *
 * Until 29 Sep, writeTouchpoint stamped closing_owner_id with whoever pressed
 * Mark Converted / Mark Lost — an admin closing a rep's lead took the credit.
 * The rule now: credit goes to the OWNER who held the lead when it closed, and
 * never moves with a later reassignment.
 *
 * WHO HELD IT THEN is decided by ownerAtClose() (src/lib/leads/closingOwner.ts,
 * unit-tested) on the facts closedLeadVerdicts() reads
 * (src/lib/leads/closingOwnerFacts.ts). A "move" is anything that changes who
 * holds a lead: an ownership hop (from / to owner recorded, E-295) or an
 * assign / claim / transfer / reassign touchpoint. Moves logged before E-295
 * carry NO from / to, so a recorded hop is trusted only where no unrecorded
 * move stands between it and the close. One kind of old move CAN be read: a
 * transfer to an ASM wrote the ASM's visit row alongside it, which names the
 * recipient. In order:
 *   1. not_moved_since  nothing moved the lead after it closed: whoever holds
 *                       it now held it then. (If the last recorded hop before
 *                       the close names someone else, the two disagree and the
 *                       lead is treated as unknown.)
 *   2. hop_after        the FIRST move after the close recorded who the lead
 *                       was taken from, i.e. who held it at the close.
 *   3. hop_before       the LAST move at or before the close recorded who
 *                       received it.
 *   4. unknown          anything else. Nothing is guessed: the lead is listed
 *                       and its closing owner left as it is.
 * The first version used "latest recorded hop before the close" alone and fell
 * back to the current owner. Both were wrong for a lead claimed by a rep,
 * transferred to an ASM before hops were recorded, converted by the ASM and
 * later handed back: it would have moved the ASM's conversion to the rep.
 *
 * Only rows whose closing owner differs from the answer are touched. Every
 * corrected lead gets a system note in its history saying what changed and
 * why. Dry run by default; a re-run after --apply finds nothing to do.
 *
 * THE RECORD THAT IT RAN: every --apply run — including one that finds nothing
 * to correct — writes scripts/_backfill-closing-owner.<database>.<timestamp>.json
 * (git-ignored) with the counts by evidence, each corrected lead with its old
 * and new closing owner, and the leads left alone. The old values in that file
 * are what a manual undo needs.
 */
import { writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import type { CloseEvidence } from "../src/lib/leads/closingOwner";
import { closedLeadVerdicts } from "../src/lib/leads/closingOwnerFacts";

async function main() {
    const apply = process.argv.includes("--apply");
    const host = new URL(process.env.DATABASE_URL ?? "postgres://x@unknown/x").host.split(".")[0];
    console.log(`DB host: ${host}${apply ? "  (APPLY)" : "  (dry run)"}`);

    const rows = await closedLeadVerdicts();
    const names = new Map<string, string | null>(
        ((await db.execute<{ id: string; name: string | null }>(sql`SELECT id::text AS id, name FROM users`)) as unknown as {
            id: string;
            name: string | null;
        }[]).map((u) => [u.id, u.name]),
    );
    const who = (id: string | null) => (id ? (names.get(id) ?? id) : "(none)");

    const count = (pred: (r: (typeof rows)[number]) => boolean) => rows.filter(pred).length;
    console.table(
        (["not_moved_since", "hop_after", "hop_before", "unknown"] as CloseEvidence[]).map((e) => ({
            evidence: e,
            leads: count((r) => r.evidence === e),
            to_correct: count((r) => r.evidence === e && !!r.owner_at_close && r.owner_at_close !== r.closing_owner_id),
        })),
    );

    const fix = rows.filter((r) => r.owner_at_close && r.owner_at_close !== r.closing_owner_id);
    const unknown = rows.filter((r) => r.evidence === "unknown");
    console.log(`${rows.length} Won / Converted / Lost leads; ${fix.length} credited to someone other than the owner at close`);
    for (const r of fix.slice(0, 40)) {
        console.log(`  ${r.id} ${r.lead_status}: ${who(r.closing_owner_id)} → ${who(r.owner_at_close)}  [${r.evidence}]`);
    }
    if (unknown.length) {
        console.log(`${unknown.length} left alone — no evidence of who held the lead when it closed (decide by hand):`);
        for (const r of unknown.slice(0, 40)) {
            console.log(`  ${r.id} ${r.lead_status}: closing owner ${who(r.closing_owner_id)}`);
        }
    }
    if (!apply) {
        console.log("Dry run. Re-run with --apply to write.");
        process.exit(0);
    }

    let updated = 0;
    const corrected: Array<{ id: string; lead_status: string | null; from: string | null; to: string | null; evidence: string }> = [];
    for (const r of fix) {
        await db.transaction(async (tx) => {
            const changed = await tx.execute(sql`
                UPDATE dealer_leads SET closing_owner_id = ${r.owner_at_close}
                 WHERE id = ${r.id} AND closing_owner_id IS DISTINCT FROM ${r.owner_at_close}
                RETURNING id
            `);
            if (changed.length === 0) return;
            // The record that this ran. A plain INSERT, not writeTouchpoint: a
            // correction is not activity and must not move the lead's
            // last-activity or idle clocks.
            await tx.execute(sql`
                INSERT INTO lead_touchpoints
                    (dealer_lead_id, touchpoint_type, performed_by, performed_at, remarks, sync_method)
                VALUES (${r.id}, 'status_change_note', NULL, NOW(),
                        ${`Closing owner corrected: ${who(r.closing_owner_id)} → ${who(r.owner_at_close)} — the owner when the lead closed (${r.evidence.replace(/_/g, " ")}). Tracker ID 117.`},
                        'system')
            `);
            updated += 1;
            corrected.push({
                id: r.id,
                lead_status: r.lead_status,
                from: r.closing_owner_id,
                to: r.owner_at_close,
                evidence: r.evidence,
            });
        });
    }
    console.log(`Updated ${updated}. Each corrected lead has a note in its history.`);

    const ranAt = new Date().toISOString();
    const file = `scripts/_backfill-closing-owner.${host}.${ranAt.replace(/[:.]/g, "-")}.json`;
    writeFileSync(
        file,
        JSON.stringify(
            {
                database: host,
                ran_at: ranAt,
                closed_leads: rows.length,
                by_evidence: Object.fromEntries(
                    (["not_moved_since", "hop_after", "hop_before", "unknown"] as CloseEvidence[]).map((e) => [
                        e,
                        count((r) => r.evidence === e),
                    ]),
                ),
                corrected,
                left_alone_unknown: unknown.map((r) => ({ id: r.id, lead_status: r.lead_status, closing_owner_id: r.closing_owner_id })),
            },
            null,
            2,
        ),
    );
    console.log(`Run record saved to ${file}`);
    process.exit(0);
}

void main();
