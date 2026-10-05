// Read-only check and dry run for tracker ID 122 — the onboarding stalled /
// drop-out clock.
//
//   node --import tsx --env-file=.env.local scripts/verify-id122-onboarding-clock.ts
//
// Prints, for the database DATABASE_URL points at:
//   1. whether E-327 is applied (the sweep's column and the three triggers);
//   2. what E-328 would do — how many applications get a new "last real
//      action" date and how far their clock moves;
//   3. how many OPEN applications are past 7 and 21 days on the clock today
//      and after E-328, so the jump in "stalled" / "drop-out review" is known
//      before it appears on the dashboard.
//
// The dry run executes the SAME statement E-328 runs — it reads the `facts`
// query out of the migration file rather than restating it. Changes nothing.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import postgres from "postgres";

import { onboardingClockSql } from "../src/lib/onboarding/clock";

function factsQuery(): string {
    const file = readFileSync(join(process.cwd(), "drizzle", "E-328_onboarding_last_action_backfill.sql"), "utf8");
    const start = file.indexOf("WITH facts AS (");
    const end = file.indexOf("UPDATE dealer_onboarding_applications oa", start);
    if (start < 0 || end < 0) throw new Error("could not find the facts query in E-328");
    return file.slice(start, end);
}

async function main() {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    console.log("target:", new URL(url).host);
    const sql = postgres(url, { max: 1, ssl: "require" });
    const clock = onboardingClockSql("oa");
    let failed = 0;
    const say = (ok: boolean, label: string, detail = "") => {
        if (!ok) failed++;
        console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
    };

    try {
        // 1. E-327
        const [col] = await sql`
            SELECT count(*)::int AS n FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'dealer_onboarding_applications'
               AND column_name = 'agreement_last_checked_at'`;
        say(col.n === 1, "E-327: agreement_last_checked_at exists");
        const triggers = (await sql`
            SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgenabled <> 'D'
               AND tgname IN ('dealer_onboarding_last_action', 'dealer_onboarding_documents_last_action',
                              'dealer_correction_rounds_last_action')`).map((r) => r.tgname);
        for (const t of ["dealer_onboarding_last_action", "dealer_onboarding_documents_last_action", "dealer_correction_rounds_last_action"]) {
            say(triggers.includes(t), `E-327: trigger ${t} is installed and enabled`);
        }

        // 2. what E-328 would do
        const [dry] = await sql.unsafe(`
            ${factsQuery()}
            SELECT count(*)::int AS total,
                   count(*) FILTER (WHERE oa.last_action_at IS NULL)::int AS never_set,
                   count(*) FILTER (WHERE oa.last_action_at IS NULL OR oa.last_action_at < f.real_action_at)::int AS would_change,
                   count(*) FILTER (WHERE ${clock} > f.real_action_at + INTERVAL '1 day'
                                      AND (oa.last_action_at IS NULL OR oa.last_action_at < f.real_action_at))::int AS clock_was_too_fresh,
                   count(*) FILTER (WHERE ${clock} < f.real_action_at - INTERVAL '1 day')::int AS clock_was_too_old
              FROM dealer_onboarding_applications oa
              JOIN facts f ON f.id = oa.id`);
        console.log(`INFO  ${dry.total} application(s); last_action_at never set on ${dry.never_set}`);
        console.log(`INFO  E-328 would set last_action_at on ${dry.would_change}`);
        console.log(`INFO  of those, the clock today is more than a day TOO FRESH on ${dry.clock_was_too_fresh} (never showed stalled)`);
        console.log(`INFO  the clock today is more than a day TOO OLD on ${dry.clock_was_too_old} (showed stalled while active)`);


        // 3. the effect on the two lists, for applications still open
        const [effect] = await sql.unsafe(`
            ${factsQuery()}
            SELECT count(*)::int AS open,
                   count(*) FILTER (WHERE ${clock} < NOW() - INTERVAL '7 days')::int AS past7_now,
                   count(*) FILTER (WHERE GREATEST(oa.last_action_at, f.real_action_at) < (NOW() AT TIME ZONE 'UTC') - INTERVAL '7 days')::int AS past7_after,
                   count(*) FILTER (WHERE ${clock} < NOW() - INTERVAL '21 days')::int AS past21_now,
                   count(*) FILTER (WHERE GREATEST(oa.last_action_at, f.real_action_at) < (NOW() AT TIME ZONE 'UTC') - INTERVAL '21 days')::int AS past21_after
              FROM dealer_onboarding_applications oa
              JOIN facts f ON f.id = oa.id
             WHERE oa.onboarding_status IN ('draft', 'submitted', 'correction_requested')`);
        console.log(`INFO  open applications: ${effect.open}`);
        console.log(`INFO  idle 7+ days:  ${effect.past7_now} today → ${effect.past7_after} after E-328`);
        console.log(`INFO  idle 21+ days: ${effect.past21_now} today → ${effect.past21_after} after E-328`);
    } finally {
        await sql.end();
    }
    console.log(failed ? `\n${failed} FAILED` : "\nall checks passed");
    process.exit(failed ? 1 : 0);
}

main();
