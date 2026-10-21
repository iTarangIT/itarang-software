/**
 * One-time fix for tracker ID 189 (Kartik, 18 Oct): every target a rep
 * REJECTED under the old flow (14–16 Oct) goes back to that rep as PUSHED,
 * with the same numbers, a bell and an email, so the rep accepts it or asks
 * for a correction. There is no reject any more, so until then those rows sit
 * in 'rejected' — counted by the CEO tiles (companyTarget inForce) but not by
 * the daily email or the Sales Head's scorecard (pushed / accepted only), and
 * the totals disagree.
 *
 *   node --import tsx --env-file=.env.local scripts/backfill-targets-repush-rejected.ts               # dry run
 *   node --import tsx --env-file=.env.local scripts/backfill-targets-repush-rejected.ts --apply       # write
 *
 * Options:
 *   --actor <user id | email>   who the push is from (Sales Head or admin; the
 *                               notice reads "<name> sent you n targets"). Default:
 *                               the one active sales_head — refused if there are
 *                               several and none is named.
 *   --month YYYY-MM             only that month (default: every month)
 *   --keep-clock                keep the 48-hour clock from the FIRST push (the
 *                               clockAfterPush rule). Default: the clock starts at
 *                               this push — the rep had no way to accept before.
 *
 * HOW: the app's own push, sendToMember() (src/lib/targets/service.ts) — it
 * already takes 'rejected' rows — so the status, version, history row
 * ('pushed', noted as this fix), bell and email are exactly what the Sales
 * Head's "Approve & push" does. One notice per rep per month.
 *
 * SAME NUMBERS: a rejected row with a revision waiting for the push
 * (next_ceo_target / next_stretch) would go out with the NEW numbers, so it is
 * held and listed — push it from the register after a look. A row of an
 * inactive user is held too.
 *
 * Dry run = SELECTs only. Idempotent: after --apply the rows are 'pushed', so a
 * re-run finds nothing to do.
 */
import { sql } from "drizzle-orm";

import { db } from "../src/lib/db";
import { isTargetMetric, TARGET_METRICS } from "../src/lib/targets/rules";
import { finalTargetSql } from "../src/lib/targets/sql";

const WHY = "These are the targets you rejected under the old flow, sent to you again with the same numbers.";

