// Read-only check of the 24 Nov CRM items against one database: runs the REAL
// query builders behind /leads/team, /leads/team/visits and the visit
// business-type rule, and prints what they return. Only SELECTs.
//
//   node --import tsx --env-file=.env.local      scripts/verify-24nov-team-pages.ts   # sandbox (db-1)
//   node --import tsx --env-file=.env.production scripts/verify-24nov-team-pages.ts   # live (db-2)

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { listTeamLeads, listTeamVisits, teamScopeFor } from "@/lib/team/teamLeads";
import { currentBusinessType, planVisitBusinessType } from "@/lib/leads/visitBusinessType";
import { teamLeadsCsv, teamVisitsCsv } from "@/lib/team/teamCsv";

type Row = Record<string, unknown>;

async function step(label: string, run: () => Promise<string>) {
    try {
        console.log(`✔ ${label.padEnd(34)} ${await run()}`);
    } catch (e) {
        console.log(`✘ ${label.padEnd(34)} ${(e as Error).message.split("\n")[0]}`);
        process.exitCode = 1;
    }
}

async function main() {
    console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host.split(".")[0]}\n`);

    // An oversight viewer (everyone in scope) — a fake id, never written anywhere.
    const admin = { id: "00000000-0000-0000-0000-000000000000", role: "admin" };
    const scope = await teamScopeFor(admin);
    console.log(`scope (admin): ${scope.people.length} people\n`);

    await step("team leads (all)", async () => {
        const r = await listTeamLeads(scope, {});
        const withAction = r.rows.filter((x) => x.last_action_at).length;
        const withComment = r.rows.filter((x) => x.last_comment).length;
        const first = r.rows[0];
        return `${r.rows.length} rows${r.truncated ? " (truncated)" : ""}; ${withAction} with an action, ${withComment} with a comment; newest: ${first ? `${first.id} ${first.last_action_type} ${first.last_action_at}` : "—"}`;
    });

    await step("team leads sorted newest action first", async () => {
        const r = await listTeamLeads(scope, {});
        const t = r.rows.map((x) => (x.last_action_at ? new Date(x.last_action_at).getTime() : -Infinity));
        const ok = t.every((v, i) => i === 0 || v <= t[i - 1]!);
        if (!ok) throw new Error("rows are not in newest-action order");
        return "ok";
    });

    const someRep = scope.people[0]?.id ?? null;
    await step("team leads, one member + 30-day range", async () => {
        const to = new Date().toISOString().slice(0, 10);
        const from = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
        const r = await listTeamLeads(scope, { member: someRep, from, to });
        const others = r.rows.filter((x) => x.owner_id !== someRep).length;
        if (others) throw new Error(`${others} rows owned by someone else`);
        return `${r.rows.length} rows for ${scope.people[0]?.name ?? "—"}`;
    });

    await step("team leads, business type = solar", async () => {
        const r = await listTeamLeads(scope, { businessType: "solar" });
        if (r.rows.some((x) => x.business_type !== "solar")) throw new Error("non-solar row returned");
        return `${r.rows.length} rows`;
    });

    await step("a manager's scope = self + reports", async () => {
        const [m] = (await db.execute(sql`
            SELECT l.manager_id::text AS id, u.role FROM user_reporting_lines l JOIN users u ON u.id::text = l.manager_id::text
             WHERE l.effective_to IS NULL LIMIT 1
        `)) as unknown as Row[];
        if (!m) return "no reporting lines on this DB — skipped";
        const s = await teamScopeFor({ id: String(m.id), role: String(m.role) });
        return `${m.role} sees ${s.ownerIds.length} people (all=${s.all})`;
    });

    for (const kind of ["scheduled", "completed"] as const) {
        await step(`team visits — ${kind} (last 30 days)`, async () => {
            const r = await listTeamVisits(scope, kind, {});
            const outOfRange = r.rows.filter((x) => {
                const d = kind === "completed" ? x.actual_visit_date : x.scheduled_date;
                return !d || d < r.from || d > r.to;
            }).length;
            if (outOfRange) throw new Error(`${outOfRange} rows outside ${r.from}..${r.to}`);
            if (kind === "completed" && r.rows.some((x) => x.visit_status !== "visited")) throw new Error("a not-done visit in completed");
            const csv = teamVisitsCsv(r.rows, r.truncated);
            return `${r.rows.length} rows ${r.from}..${r.to}; verified ${r.rows.filter((x) => x.verified).length}; csv ${csv.split("\r\n").length - 2} lines`;
        });
    }

    await step("team leads CSV", async () => {
        const r = await listTeamLeads(scope, {}, 20);
        const csv = teamLeadsCsv(r.rows, r.truncated);
        if (!csv.startsWith("﻿Lead ID,")) throw new Error("bad header");
        return `${csv.split("\r\n").length - 2} data lines`;
    });

    await step("visit business-type rule on real leads", async () => {
        const rows = (await db.execute(sql`
            (SELECT id FROM dealer_leads WHERE business_type IS NULL LIMIT 1)
            UNION ALL
            (SELECT id FROM dealer_leads WHERE business_type IS NOT NULL LIMIT 1)
        `)) as unknown as Array<{ id: string }>;
        const out: string[] = [];
        for (const { id } of rows) {
            const cur = await currentBusinessType(id);
            const p = planVisitBusinessType(undefined, cur);
            out.push(`${id}: type=${cur ?? "none"} → visit without a type ${p.ok ? "allowed" : "refused"}`);
        }
        return out.join("; ");
    });
}

main()
    .catch((e) => {
        console.error(e);
        process.exitCode = 1;
    })
    .finally(() => process.exit());
