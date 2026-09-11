/**
 * E-295 — read-only verifier for Lead Tracking.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-lead-tracking.ts [LEAD-ID ...]
 *
 * Prints the host, checks whether E-295's columns exist, then runs the REAL
 * builder (src/lib/leads/tracking.ts) on the leads with the most ownership
 * touchpoints (or the ids given) and asserts the invariants the panel and the
 * CSV rely on:
 *   - episodes tile the lead's life: first starts at created_at, each next
 *     starts where the previous ended, only the last is open;
 *   - the open episode's holder is the lead's current owner (or the pool);
 *   - durations sum to the lead's age (±2s of rounding);
 *   - every event maps to an existing episode and the per-episode counters
 *     add up to the event count;
 *   - the CSV has exactly Σ(episodes + events) rows and the header contract.
 * Nothing is written.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { buildLeadTracking } from "@/lib/leads/tracking";
import { buildTrackingCsvRows, TRACKING_CSV_COLUMNS } from "@/lib/leads/trackingCsv";
import { fmtDuration } from "@/lib/leads/trackingTypes";

let failures = 0;
function check(cond: boolean, msg: string) {
    if (cond) console.log(`  ✅ ${msg}`);
    else {
        failures++;
        console.log(`  ❌ ${msg}`);
    }
}

async function main() {
    const url = process.env.DATABASE_URL ?? "";
    console.log(`HOST: ${url ? new URL(url).host : "(DATABASE_URL unset)"}`);

    const cols = (await db.execute<{ column_name: string }>(sql`
        SELECT column_name FROM information_schema.columns
         WHERE table_name = 'lead_touchpoints'
           AND column_name IN ('from_owner_id', 'to_owner_id')
    `)) as unknown as { column_name: string }[];
    const applied = cols.length === 2;
    console.log(
        applied
            ? "E-295 columns present on lead_touchpoints."
            : "⚠ E-295 NOT applied here — every hop will read as 'Not recorded' / approximate.",
    );

    let ids = process.argv.slice(2);
    if (ids.length === 0) {
        const rows = (await db.execute<{ id: string; n: string }>(sql`
            SELECT t.dealer_lead_id AS id, count(*) AS n
              FROM lead_touchpoints t
              -- Touchpoints can outlive their lead (hard deletes); only leads
              -- that still exist can be tracked.
              JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
             WHERE t.touchpoint_type IN ('lead_assigned','lead_claimed','ownership_transfer','asm_transfer',
                                         'escalation_resolved_reassign','reactivated_via_admin',
                                         'reactivated_via_upload','reactivated_via_ai_dialer',
                                         'onboarding_dropout_action')
             GROUP BY t.dealer_lead_id
             ORDER BY count(*) DESC
             LIMIT 5
        `)) as unknown as { id: string; n: string }[];
        ids = rows.map((r) => r.id);
        console.log(`Picked ${ids.length} lead(s) with the most hand-offs: ${rows.map((r) => `${r.id} (${r.n})`).join(", ")}`);
    }
    if (ids.length === 0) {
        console.log("No leads with ownership touchpoints — nothing to verify.");
        return;
    }

    const trackings = await buildLeadTracking(ids);
    check(trackings.size === ids.length, `builder returned ${trackings.size}/${ids.length} leads`);

    for (const [id, t] of trackings) {
        console.log(`\n── ${id} · ${t.lead.dealer_name ?? "(unnamed)"} · ${t.lead.lead_status ?? "no status"}`);
        const eps = t.episodes;
        for (const e of eps) {
            console.log(
                `   #${e.seq} ${e.holder.name}${e.holder.role ? ` (${e.holder.role})` : ""}` +
                    ` · ${fmtDuration(e.duration_sec)} · ${e.from_at} → ${e.to_at ?? "now"}` +
                    `${e.handed_by ? ` · by ${e.handed_by.name}` : ""}${e.approximate ? " · approx" : ""}` +
                    ` · ${e.actions_count} action(s)`,
            );
        }
        check(eps.length >= 1, "at least one episode");
        check(eps[0]!.from_at === t.lead.created_at, "episode 0 starts at created_at");
        let contiguous = true;
        for (let i = 1; i < eps.length; i++) {
            if (eps[i]!.from_at !== eps[i - 1]!.to_at) contiguous = false;
        }
        check(contiguous, "episodes are contiguous");
        check(eps.slice(0, -1).every((e) => e.to_at != null) && eps[eps.length - 1]!.to_at == null,
            "only the last episode is open");
        const live = eps[eps.length - 1]!;
        const owner = t.lead.current_owner;
        check(live.holder.id === owner.id, `open episode holder (${live.holder.name}) = current owner (${owner.name})`);
        const sum = eps.reduce((s, e) => s + e.duration_sec, 0);
        check(Math.abs(sum - t.lead.age_sec) <= 2, `durations sum to lead age (${sum}s vs ${t.lead.age_sec}s)`);
        check(t.events.every((ev) => eps[ev.episode_seq] != null), "every event maps to an episode");
        const counted = eps.reduce((s, e) => s + e.actions_count, 0);
        check(counted === t.events.length, `episode counters add up (${counted} = ${t.events.length})`);
        check(t.lead.handoffs === eps.length - 1, "handoffs = episodes − 1");
        if (applied) {
            const unrecorded = eps.filter((e) => e.holder.name === "Not recorded").length;
            console.log(`   ${unrecorded} episode(s) with an unrecorded recipient (pre-E-295 hops)`);
        }
    }

    const rows = buildTrackingCsvRows([...trackings.values()]);
    const expected = [...trackings.values()].reduce((s, t) => s + t.episodes.length + t.events.length, 0);
    check(rows.length === expected, `CSV rows = Σ(episodes + events) (${rows.length} = ${expected})`);
    check(TRACKING_CSV_COLUMNS[0]!.header === "Row Type", "CSV leads with Row Type");
    check(rows.every((r) => r.row_type === "HOLD" || r.row_type === "ACTION"), "every row is HOLD or ACTION");

    console.log(failures === 0 ? "\nALL GREEN" : `\n${failures} check(s) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
