// End-to-end proof of the E-237 claim: a lead handed to a NeoDove campaign
// ends up in the assigned rep's /inside-sales "My Open Leads".
//
//   node --import tsx --env-file=.env.local scripts/verify-e237-assignment.ts
//
// Exercises the REAL code path (assignAfterPush → assignLeadOwner →
// writeTouchpoint) rather than re-implementing it, so a regression in any of the
// three fails this script. It deliberately does NOT push to NeoDove: the CRM
// half is what is being proved, and consuming lead quota to prove it would be a
// poor trade.
//
// ⚠ THE REVERT IS ID-SCOPED, AND THAT IS NOT A DETAIL. An earlier version of
// this script reverted with `DELETE FROM lead_touchpoints WHERE dealer_lead_id =
// $lead`, which is correct ONLY if the lead had no history before the test — and
// the lead it picked had four NeoDove dispositions on it. It destroyed them.
// A test that cleans up by table+lead cannot tell its own rows from real ones,
// so this version snapshots the exact ids that exist beforehand and deletes only
// what it created. Never widen these WHERE clauses.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { assignAfterPush } from "@/lib/neodove/assignAfterPush";
import { resolveAssignTarget } from "@/lib/leads/assignOwner";

const OPEN_STATUSES = [
    "New_Unassigned", "Assigned_Not_Contacted", "Under_Discussion",
    "Commercials_Explained", "Commercials_Finalised",
    "Awaiting_Customer_Decision", "Transferred_to_ASM",
];

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
    const ok = String(actual) === String(expected);
    if (!ok) failures++;
    console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
}

async function myOpenCount(userId: string): Promise<number> {
    const r = await db.execute<{ count: string }>(sql`
        SELECT COUNT(*)::text AS count FROM dealer_leads dl
         WHERE dl.current_owner_id = ${userId}
           AND dl.lead_status IN (${sql.join(OPEN_STATUSES.map((s) => sql`${s}`), sql`, `)})
           AND dl.is_active IS NOT FALSE`);
    return Number(r[0]?.count ?? 0);
}

async function dialableCount(): Promise<number> {
    const r = await db.execute<{ count: string }>(sql`
        SELECT COUNT(*)::text AS count FROM dealer_leads dl
         WHERE (dl.lead_status IS NULL AND (dl.ai_recall_status IS NULL OR dl.ai_recall_status <> 'excluded'))
            OR (dl.lead_status = 'Lost' AND dl.ai_recall_status = 'awaiting_re_dial')`);
    return Number(r[0]?.count ?? 0);
}

/**
 * Both assignable roles are exercised, because they take DIFFERENT branches of
 * assignLeadOwner and land the lead in different workspaces. Testing only the
 * inside-sales path would leave the ASM path — added later, and the one whose
 * semantics are the more surprising of the two — entirely unverified.
 */
