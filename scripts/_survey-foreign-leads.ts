// READ-ONLY survey of non-Indian leads on production. Writes nothing.
import postgres from "postgres";
import { detectForeignCountry } from "@/lib/scraper/geo";

const URL = process.env.SURVEY_DATABASE_URL!;
const sql = postgres(URL, { ssl: { rejectUnauthorized: false }, max: 3, idle_timeout: 20 });

async function main() {
  // ---- 1. scraped_dealer_leads, ALL runs
  const scraped = await sql`
    SELECT id, scraper_run_id, dealer_name, phone, location_city, location_state,
           raw_data->>'address' AS address, created_at
    FROM scraped_dealer_leads`;
  console.log("scraped_dealer_leads total:", scraped.length);

  const foreignScraped = scraped.filter((r) => detectForeignCountry({ address: r.address }));
  console.log("flagged foreign by geo.ts:", foreignScraped.length);

  const notIndia = scraped.filter((r) => r.address && !/india/i.test(r.address));
  console.log("address does not mention India:", notIndia.length);

  const missed = notIndia.filter((r) => !detectForeignCountry({ address: r.address }));
  console.log("  ...of which geo.ts does NOT flag (needs eyeballing):", missed.length);
  missed.slice(0, 30).forEach((r) => console.log(`    ${r.dealer_name} | ${r.address}`));

  console.log("\n=== foreign scraped leads by run ===");
  const byRun: Record<string, { run: string; n: number }> = {};
  for (const r of foreignScraped) {
    byRun[r.scraper_run_id] = byRun[r.scraper_run_id] ?? { run: r.scraper_run_id, n: 0 };
    byRun[r.scraper_run_id].n++;
  }
  console.table(Object.values(byRun).sort((a, b) => b.n - a.n));

  console.log("\n=== foreign scraped leads by country ===");
  const byC: Record<string, number> = {};
  for (const r of foreignScraped) {
    const c = detectForeignCountry({ address: r.address })!;
    byC[c] = (byC[c] ?? 0) + 1;
  }
  console.table(Object.entries(byC).map(([country, n]) => ({ country, n })).sort((a, b) => b.n - a.n));

  // ---- 2. which of them reached dealer_leads (the dialer queue)
  const phones = [
    ...new Set(foreignScraped.map((r) => r.phone).filter(Boolean).map((p: string) => p.replace(/^\+91/, ""))),
  ];
  console.log("\ndistinct 10-digit phones among foreign scraped leads:", phones.length);

  const promoted = phones.length
    ? await sql`
        SELECT id, dealer_name, phone, current_status, lead_status, total_attempts,
               final_intent_score, location, state, country, assigned_to, dealer_id, created_at
        FROM dealer_leads WHERE phone = ANY(${phones})`
    : [];
  console.log("=== promoted into dealer_leads ===", promoted.length);
  console.table(
    promoted.map((r) => ({
      id: r.id,
      name: r.dealer_name?.slice(0, 32),
      phone: r.phone,
      status: r.current_status,
      attempts: r.total_attempts,
      state: r.state,
      assigned: !!r.assigned_to,
      dealer: !!r.dealer_id,
    })),
  );

  // ---- 3. what points at those dealer_leads rows
  const ids = promoted.map((r) => r.id);
  if (ids.length) {
    const cols = await sql`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema='public' AND column_name IN ('lead_id','linked_lead_id')
      ORDER BY table_name`;
    console.log("\n=== dependent rows referencing these lead ids ===");
    let anyDeps = false;
    for (const { table_name, column_name } of cols) {
      try {
        const r = await sql.unsafe(
          `SELECT count(*)::int n FROM public."${table_name}" WHERE "${column_name}" = ANY($1)`,
          [ids],
        );
        if (r[0].n > 0) {
          console.log(`  ${table_name}.${column_name}: ${r[0].n}`);
          anyDeps = true;
        }
      } catch (e: any) {
        console.log(`  ${table_name}.${column_name}: (skip) ${e.message.slice(0, 60)}`);
      }
    }
    if (!anyDeps) console.log("  none");

    console.log("\n=== real FK constraints pointing at dealer_leads ===");
    const fks = await sql`
      SELECT tc.table_name, kcu.column_name, rc.delete_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
      JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type='FOREIGN KEY' AND ccu.table_name='dealer_leads'`;
    if (fks.length) console.table(fks);
    else console.log("  none");
  }

}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => sql.end());
