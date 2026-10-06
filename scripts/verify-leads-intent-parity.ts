/**
 * READ-ONLY: does /leads "Owner = <rep>, Intent = Hot" agree with what that rep
 * sees as Hot in their own queue? (Admin report 2026-10-06: Jiten's own login
 * showed 14 Hot, /leads with Owner = Jiten + Intent = Hot showed 0, because
 * /leads filtered on final_intent_score and the queues on interest_level.)
 *
 * For every asm / inside_sales_rep with owned leads, per temperature:
 *   queue  = the rep's own working tab with the Interest filter
 *            (asm → my_visits, inside_sales_rep → my_open), via the real
 *            countAsmQueueRows / countQueueRows.
 *   leads  = /leads with ownerId = rep and the default "hide dead" on, via the
 *            real fetchLeadListStats (both the card count and the filtered total).
 *
 * The queue tabs only hold OPEN leads; /leads also lists Converted / Lost ones.
 * So the assertion is: card == filtered total, leads >= queue, and
 * leads − queue == that rep's hot leads in a terminal status.
 *
 *   node --import tsx --env-file=.env.production scripts/verify-leads-intent-parity.ts
 */
export {};

const base = process.env.DATABASE_URL ?? "";
process.env.DATABASE_URL =
    base + (base.includes("?") ? "&" : "?") + "default_transaction_read_only=on";

const BUCKETS = ["hot", "warm", "cold"] as const;

async function main() {
    const { db } = await import("@/lib/db");
    const { sql } = await import("drizzle-orm");
    const { fetchLeadListStats } = await import("@/lib/leads/leadListQuery");
    const { countQueueRows } = await import("@/lib/inside-sales/queryBuilder");
    const { countAsmQueueRows } = await import("@/lib/asm/queryBuilder");

    const ro = (await db.execute(sql`SHOW default_transaction_read_only`)) as unknown as {
        default_transaction_read_only: string;
    }[];
    if (ro[0]?.default_transaction_read_only !== "on") throw new Error("read-only guard not active — aborting");

    const reps = (await db.execute(sql`
        SELECT DISTINCT u.id::text AS id, u.name, u.role
          FROM users u JOIN dealer_leads dl ON dl.current_owner_id = u.id::text
         WHERE u.role IN ('asm', 'inside_sales_rep')
         ORDER BY u.name
    `)) as unknown as { id: string; name: string; role: string }[];

    let failures = 0;
    for (const rep of reps) {
        const all = await fetchLeadListStats({ ownerId: rep.id } as Parameters<typeof fetchLeadListStats>[0]);
        for (const b of BUCKETS) {
            const filtered = await fetchLeadListStats({ ownerId: rep.id, intent: b } as Parameters<
                typeof fetchLeadListStats
            >[0]);
            const queue =
                rep.role === "asm"
                    ? await countAsmQueueRows({ tab: "my_visits", asmId: rep.id, filters: { interest: b } })
                    : await countQueueRows({ tab: "my_open", userId: rep.id, filters: { interest: b } });
            const terminal = Number(
                (
                    (await db.execute(sql`
                        SELECT COUNT(*)::text AS c FROM dealer_leads dl
                         WHERE dl.current_owner_id = ${rep.id}
                           AND lower(dl.interest_level) = ${b}
                           AND dl.is_active IS NOT FALSE
                           AND (to_jsonb(dl) ->> 'contactability') IS NULL
                           AND dl.current_status IS DISTINCT FROM 'disqualified'
                           AND dl.lead_status IN ('Converted', 'Lost')
                    `)) as unknown as { c: string }[]
                )[0]?.c ?? 0,
            );
            const card = all[b];
            const ok = card === filtered.total && card - queue === terminal;
            if (!ok) failures++;
            console.log(
                `${ok ? "✔" : "✘"} ${rep.name.padEnd(12)} ${rep.role.padEnd(16)} ${b.padEnd(4)}  ` +
                    `/leads card=${card} list=${filtered.total}  queue=${queue}  closed=${terminal}`,
            );
        }
    }
    console.log(failures ? `\n${failures} mismatch(es)` : "\nAll reps match.");
    process.exit(failures ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