async function runScenario(role: "inside_sales_rep" | "asm") {
    const expectedStatus =
        role === "asm" ? "Transferred_to_ASM" : "Assigned_Not_Contacted";
    const expectedTouchpoint = role === "asm" ? "asm_transfer" : "lead_assigned";

    console.log(`\n${"=".repeat(64)}\nSCENARIO: ${role}\n${"=".repeat(64)}`);

    const reps = await db.execute<{ id: string; name: string | null }>(sql`
        SELECT id::text AS id, name FROM users
         WHERE LOWER(role) = ${role} AND is_active ORDER BY name LIMIT 1`);
    if (!reps[0]) throw new Error(`No active ${role} to test with.`);
    const rep = reps[0];

    const camps = await db.execute<{ id: string; label: string }>(sql`
        SELECT id, COALESCE(neodove_campaign_name, name) AS label
          FROM neodove_campaigns ORDER BY created_at DESC LIMIT 1`);
    if (!camps[0]) throw new Error("No NeoDove campaign to test with.");
    const camp = camps[0];

    const leads = await db.execute<{ id: string; dealer_name: string | null }>(sql`
        SELECT id, dealer_name FROM dealer_leads dl
         WHERE dl.lead_status IS NULL AND dl.current_owner_id IS NULL
           AND dl.originator_id IS NULL AND dl.is_active IS NOT FALSE
           AND regexp_replace(dl.phone,'\\D','','g') ~ '[6-9][0-9]{9}$'
         LIMIT 1`);
    if (!leads[0]) throw new Error("No unowned NULL-status lead to test with.");
    const lead = leads[0];

    console.log(`Rep      : ${rep.name} (${rep.id})`);
    console.log(`Campaign : ${camp.label} (${camp.id})`);
    console.log(`Lead     : ${lead.id} ${lead.dealer_name ?? ""}\n`);

    // ── Snapshot everything the test could disturb ───────────────────────
    const before = await db.execute<{
        lead_status: string | null;
        current_owner_id: string | null;
        originator_id: string | null;
        asm_id: string | null;
        pre_transfer_status: string | null;
        assigned_at: string | null;
        last_touchpoint_at: string | null;
    }>(sql`
        SELECT lead_status, current_owner_id, originator_id, asm_id,
               pre_transfer_status, assigned_at::text, last_touchpoint_at::text
          FROM dealer_leads WHERE id = ${lead.id}`);
    const snap = before[0];

    const priorTps = await db.execute<{ id: string }>(sql`
        SELECT touchpoint_id::text AS id FROM lead_touchpoints WHERE dealer_lead_id = ${lead.id}`);
    const priorHist = await db.execute<{ id: string }>(sql`
        SELECT history_id::text AS id FROM dealer_lead_status_history WHERE dealer_lead_id = ${lead.id}`);
    const priorTpIds = new Set(priorTps.map((r) => r.id));
    const priorHistIds = new Set(priorHist.map((r) => r.id));
    console.log(`Pre-existing: ${priorTpIds.size} touchpoint(s), ${priorHistIds.size} history row(s) — will be preserved\n`);

    const openBefore = await myOpenCount(rep.id);
    const dialBefore = await dialableCount();
    console.log(`BEFORE   my_open=${openBefore}  ai_dialable=${dialBefore}\n`);

    const target = await resolveAssignTarget(rep.id);
    if (!target.ok) throw new Error(target.message);

    const assigned = await assignAfterPush({
        leadId: lead.id,
        campaignId: camp.id,
        target: target.target,
        actorId: rep.id,
        actorRole: "admin",
        campaignLabel: camp.label,
    });

    console.log("ASSERTIONS");
    check("assignAfterPush returned", assigned, true);

    const after = await db.execute<{
        lead_status: string | null;
        current_owner_id: string | null;
        originator_id: string | null;
        asm_id: string | null;
        assigned_at: string | null;
    }>(sql`
        SELECT lead_status, current_owner_id, originator_id, asm_id, assigned_at::text
          FROM dealer_leads WHERE id = ${lead.id}`);
    check("lead_status", after[0]?.lead_status, expectedStatus);
    check("current_owner_id", after[0]?.current_owner_id, rep.id);
    check("assigned_at set", after[0]?.assigned_at !== null, true);
    if (role === "asm") {
        // The ASM workspace filters on asm_id as well as ownership, so an ASM
        // assignment that sets only current_owner_id would still be invisible.
        check("asm_id", after[0]?.asm_id, rep.id);
        check("originator_id untouched", after[0]?.originator_id, snap.originator_id);
    } else {
        check("originator_id", after[0]?.originator_id, rep.id);
    }

    // Only the rows this run created — the lead may legitimately have history.
    const newTps = (await db.execute<{
        id: string; touchpoint_type: string; external_system: string | null; performed_by: string | null;
    }>(sql`
        SELECT touchpoint_id::text AS id, touchpoint_type, external_system, performed_by
          FROM lead_touchpoints WHERE dealer_lead_id = ${lead.id}`))
        .filter((r) => !priorTpIds.has(r.id));
    check("new touchpoint rows", newTps.length, 1);
    check("touchpoint_type", newTps[0]?.touchpoint_type, expectedTouchpoint);
    check("external_system", newTps[0]?.external_system, "neodove");
    check("performed_by", newTps[0]?.performed_by, rep.id);

    const newHist = (await db.execute<{ id: string; from_status: string | null; to_status: string | null }>(sql`
        SELECT history_id::text AS id, from_status, to_status
          FROM dealer_lead_status_history WHERE dealer_lead_id = ${lead.id}`))
        .filter((r) => !priorHistIds.has(r.id));
    check("new status history rows", newHist.length, 1);
    check("from_status", newHist[0]?.from_status, "New_Unassigned");
    check("to_status", newHist[0]?.to_status, expectedStatus);

    const openAfter = await myOpenCount(rep.id);
    const dialAfter = await dialableCount();
    // Transferred_to_ASM is one of the seven OPEN_STATUSES, so this counts for
    // both roles — it is the "does it show up on their workspace" assertion.
    check("workspace queue +1 (THE GOAL)", openAfter, openBefore + 1);
    check("ai_dialable -1", dialAfter, dialBefore - 1);

    // ── Revert — ONLY the ids this run created ───────────────────────────
    for (const r of newHist) {
        await db.execute(sql`DELETE FROM dealer_lead_status_history WHERE history_id = ${r.id}::uuid`);
    }
    for (const r of newTps) {
        await db.execute(sql`DELETE FROM lead_touchpoints WHERE touchpoint_id = ${r.id}::uuid`);
    }
    await db.execute(sql`
        UPDATE dealer_leads
           SET lead_status = ${snap.lead_status},
               current_owner_id = ${snap.current_owner_id},
               originator_id = ${snap.originator_id},
               asm_id = ${snap.asm_id},
               pre_transfer_status = ${snap.pre_transfer_status},
               assigned_at = ${snap.assigned_at}::timestamptz,
               last_touchpoint_at = ${snap.last_touchpoint_at}::timestamptz
         WHERE id = ${lead.id}`);
    await db.execute(sql`
        UPDATE neodove_lead_links SET assigned_owner_id = NULL, assigned_at = NULL
         WHERE dealer_lead_id = ${lead.id} AND neodove_campaign_id = ${camp.id}`);

    console.log("\nREVERTED");
    check("my_open restored", await myOpenCount(rep.id), openBefore);
    check("ai_dialable restored", await dialableCount(), dialBefore);
    const tpNow = await db.execute<{ n: string }>(sql`
        SELECT COUNT(*)::text AS n FROM lead_touchpoints WHERE dealer_lead_id = ${lead.id}`);
    check("prior touchpoints untouched", tpNow[0]?.n, priorTpIds.size);

}

async function main() {
    await runScenario("inside_sales_rep");
    await runScenario("asm");
    console.log(
        failures === 0
            ? "\nALL CHECKS PASSED (both roles)"
            : `\n${failures} CHECK(S) FAILED`,
    );
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error("ERROR:", e);
    process.exit(1);
});