function arg(name: string): string | null {
    const i = process.argv.indexOf(name);
    return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

type Rejected = {
    id: string;
    month: string;
    user_id: string;
    user_name: string | null;
    user_active: boolean | null;
    metric: string;
    custom_label: string | null;
    ceo: number;
    stretch: number;
    final: number;
    rejected_at: string | null;
    reject_comment: string | null;
    next_ceo: number | null;
    next_stretch: number | null;
    first_pushed_at: string | null;
};

const label = (r: { metric: string; custom_label: string | null }) =>
    isTargetMetric(r.metric) ? TARGET_METRICS[r.metric].label : (r.custom_label ?? r.metric);

async function totals(months: string[]) {
    if (!months.length) return [];
    return (await db.execute(sql`
        SELECT t.month::text AS month, t.metric, to_jsonb(t) ->> 'custom_label' AS custom_label,
               COALESCE(SUM(${finalTargetSql(sql`t`)}) FILTER (WHERE t.status IN ('pushed', 'accepted')), 0)::float8 AS email,
               COALESCE(SUM(${finalTargetSql(sql`t`)}) FILTER (WHERE t.status IN ('pending_approval', 'pushed', 'accepted', 'rejected')), 0)::float8 AS ceo_tiles,
               COALESCE(SUM(${finalTargetSql(sql`t`)}) FILTER (WHERE t.status = 'rejected'), 0)::float8 AS rejected,
               COALESCE(SUM(${finalTargetSql(sql`t`)}) FILTER (WHERE t.status = 'pending_approval'), 0)::float8 AS posted_not_pushed
          FROM sales_targets t
         WHERE t.month::text IN (${sql.join(months.map((m) => sql`${m}`), sql`, `)})
         GROUP BY 1, 2, 3
         ORDER BY 1, 2
    `)) as unknown as Array<{ month: string; metric: string; custom_label: string | null; email: number; ceo_tiles: number; rejected: number; posted_not_pushed: number }>;
}

async function resolveActor(given: string | null): Promise<{ id: string; role: string; name: string } | { error: string }> {
    const rows = (await db.execute(sql`
        SELECT id::text AS id, role, COALESCE(name, email) AS name, email
          FROM users
         WHERE is_active = TRUE
           AND ${given ? sql`(id::text = ${given} OR lower(email) = lower(${given}))` : sql`role = 'sales_head'`}
    `)) as unknown as Array<{ id: string; role: string; name: string; email: string | null }>;
    if (given) {
        const u = rows[0];
        if (!u) return { error: `--actor ${given}: no active user with that id or email.` };
        if (!["sales_head", "admin"].includes((u.role ?? "").toLowerCase())) {
            return { error: `--actor ${given} is a ${u.role}; the push is the Sales Head's (or an admin's).` };
        }
        return { id: u.id, role: u.role, name: u.name };
    }
    if (rows.length === 1) return { id: rows[0].id, role: rows[0].role, name: rows[0].name };
    return {
        error:
            `${rows.length} active Sales Heads — name one with --actor <id|email>:` +
            rows.map((r) => `\n    ${r.id}  ${r.name}  ${r.email ?? ""}`).join(""),
    };
}

async function main() {
    const apply = process.argv.includes("--apply");
    const keepClock = process.argv.includes("--keep-clock");
    const month = arg("--month");
    if (month && !/^\d{4}-\d{2}$/.test(month)) throw new Error("--month takes YYYY-MM");
    const host = new URL(process.env.DATABASE_URL ?? "postgres://x@unknown/x").host.split(".")[0];
    console.log(`DB host: ${host}${apply ? "  (APPLY)" : "  (dry run — SELECTs only)"}`);

    const rows = (await db.execute(sql`
        SELECT t.id::text AS id, t.month::text AS month, t.user_id, COALESCE(u.name, u.email) AS user_name,
               u.is_active AS user_active, t.metric, to_jsonb(t) ->> 'custom_label' AS custom_label,
               t.ceo_target::float8 AS ceo, COALESCE(t.admin_addon, 0)::float8 AS stretch,
               (${finalTargetSql(sql`t`)})::float8 AS final,
               to_jsonb(t) ->> 'rejected_at' AS rejected_at, to_jsonb(t) ->> 'reject_comment' AS reject_comment,
               (to_jsonb(t) ->> 'next_ceo_target')::float8 AS next_ceo, (to_jsonb(t) ->> 'next_stretch')::float8 AS next_stretch,
               COALESCE(to_jsonb(t) ->> 'first_pushed_at', t.pushed_at::text) AS first_pushed_at
          FROM sales_targets t
          LEFT JOIN users u ON u.id::text = t.user_id
         WHERE t.status = 'rejected'
           ${month ? sql`AND t.month = ${`${month}-01`}::date` : sql``}
         ORDER BY t.month, user_name NULLS LAST, t.metric
    `)) as unknown as Rejected[];

    const held = rows.filter((r) => r.next_ceo != null || r.next_stretch != null || r.user_active !== true);
    const go = rows.filter((r) => !held.includes(r));
    const months = [...new Set(rows.map((r) => r.month))];

    console.log(`\nRejected under the old flow: ${rows.length} target(s), ${new Set(rows.map((r) => r.user_id)).size} rep(s)`);
    console.log(`  to push again (same numbers): ${go.length}`);
    console.log(`  held:                         ${held.length}`);
    const people = new Map<string, Rejected[]>();
    for (const r of go) people.set(`${r.month}|${r.user_id}`, [...(people.get(`${r.month}|${r.user_id}`) ?? []), r]);
    for (const list of people.values()) {
        const p = list[0];
        console.log(`\n  ${p.month.slice(0, 7)}  ${p.user_name ?? p.user_id}  — ${list.length} target(s), one bell + email`);
        for (const r of list) {
            console.log(
                `    ${r.id}  ${label(r).padEnd(32)}  CEO ${r.ceo} + ${r.stretch} = ${r.final}` +
                    `  rejected ${r.rejected_at?.slice(0, 16) ?? "?"}${r.reject_comment ? `  "${r.reject_comment.slice(0, 60)}"` : ""}`,
            );
        }
    }
    if (held.length) {
        console.log(`\n  HELD — not pushed by this script:`);
        for (const r of held) {
            const why =
                r.user_active !== true
                    ? "user inactive or missing"
                    : `revision waiting (next CEO ${r.next_ceo ?? "—"}, next stretch ${r.next_stretch ?? "—"}) — pushing would change the numbers`;
            console.log(`    ${r.id}  ${r.month.slice(0, 7)}  ${r.user_name ?? r.user_id}  ${label(r)}  — ${why}`);
        }
    }

    // What the three readers will add up, before and after.
    const before = await totals(months);
    if (before.length) {
        const goSum = new Map<string, number>();
        for (const r of go) goSum.set(`${r.month}|${r.metric}`, (goSum.get(`${r.month}|${r.metric}`) ?? 0) + r.final);
        console.log(`\nFinal-target totals (CEO + stretch). Email/scorecard = pushed + accepted; CEO tiles also count posted + rejected.`);
        console.log(`  month    metric                            email/scorecard now → after   CEO tiles   left apart after (posted, not pushed / held)`);
        for (const t of before) {
            const moved = goSum.get(`${t.month}|${t.metric}`) ?? 0;
            const after = t.email + moved;
            const gap = t.ceo_tiles - after;
            console.log(
                `  ${t.month.slice(0, 7)}  ${label(t).padEnd(32)}  ${String(t.email).padStart(10)} → ${String(after).padEnd(10)}  ${String(t.ceo_tiles).padStart(9)}` +
                    `   ${gap === 0 ? "same" : `${gap} (posted ${t.posted_not_pushed}, held rejected ${t.rejected - moved})`}`,
            );
        }
    }

    const actor = await resolveActor(arg("--actor"));
    if ("error" in actor) {
        console.log(`\nActor: ${actor.error}`);
        if (apply && go.length) {
            process.exitCode = 1;
            return;
        }
    } else {
        console.log(`\nPush from: ${actor.name} (${actor.role}, ${actor.id})`);
    }
    console.log(`48-hour clock: ${keepClock ? "kept from the first push (--keep-clock)" : "starts at this push"}`);

    if (!apply) {
        console.log(`\nDry run — nothing written. Re-run with --apply to push ${go.length} target(s).`);
        return;
    }
    if (!go.length) {
        console.log(`\nNothing to do.`);
        return;
    }
    if ("error" in actor) return;

    // The app's own push + notify; one call per month so every notice names its month.
    const { sendToMember } = await import("../src/lib/targets/service");
    let changed = 0;
    for (const m of [...new Set(go.map((r) => r.month))]) {
        const ids = go.filter((r) => r.month === m).map((r) => r.id);
        const res = await sendToMember(ids, { id: actor.id, role: actor.role }, { restartClock: !keepClock, why: WHY });
        changed += res.changed;
        console.log(`  ${m.slice(0, 7)}: pushed ${res.changed} of ${ids.length}`);
    }
    const left = (await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM sales_targets WHERE status = 'rejected' ${month ? sql`AND month = ${`${month}-01`}::date` : sql``}
    `)) as unknown as Array<{ n: number }>;
    console.log(`\nApplied: ${changed} target(s) pushed again. Still 'rejected' (held): ${left[0]?.n ?? "?"}.`);
}

main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
