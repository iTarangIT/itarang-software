// ID 248 — duplicate dealer leads: the same number stored with and without +91.
//
//   Dry run (read-only, the default): every group of leads whose numbers match on the last
//   10 digits, with owner, status, created date, visits and touchpoints.
//     node --import tsx --env-file=.env.local scripts/dup-leads-last10.ts
//
//   One pair, read-only: what a merge would move.
//     node --import tsx --env-file=.env.local scripts/dup-leads-last10.ts --plan <keep_id> <drop_id>
//
//   Merge (keep = the OLDER lead; refuses otherwise). Needs --apply and the admin's user id:
//     node --import tsx --env-file=.env.local scripts/dup-leads-last10.ts --merge <keep_id> <drop_id> --actor <admin_user_id> --apply
//   On live: dry run, post the counts, Kartik's go-ahead, backup, then the merge. Approved
//   12 Nov: Vinayak (DL-1788853088140-D8iGR0r6 + DL-muf9zhg0-a12b447e) and E RIKSHAW
//   (L-5aPrumMq + DL-muf9zhg0-6082a02c). Run --plan first: it refuses when the first id is
//   the NEWER lead, so swap the two if it says so.
//
//   Number formats, read-only: how many leads are not stored as +91XXXXXXXXXX (step 4,
//   after Kartik's go-ahead; the unique rule E-384 waits until no duplicates are left).
//     node --import tsx --env-file=.env.local scripts/dup-leads-last10.ts --formats

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { duplicatePhoneGroups, mergeDealerLeads, planMerge, type MergePlan } from "@/lib/leads/mergeLeads";

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const after = (f: string, n = 1) => {
    const i = args.indexOf(f);
    return i >= 0 ? args.slice(i + 1, i + 1 + n) : [];
};
const mask = (p: string | null) => {
    const d = (p ?? "").replace(/\D/g, "");
    return `${(p ?? "").startsWith("+") ? "+" : ""}${"•".repeat(Math.max(0, d.length - 4))}${d.slice(-4)}`;
};

function printPlan(p: MergePlan) {
    console.log(`KEEP ${p.keep.id}  ${p.keep.name ?? "—"}  ${mask(p.keep.phone)}  ${p.keep.lead_status}  owner ${p.keep.owner_name ?? "—"}  created ${p.keep.created_at.slice(0, 10)}`);
    console.log(`DROP ${p.drop.id}  ${p.drop.name ?? "—"}  ${mask(p.drop.phone)}  ${p.drop.lead_status}  owner ${p.drop.owner_name ?? "—"}  created ${p.drop.created_at.slice(0, 10)}`);
    console.log(p.moves.length ? "Rows that move to KEEP:" : "Nothing points at DROP.");
    for (const m of p.moves) console.log(`  ${m.table}.${m.column}: ${m.rows}`);
    console.log(`Done visits on DROP dated a day KEEP already has one (counted once after the merge): ${p.sameDayVisits}`);
}

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[:/].*$/, "");
    console.log(`DB host: ${host || "(unset)"}\n`);

    if (flag("--plan")) {
        const [keep, drop] = after("--plan", 2);
        if (!keep || !drop) throw new Error("usage: --plan <keep_id> <drop_id>");
        printPlan(await planMerge(keep, drop));
        return;
    }

    if (flag("--merge")) {
        const [keep, drop] = after("--merge", 2);
        const [actor] = after("--actor");
        if (!keep || !drop) throw new Error("usage: --merge <keep_id> <drop_id> --actor <admin_user_id> --apply");
        const plan = await planMerge(keep, drop);
        printPlan(plan);
        if (!flag("--apply")) {
            console.log("\nDry run: add --apply (and --actor <admin user id>) to merge.");
            return;
        }
        if (!actor) throw new Error("--actor <admin_user_id> is required with --apply");
        const roles = (await db.execute(sql`SELECT role FROM users WHERE id::text = ${actor} AND is_active = true`)) as unknown as Array<{ role: string }>;
        if (roles[0]?.role !== "admin") throw new Error("--actor must be an active admin user id");
        const r = await mergeDealerLeads({ keepId: keep, dropId: drop, actor: { id: actor, role: "admin" } });
        console.log("\nMERGED.");
        for (const m of r.moved) console.log(`  moved ${m.table}.${m.column}: ${m.rows}`);
        for (const k of r.keptOnCopy) console.log(`  kept on the copy ${k.table}.${k.column}: ${k.reason}`);
        console.log(`  same-day visits cancelled on the copy (counted once): ${r.visitsCancelled}`);
        console.log(`  profile fields filled on KEEP from the copy: ${r.filled.join(", ") || "none"}`);
        console.log(`  ${drop} is Lost (duplicate_lead).`);
        return;
    }

    if (flag("--formats")) {
        const r = (await db.execute(sql`
            SELECT CASE WHEN phone ~ '^\\+91[0-9]{10}$' THEN '+91XXXXXXXXXX'
                        WHEN phone ~ '^[0-9]{10}$' THEN 'XXXXXXXXXX (10 digits)'
                        WHEN phone IS NULL OR phone = '' THEN '(blank)'
                        ELSE 'other' END AS format,
                   count(*)::int AS n
              FROM dealer_leads GROUP BY 1 ORDER BY 2 DESC
        `)) as unknown as Array<{ format: string; n: number }>;
        for (const x of r) console.log(`  ${x.format.padEnd(26)} ${x.n}`);
        return;
    }

    const groups = await duplicatePhoneGroups();
    const leads = groups.reduce((s, g) => s + g.leads.length, 0);
    console.log(`${groups.length} numbers are on more than one lead (${leads} leads in all).\n`);
    for (const g of groups) {
        console.log(`…${g.digits.slice(-4)}`);
        for (const l of g.leads) {
            console.log(
                `   ${l.id.padEnd(30)} ${mask(l.phone).padEnd(14)} ${(l.lead_status ?? "—").padEnd(26)} ${(l.owner_name ?? "no owner").padEnd(20)} created ${l.created_at.slice(0, 10)}  visits ${l.visits}  touchpoints ${l.touchpoints}  ${l.name ?? ""}`,
            );
        }
    }
    const byStatus = new Map<string, number>();
    for (const g of groups) for (const l of g.leads) byStatus.set(l.lead_status ?? "—", (byStatus.get(l.lead_status ?? "—") ?? 0) + 1);
    console.log("\nLeads in these groups by status:");
    for (const [s, n] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${s.padEnd(28)} ${n}`);
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e instanceof Error ? e.message : e);
        process.exit(1);
    });
