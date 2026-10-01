// Read-only: where conversion credit (tracker ID 117) stands on database-1 / database-2.
//   node scripts/_probe-id117-closing-owner.mjs database-1
//   node scripts/_probe-id117-closing-owner.mjs database-2
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
    console.log(`\n## ${title}`);
    console.table(await q);
  } catch (e) {
    console.log(`  failed: ${e.message}`);
  }
};

await show("closed / won leads and their closing owner", sql`
  SELECT lead_status,
         count(*)::int AS leads,
         count(*) FILTER (WHERE closing_owner_id IS NULL)::int AS no_closing_owner,
         count(*) FILTER (WHERE closing_owner_id IS NOT NULL AND closing_owner_id = current_owner_id)::int AS closer_is_current_owner,
         count(*) FILTER (WHERE closing_owner_id IS NOT NULL AND closing_owner_id IS DISTINCT FROM current_owner_id)::int AS closer_differs,
         count(*) FILTER (WHERE closed_at IS NULL)::int AS no_closed_at
    FROM dealer_leads WHERE lead_status IN ('Converted', 'Lost', 'Won') GROUP BY 1 ORDER BY 1`);

await show("closing owner's role (Converted / Won)", sql`
  SELECT dl.lead_status, COALESCE(lower(u.role), CASE WHEN dl.closing_owner_id IS NULL THEN '(none)' ELSE '(not a user)' END) AS closer_role,
         count(*)::int AS leads
    FROM dealer_leads dl LEFT JOIN users u ON u.id::text = dl.closing_owner_id
   WHERE dl.lead_status IN ('Converted', 'Won') GROUP BY 1, 2 ORDER BY 1, 3 DESC`);

await show("ownership evidence on closed leads", sql`
  SELECT dl.lead_status,
         count(*)::int AS leads,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM lead_touchpoints t WHERE t.dealer_lead_id = dl.id
                 AND t.to_owner_id IS NOT NULL AND t.performed_at <= dl.closed_at))::int AS hop_before_close,
         count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM lead_touchpoints t WHERE t.dealer_lead_id = dl.id
                 AND t.to_owner_id IS NOT NULL AND t.performed_at <= dl.closed_at)
              AND EXISTS (SELECT 1 FROM lead_touchpoints t WHERE t.dealer_lead_id = dl.id
                 AND (t.to_owner_id IS NOT NULL OR t.from_owner_id IS NOT NULL) AND t.performed_at > dl.closed_at))::int AS only_hop_after_close,
         count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM lead_touchpoints t WHERE t.dealer_lead_id = dl.id
                 AND (t.to_owner_id IS NOT NULL OR t.from_owner_id IS NOT NULL)))::int AS no_hop_at_all,
         count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM lead_touchpoints t WHERE t.dealer_lead_id = dl.id
                 AND (t.to_owner_id IS NOT NULL OR t.from_owner_id IS NOT NULL))
              AND EXISTS (SELECT 1 FROM lead_touchpoints t WHERE t.dealer_lead_id = dl.id
                 AND t.touchpoint_type IN ('ownership_transfer', 'asm_transfer') AND t.performed_at > dl.closed_at))::int AS no_hop_but_transfer_after_close
    FROM dealer_leads dl
   WHERE dl.lead_status IN ('Converted', 'Lost') AND dl.closed_at IS NOT NULL GROUP BY 1 ORDER BY 1`);

await show("asm_transfer touchpoints: is the recipient recorded?", sql`
  SELECT count(*)::int AS transfers,
         count(*) FILTER (WHERE t.to_owner_id IS NOT NULL)::int AS recipient_recorded,
         count(*) FILTER (WHERE t.to_owner_id IS NOT NULL AND t.to_owner_id IS DISTINCT FROM dl.asm_id)::int AS recipient_is_not_current_asm,
         count(*) FILTER (WHERE t.to_owner_id IS NULL)::int AS recipient_missing,
         min(t.performed_at)::date AS first, max(t.performed_at)::date AS last
    FROM lead_touchpoints t JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
   WHERE t.touchpoint_type = 'asm_transfer'`);

await show("Funnel by Owner today vs by closing owner (last 30 days)", sql`
  WITH worked AS (
      SELECT DISTINCT t.performed_by, t.dealer_lead_id FROM lead_touchpoints t
       WHERE t.performed_by IS NOT NULL AND t.performed_at >= NOW() - INTERVAL '30 days'
  ), old AS (
      SELECT w.performed_by::text AS person, count(*)::int AS n
        FROM worked w JOIN dealer_leads dl ON dl.id = w.dealer_lead_id
       WHERE dl.lead_status = 'Converted' GROUP BY 1
  ), neu AS (
      SELECT dl.closing_owner_id AS person, count(*)::int AS n FROM dealer_leads dl
       WHERE dl.lead_status = 'Converted' AND dl.closing_owner_id IS NOT NULL
         AND dl.closed_at >= NOW() - INTERVAL '30 days' GROUP BY 1
  )
  SELECT COALESCE(u.name, '(unknown)') AS person, lower(u.role) AS role,
         COALESCE(o.n, 0) AS credited_today, COALESCE(n.n, 0) AS by_closing_owner
    FROM (SELECT person FROM old UNION SELECT person FROM neu) p
    LEFT JOIN old o ON o.person = p.person LEFT JOIN neu n ON n.person = p.person
    LEFT JOIN users u ON u.id::text = p.person
   ORDER BY 3 DESC, 4 DESC LIMIT 25`);

await show("Converted in the last 30 days (the true total)", sql`
  SELECT count(*)::int AS converted FROM dealer_leads
   WHERE lead_status = 'Converted' AND closed_at >= NOW() - INTERVAL '30 days'`);

await sql.end();
