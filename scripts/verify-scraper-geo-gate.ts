/**
 * Replays a real scraper run's raw results through the REAL processing
 * pipeline and reports what the country gate would now drop.
 *
 * Vitest covers the gate's logic on hand-picked records; this covers the thing
 * unit tests cannot — that the gate behaves correctly against the full,
 * messy shape of what Google Places and Apify actually returned, and that it
 * does not quietly delete legitimate Indian dealers.
 *
 * READ-ONLY. It selects from scraper_raw and writes nothing.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-scraper-geo-gate.ts <RUN_ID>
 *
 * Point it at another database with SCRAPER_VERIFY_DATABASE_URL. The default
 * run is SCRAPE-20260820-e3ae054b — "3w battery dealer in kaushambi pyaragraj
 * ghoomaniya", the production run that saved 21 non-Indian dealers and
 * promoted 14 of them into the AI dialer queue.
 */
import postgres from "postgres";
import { processLeads } from "@/lib/scraper/processing";
import { detectForeignCountry } from "@/lib/scraper/geo";

const RUN_ID = process.argv[2] ?? "SCRAPE-20260820-e3ae054b";
const DATABASE_URL =
  process.env.SCRAPER_VERIFY_DATABASE_URL ?? process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error(
    "Set DATABASE_URL (or SCRAPER_VERIFY_DATABASE_URL) before running.",
  );
  process.exit(1);
}

const sql = postgres(DATABASE_URL, {
  ssl: { rejectUnauthorized: false },
  max: 2,
  idle_timeout: 20,
});

let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const rows = await sql<{ raw_data: string }[]>`
    SELECT raw_data FROM scraper_raw WHERE run_id = ${RUN_ID}
  `;
  const raw = rows
    .map((r) => {
      try {
        return JSON.parse(r.raw_data);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  console.log(`run ${RUN_ID}: ${raw.length} raw results\n`);
  if (!raw.length) {
    console.error("No raw results for that run id — nothing to verify.");
    process.exit(1);
  }

  // What actually got saved when this run executed, straight from the DB.
  const [{ n: savedBefore }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM scraped_dealer_leads
    WHERE scraper_run_id = ${RUN_ID}
  `;
  const [{ n: foreignBefore }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM scraped_dealer_leads
    WHERE scraper_run_id = ${RUN_ID}
      AND coalesce(raw_data->>'address', '') NOT ILIKE '%India%'
  `;

  // What the pipeline does today, with the gate in place.
  const result = await processLeads(raw);
  const kept = result.cleaned;

  const stillForeign = kept.filter((l: any) => detectForeignCountry(l));
  const fabricatedPhones = kept.filter(
    (l: any) => l.phone?.startsWith("+91") && detectForeignCountry(l),
  );

  // NOT a like-for-like pair. savedBefore counts what survived cross-chunk
  // dedupe against leads already in the DB over 375 separate chunk calls;
  // this replay processes the whole raw set in one batch, so its total is
  // necessarily larger. The number that matters is the foreign count.
  console.log(
    `when this run executed : ${savedBefore} rows saved, ${foreignBefore} of them outside India`,
  );
  console.log(
    `replayed through the gate now : ${kept.length} rows survive the filter, ${stillForeign.length} outside India\n`,
  );

  check(stillForeign.length === 0, "no foreign dealer survives the gate",
    stillForeign.length
      ? stillForeign.slice(0, 5).map((l: any) => l.address).join(" | ")
      : "");

  check(fabricatedPhones.length === 0, "no foreign number carries a +91 prefix",
    fabricatedPhones.length
      ? fabricatedPhones.slice(0, 5).map((l: any) => `${l.phone} ${l.address}`).join(" | ")
      : "");

  // The gate must reject on positive evidence only. Indian dealers whose
  // address Google rendered without the ", India" suffix must survive.
  const indianRaw = raw.filter(
    (r: any) => !detectForeignCountry({ address: r.address, components: r.components }),
  );
  check(
    indianRaw.length >= raw.length * 0.97,
    "the gate keeps at least 97% of the raw results (no over-rejection)",
    `${indianRaw.length}/${raw.length} judged Indian`,
  );

  const droppedForeign = raw.length - indianRaw.length;
  console.log(`\ngate rejected ${droppedForeign} of ${raw.length} raw results as foreign.`);

  const byCountry = new Map<string, number>();
  for (const r of raw) {
    const c = detectForeignCountry({ address: r.address, components: r.components });
    if (c) byCountry.set(c, (byCountry.get(c) ?? 0) + 1);
  }
  if (byCountry.size) {
    console.log("rejected by country:");
    for (const [c, n] of [...byCountry].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${c}  ${n}`);
    }
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(async () => {
    await sql.end();
    process.exit(failures ? 1 : 0);
  });
