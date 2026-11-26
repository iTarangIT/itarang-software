// Read-only: why does a sales team member's target not show (Sales Head dashboard / Targets)?
//
//   node scripts/verify-target-visibility.mjs database-2            # prod, this month + last
//   node scripts/verify-target-visibility.mjs database-1 2026-11    # sandbox, one month
//
// For every active ASM / ISR / sales manager it lists each month's targets
// with status, posted / pushed / accepted dates and the reason a reader would
// not see it, then the posting history (sales_target_versions). Also flags
// sales_targets rows whose user_id matches no users.id (they show on no row).
// Only SELECTs; the connection URL is never printed.
import { readFileSync } from "node:fs";
import pg from "pg";

const target = process.argv[2] ?? "database-2";
if (!["database-1", "database-2"].includes(target)) throw new Error("usage: database-1 | database-2 [YYYY-MM]");
const line = readFileSync(process.env.ENV_FILE ?? ".env.local", "utf8")
    .split(/\r?\n/)
    .find((l) => /^\s*#?\s*DATABASE_URL=/.test(l) && l.includes(`${target}.`));
if (!line) throw new Error(`no DATABASE_URL for ${target} in .env.local`);
const url = line.replace(/^\s*#?\s*DATABASE_URL=/, "").trim().replace(/^["']|["']$/g, "");
if (!new URL(url).host.startsWith(`${target}.`)) throw new Error("host mismatch");

// sslmode in the URL would override the ssl option below (RDS chain is not in Node's store).
const u = new URL(url);
u.searchParams.delete("sslmode");
const c = new pg.Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query("SET default_transaction_read_only = on");
const q = async (s, p = []) => (await c.query(s, p)).rows;

const today = (await q(`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`))[0].d;
const months = process.argv[3]
    ? [`${process.argv[3]}-01`]
    : (await q(`SELECT to_char(date_trunc('month', $1::date) - interval '1 month', 'YYYY-MM-DD') AS a,
                       to_char(date_trunc('month', $1::date), 'YYYY-MM-DD') AS b`, [today])).map((r) => [r.a, r.b]).flat();

const WHY = {
    draft: "CEO draft — not posted to the Sales Head yet (only the CEO sees it)",
    pending_approval: "Posted to the Sales Head — NOT pushed to the member yet (dashboard scorecard ignores it)",
    pushed: "Pushed — waiting for the member to accept (shown on the scorecard)",
    accepted: "Accepted (shown)",
    rejected: "Old-flow reject — push again",
    removed: "Removed",
};
const SCORECARD_FIELD = ["dealer_visits", "new_dealer_visits", "batteries_sold", "kyc_submitted", "revenue"];
const SCORECARD_INSIDE = ["calls_per_day", "hot_to_ground"];

console.log(`DB ${target} · IST today ${today}`);
const people = await q(`SELECT id::text AS id, name, email, LOWER(role) AS role FROM users
                         WHERE is_active = TRUE AND LOWER(role) IN ('asm','inside_sales_rep','sales_manager')
                         ORDER BY role, name`);
const hasVersions = (await q(`SELECT to_regclass('public.sales_target_versions') IS NOT NULL AS ok`))[0].ok;

for (const month of months) {
    console.log(`\n══ ${month.slice(0, 7)} ══`);
    const rows = await q(
        `SELECT t.id::text, t.user_id, t.metric, t.status, t.ceo_target::float8 AS ceo, t.admin_addon::float8 AS stretch,
                to_jsonb(t)->>'review_requested_at' AS posted_at, t.pushed_at, t.accepted_at,
                to_jsonb(t)->>'correction_requested_at' AS correction_at, to_jsonb(t)->>'next_ceo_target' AS next_ceo,
                to_jsonb(t)->>'next_stretch' AS next_stretch
           FROM sales_targets t WHERE t.month = $1::date ORDER BY t.user_id, t.metric`,
        [month],
    );
    const ids = new Set(people.map((p) => p.id));
    const orphan = rows.filter((r) => !ids.has(r.user_id));
    for (const p of people) {
        const mine = rows.filter((r) => r.user_id === p.id && r.status !== "removed");
        const label = `${p.name ?? p.email} (${p.role})`;
        if (!mine.length) {
            console.log(`  ✗ ${label}: NO target rows${p.role === "sales_manager" ? " — sales_manager has no target metrics and is not offered on Admin › Targets" : " — CEO never added this person to the month"}`);
            continue;
        }
        const shown = mine.filter((r) => r.status === "pushed" || r.status === "accepted");
        const onCard = p.role === "inside_sales_rep" ? SCORECARD_INSIDE : SCORECARD_FIELD;
        const mark = shown.some((r) => onCard.includes(r.metric)) ? "✓" : "✗";
        console.log(`  ${mark} ${label}: ${mine.length} target(s), ${shown.length} pushed/accepted`);
        for (const r of mine) {
            const d = (v) => (v ? new Date(v).toISOString().slice(0, 16).replace("T", " ") : "—");
            const extra = [];
            if (!onCard.includes(r.metric)) extra.push("metric not a scorecard column");
            if (r.correction_at && (!r.pushed_at || r.correction_at > new Date(r.pushed_at).toISOString())) extra.push("correction asked");
            if (r.next_ceo || r.next_stretch) extra.push("revision waiting for push");
            console.log(
                `      ${r.metric.padEnd(18)} ${String(r.ceo + r.stretch).padStart(9)}  ${r.status.padEnd(16)} posted ${d(r.posted_at)} · pushed ${d(r.pushed_at)} · accepted ${d(r.accepted_at)}  ${WHY[r.status] ?? r.status}${extra.length ? " · " + extra.join(", ") : ""}`,
            );
        }
    }
    if (orphan.length) {
        const users = await q(`SELECT id::text AS id, name, role, is_active FROM users WHERE id::text = ANY($1::text[])`, [[...new Set(orphan.map((r) => r.user_id))]]);
        const byId = new Map(users.map((u) => [u.id, u]));
        console.log(`  Rows for people outside the active ASM/ISR/manager list:`);
        for (const uid of new Set(orphan.map((r) => r.user_id))) {
            const u = byId.get(uid);
            const n = orphan.filter((r) => r.user_id === uid).length;
            console.log(`    ${uid}: ${n} row(s) — ${u ? `${u.name} (${u.role}${u.is_active ? "" : ", INACTIVE"})` : "NO SUCH USER — user_id matches no users.id"}`);
        }
    }
    if (hasVersions) {
        const hist = await q(
            `SELECT COALESCE(u.name, t.user_id) AS who, v.event, COUNT(*)::int AS n, MAX(v.changed_at) AS last
               FROM sales_target_versions v JOIN sales_targets t ON t.id = v.target_id
               LEFT JOIN users u ON u.id::text = t.user_id
              WHERE t.month = $1::date GROUP BY 1, 2 ORDER BY 1, 2`,
            [month],
        );
        console.log(`  Posting history (sales_target_versions):`);
        for (const h of hist) console.log(`    ${String(h.who).padEnd(26)} ${h.event.padEnd(22)} ×${h.n}  last ${new Date(h.last).toISOString().slice(0, 16)}`);
        if (!hist.length) console.log("    (none)");
    }
}
await c.end();
