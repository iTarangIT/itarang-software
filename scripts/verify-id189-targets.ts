// Read-only check of ID 189: CEO target + stretch, versions, ask for correction.
//
//   node --import tsx --env-file=.env.local scripts/verify-id189-targets.ts [YYYY-MM]
//
// Changes nothing. For the month (default: this IST month) it checks:
//   E-343 applied           the new columns and sales_target_versions exist
//   one final-target rule   listTargets().final_target = finalTargetSql() for
//                           every row (the rule the digests and exports use)
//   add-only stretch        no row has a negative stretch
//   drafts stay the CEO's   a manager's listTargets() has no 'draft' row
//   readers see in force    a member's listTargets() carries no revision
//   member sees pushed only a member's listTargets() has no posted-not-pushed row
//   soft removal            no list shows a removed row; each has its history row
//   48-hour clock           every sent row has first_pushed_at <= pushed_at
//   the E-342 leftovers     rows whose Sales Head number was BELOW the CEO's
//                           (their final goes back up to the CEO target)
// and prints the awaiting-push tile and the overdue list as they stand.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { awaitingPush, listTargets, overdueAcceptance } from "@/lib/targets/service";
import { finalTargetSql } from "@/lib/targets/sql";

let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
}

async function main() {
    const arg = process.argv[2] ?? "";
    const month = /^\d{4}-\d{2}$/.test(arg) ? arg : new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7);
    const monthFirst = `${month}-01`;
    console.log(`ID 189 — targets for ${month}`);

    const cols = (await db.execute(sql`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'sales_targets'
           AND column_name IN ('stretch_note', 'draft_ceo_target', 'next_ceo_target', 'next_stretch', 'version',
                               'first_pushed_at', 'correction_requested_at', 'correction_remark', 'accept_remark')
    `)) as unknown as Array<{ column_name: string }>;
    const versions = (await db.execute(sql`SELECT to_regclass('public.sales_target_versions') IS NOT NULL AS ok`)) as unknown as Array<{ ok: boolean }>;
    check("E-343 columns on sales_targets (9)", cols.length === 9, cols.map((c) => c.column_name));
    check("E-343 sales_target_versions exists", Boolean(versions[0]?.ok));

    const ceo = await listTargets({ month, viewer: "ceo" });
    const sqlFinal = (await db.execute(sql`
        SELECT t.id::text AS id, (${finalTargetSql(sql`t`)})::float8 AS f, t.admin_addon::float8 AS s
          FROM sales_targets t WHERE t.month = ${monthFirst}::date
    `)) as unknown as Array<{ id: string; f: number; s: number }>;
    const byId = new Map(sqlFinal.map((r) => [r.id, r]));
    const mismatch = ceo.filter((r) => Math.abs((byId.get(r.id)?.f ?? NaN) - r.final_target) > 0.001).map((r) => r.id);
    check(`final_target = finalTargetSql on ${ceo.length} rows`, mismatch.length === 0, mismatch.slice(0, 5));
    check("no negative stretch", sqlFinal.every((r) => Number(r.s) >= 0));
    check("final = CEO + stretch on every row", ceo.every((r) => Math.abs(r.final_target - (r.ceo_target + r.stretch)) < 0.001));

    const manager = await listTargets({ month, viewer: "manager" });
    check("a manager never sees a CEO draft", manager.every((r) => r.status !== "draft" && r.draft_ceo_target == null));
    check(
        "the manager list is the CEO list minus drafts",
        manager.length === ceo.filter((r) => r.status !== "draft").length,
        { manager: manager.length, ceo: ceo.length },
    );
    const member = ceo.find((r) => r.status === "pushed" || r.status === "accepted");
    if (member) {
        const mine = await listTargets({ month, userId: member.user_id, viewer: "member" });
        check("a member's rows carry no pending revision", mine.every((r) => r.next_ceo_target == null && r.next_stretch == null && r.draft_ceo_target == null));
        check(
            "a member sees only what was pushed to them (16 Oct)",
            mine.every((r) => r.status === "pushed" || r.status === "accepted" || r.status === "rejected"),
            mine.filter((r) => !["pushed", "accepted", "rejected"].includes(r.status)).map((r) => r.status),
        );
    } else {
        console.log("SKIP  no sent target this month to check the member view");
    }
    const posted = ceo.find((r) => r.status === "pending_approval");
    if (posted) {
        const mine = await listTargets({ month, userId: posted.user_id, viewer: "member" });
        check("a posted-but-not-pushed target is not in the member's list", !mine.some((r) => r.id === posted.id));
    }

    // 16 Oct: removal is soft — the row and its history stay, no list shows it.
    const removed = (await db.execute(sql`
        SELECT t.id::text AS id,
               (SELECT COUNT(*) FROM sales_target_versions v WHERE v.target_id = t.id AND v.event = 'removed')::int AS logged
          FROM sales_targets t WHERE t.month = ${monthFirst}::date AND t.status = 'removed'
    `)) as unknown as Array<{ id: string; logged: number }>;
    const removedIds = new Set(removed.map((r) => r.id));
    check("no list shows a removed target", ![...ceo, ...manager].some((r) => removedIds.has(r.id)), removed.length);
    check("every removed target has its 'removed' history row", removed.every((r) => Number(r.logged) > 0));
    const shAdded = (await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM sales_targets t
          LEFT JOIN users cb ON cb.id::text = t.created_by
         WHERE t.month = ${monthFirst}::date AND t.status <> 'removed'
           AND COALESCE(LOWER(cb.role), '') <> 'ceo' AND t.ceo_target = 0
    `)) as unknown as Array<{ n: number }>;
    console.log(`INFO  live rows created by someone other than the CEO with a CEO target of 0 (old flow): ${shAdded[0]?.n ?? 0}`);

    const clock = (await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM sales_targets t
         WHERE t.month = ${monthFirst}::date AND t.status IN ('pushed', 'accepted', 'rejected')
           AND (to_jsonb(t) ->> 'first_pushed_at') IS NOT NULL AND t.pushed_at IS NOT NULL
           AND (to_jsonb(t) ->> 'first_pushed_at')::timestamptz > t.pushed_at
    `)) as unknown as Array<{ n: number }>;
    check("first_pushed_at is never after pushed_at", Number(clock[0]?.n ?? 0) === 0, clock[0]);

    const lower = (await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM sales_targets t
         WHERE (to_jsonb(t) ->> 'sales_head_target')::numeric > 0
           AND (to_jsonb(t) ->> 'sales_head_target')::numeric < t.ceo_target
    `)) as unknown as Array<{ n: number }>;
    console.log(`INFO  rows whose old Sales Head number was below the CEO's (final now = CEO target): ${lower[0]?.n ?? 0}`);

    console.log("INFO  Targets waiting for approval tile:", JSON.stringify(await awaitingPush()));
    console.log("INFO  Not accepted within 48 hours of the first push:", JSON.stringify(await overdueAcceptance()));

    console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed");
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
