// Read-only: where lead source (ID 81) stands on database-1 / database-2.
//   node scripts/_probe-id81-source.mjs database-1
//   node scripts/_probe-id81-source.mjs database-2
// SELECTs only. Reads that host's URL from .env.local, never prints it.
import postgres from "postgres";
import { readFileSync } from "node:fs";

const target = process.argv[2];
if (!["database-1", "database-2"].includes(target)) throw new Error("usage: database-1 | database-2");
const line = readFileSync(".env.local", "utf8")
  .split(/\r?\n/)
  .find((l) => /^\s*#?\s*DATABASE_URL=/.test(l) && l.includes(`${target}.`));
if (!line) throw new Error(`no DATABASE_URL for ${target} in .env.local`);
const url = line.replace(/^\s*#?\s*DATABASE_URL=/, "").trim().replace(/^["']|["']$/g, "");
const sql = postgres(url, { max: 1, ssl: "require", connection: { default_transaction_read_only: true } });
console.log("target:", new URL(url).host.split(".")[0]);

const show = async (title, q) => {
  try {
    const rows = await q;
    console.log(`\n## ${title}`);
    console.table(rows);
  } catch (e) {
    console.log(`\n## ${title}\n  failed: ${e.message}`);
  }
};

await show("door x origin", sql`
  SELECT COALESCE(source_door, '(none)') AS door,
         count(*)::int AS leads,
         count(*) FILTER (WHERE source_origin IS NULL)::int AS no_origin,
         count(*) FILTER (WHERE acquisition_campaign_id IS NULL)::int AS no_campaign
    FROM dealer_leads GROUP BY 1 ORDER BY 2 DESC`);

await show("no door — what the rows carry", sql`
  SELECT COALESCE(source, '(null)') AS source,
         (upload_batch_id IS NOT NULL) AS has_batch,
         (originator_id IS NOT NULL) AS has_originator,
         (memory ->> 'list_import') AS list_import,
         split_part(id, '-', 1) AS id_prefix,
         count(*)::int AS leads,
         min(created_at)::date AS first, max(created_at)::date AS last
    FROM dealer_leads WHERE source_door IS NULL
   GROUP BY 1, 2, 3, 4, 5 ORDER BY 6 DESC`);

await show("no door — has a 'Lead created' line / a scraped twin / an AI call / a NeoDove link", sql`
  SELECT count(*)::int AS leads,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM lead_touchpoints t
                 WHERE t.dealer_lead_id = dl.id AND t.touchpoint_type = 'lead_created'))::int AS has_created_line,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM scraped_dealer_leads s
                 WHERE right(regexp_replace(s.phone, '[^0-9]', '', 'g'), 10)
                     = right(regexp_replace(dl.phone, '[^0-9]', '', 'g'), 10)))::int AS scraped_twin_any_time,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM neodove_lead_links l WHERE l.dealer_lead_id = dl.id))::int AS neodove_link,
         count(*) FILTER (WHERE dl.phone IS NULL)::int AS no_phone
    FROM dealer_leads dl WHERE dl.source_door IS NULL`);

await show("no origin, by door — bulk uploads by batch label", sql`
  SELECT COALESCE(b.source_label, '(no label)') AS source_label, left(b.file_name, 40) AS file,
         b.created_at::date AS day, count(*)::int AS leads
    FROM dealer_leads dl LEFT JOIN upload_batches b ON b.batch_id = dl.upload_batch_id
   WHERE dl.source_door = 'bulk_upload' AND dl.source_origin IS NULL
   GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 25`);

await show("no origin — rep_create / whatsapp_assistant by month", sql`
  SELECT source_door AS door, to_char(created_at, 'YYYY-MM') AS month, count(*)::int AS leads
    FROM dealer_leads
   WHERE source_origin IS NULL AND source_door IN ('rep_create', 'whatsapp_assistant')
   GROUP BY 1, 2 ORDER BY 1, 2`);

await show("AI-dialer list leads by list name (no origin)", sql`
  SELECT COALESCE(memory ->> 'list_name', '(none)') AS list_name, count(*)::int AS leads
    FROM dealer_leads WHERE source_door = 'ai_dialer' AND source_origin IS NULL
   GROUP BY 1 ORDER BY 2 DESC LIMIT 20`);

await show("events", sql`
  SELECT touchpoint_type, count(*)::int AS n FROM lead_touchpoints
   WHERE touchpoint_type IN ('lead_created', 'lead_reinquiry') GROUP BY 1`);

await show("leads with no 'Lead created' line, by door", sql`
  SELECT COALESCE(source_door, '(none)') AS door, count(*)::int AS leads
    FROM dealer_leads dl
   WHERE NOT EXISTS (SELECT 1 FROM lead_touchpoints t
          WHERE t.dealer_lead_id = dl.id AND t.touchpoint_type = 'lead_created')
   GROUP BY 1 ORDER BY 2 DESC`);

await show("campaign tables", sql`
  SELECT (SELECT count(*)::int FROM acquisition_campaigns) AS acquisition_campaigns,
         (SELECT count(*)::int FROM upload_batches) AS upload_batches,
         (SELECT count(*)::int FROM scraper_runs) AS scraper_runs,
         (SELECT count(DISTINCT scraper_run_id)::int FROM scraped_dealer_leads) AS runs_with_leads`);

await show("columns present", sql`
  SELECT table_name, column_name FROM information_schema.columns
   WHERE (table_name IN ('upload_batches', 'scraper_runs') AND column_name = 'acquisition_campaign_id')
      OR (table_name = 'acquisition_campaigns')
   ORDER BY 1, ordinal_position`);

await show("scraped_dealer_leads columns", sql`
  SELECT column_name FROM information_schema.columns WHERE table_name = 'scraped_dealer_leads' ORDER BY ordinal_position`);

await show("no door — twins in scraper_leads / scraped_dealer_leads, by id prefix and day", sql`
  SELECT split_part(dl.id, '-', 1) AS id_prefix, dl.created_at::date AS day,
         (dl.originator_id IS NOT NULL) AS has_originator,
         count(*)::int AS leads,
         count(DISTINCT date_trunc('minute', dl.created_at))::int AS distinct_minutes,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM scraper_leads s
                 WHERE right(regexp_replace(s.phone, '[^0-9]', '', 'g'), 10)
                     = right(regexp_replace(dl.phone, '[^0-9]', '', 'g'), 10)))::int AS in_scraper_leads,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM scraped_dealer_leads s
                 WHERE right(regexp_replace(s.phone, '[^0-9]', '', 'g'), 10)
                     = right(regexp_replace(dl.phone, '[^0-9]', '', 'g'), 10)))::int AS in_scraped_dealer_leads,
         count(*) FILTER (WHERE dl.shop_name IS NOT NULL AND dl.shop_name = dl.dealer_name)::int AS shop_eq_name,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ai_call_logs a WHERE a.lead_id = dl.id))::int AS ai_called
    FROM dealer_leads dl WHERE dl.source_door IS NULL
   GROUP BY 1, 2, 3 ORDER BY 2, 1`);

await show("no door — DL rows", sql`
  SELECT id, source, created_at::date AS day, (originator_id IS NOT NULL) AS has_originator, lead_status
    FROM dealer_leads WHERE source_door IS NULL AND id LIKE 'DL-%' ORDER BY created_at`);

await show("upload batches", sql`
  SELECT batch_id, left(file_name, 40) AS file, source_label, status, created_at::date AS day,
         (SELECT count(*)::int FROM dealer_leads dl WHERE dl.upload_batch_id = b.batch_id) AS leads
    FROM upload_batches b ORDER BY created_at`);

await show("scraper runs with promoted leads (via phone twin), top 10", sql`
  SELECT r.id, r.started_at::date AS day, left(r.search_queries::text, 60) AS queries,
         count(DISTINCT dl.id)::int AS leads
    FROM scraper_runs r
    JOIN scraped_dealer_leads s ON s.scraper_run_id = r.id
    JOIN dealer_leads dl ON dl.source_door = 'scraper'
     AND right(regexp_replace(dl.phone, '[^0-9]', '', 'g'), 10) = right(regexp_replace(s.phone, '[^0-9]', '', 'g'), 10)
   GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 10`);

await show("scraper-door leads with / without a scrape-run twin", sql`
  SELECT count(*)::int AS scraper_leads,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM scraped_dealer_leads s
              WHERE right(regexp_replace(s.phone, '[^0-9]', '', 'g'), 10)
                  = right(regexp_replace(dl.phone, '[^0-9]', '', 'g'), 10)))::int AS with_run
    FROM dealer_leads dl WHERE dl.source_door = 'scraper'`);

await sql.end();
