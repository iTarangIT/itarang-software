// ID 197 pilot sheet — travel proof for 2 ASMs, every working day of a month.
//
//   node --import tsx --env-file=.env.local scripts/verify-travel-proof.ts [--month=2026-10] [--asm=<email or id> ...]
//
// For each ASM (default: the two ASMs with the most visits in the month) and
// each working day (Mon–Sat) of the month, prints the verdict the submit form
// would show — Supported (a verified visit that day, ID 196) or Not supported —
// with verified / unverified visits, cities and calls. Uses the real
// dayEvidence() the form and the CEO's Day evidence use. Writes nothing.
// Visits before E-363 are all unverified, so October reads mostly Not
// supported: that is the point of the pilot (what the rule would have said).

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dayEvidence } from "@/lib/expenses/travelProofStore";

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

async function main() {
    const args = process.argv.slice(2);
    const month = args.find((a) => a.startsWith("--month="))?.slice(8) ?? "2026-10";
    const wanted = args.filter((a) => a.startsWith("--asm=")).map((a) => a.slice(6));
    const first = `${month}-01`;

    const asms = wanted.length
        ? rowsOf<{ id: string; name: string }>(
              await db.execute(sql`
                  SELECT id::text AS id, COALESCE(name, email) AS name FROM users
                   WHERE id::text IN (${sql.join(wanted.map((w) => sql`${w}`), sql`, `)})
                      OR lower(email) IN (${sql.join(wanted.map((w) => sql`${w.toLowerCase()}`), sql`, `)})
              `),
          )
        : rowsOf<{ id: string; name: string }>(
              await db.execute(sql`
                  SELECT u.id::text AS id, COALESCE(u.name, u.email) AS name
                    FROM lead_visits v JOIN users u ON u.id::text = v.asm_id
                   WHERE lower(u.role) = 'asm' AND v.visit_status = 'visited'
                     AND v.actual_visit_date >= ${first}::date
                     AND v.actual_visit_date < (${first}::date + INTERVAL '1 month')
                   GROUP BY u.id, u.name, u.email ORDER BY COUNT(*) DESC LIMIT 2
              `),
          );
    if (asms.length === 0) {
        console.log(`No ASM visits in ${month}.`);
        return;
    }

    const days: string[] = [];
    for (let d = new Date(`${first}T00:00:00Z`); d.toISOString().slice(0, 7) === month; d.setUTCDate(d.getUTCDate() + 1)) {
        if (d.getUTCDay() !== 0) days.push(d.toISOString().slice(0, 10));
    }

    for (const a of asms) {
        console.log(`\n${a.name} (${a.id}) — ${month}`);
        console.log("  day         verdict         verified  not-verified  calls  cities");
        let supported = 0;
        for (const day of days) {
            const ev = await dayEvidence(a.id, day);
            if (ev.verdict === "supported") supported++;
            const ver = ev.visits.filter((v) => v.verified).length;
            console.log(
                `  ${day}  ${(ev.verdict === "supported" ? "Supported" : "Not supported").padEnd(14)}  ${String(ver).padStart(8)}  ${String(ev.visits.length - ver).padStart(12)}  ${String(ev.calls).padStart(5)}  ${ev.cities.join(", ")}`,
            );
        }
        console.log(`  → ${supported} of ${days.length} working days supported`);
    }
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
