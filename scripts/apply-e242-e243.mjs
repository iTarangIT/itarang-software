// Applies the two QUOTATION migrations, in dependency order, to whatever
// DATABASE_URL points at in .env.local. Idempotent — safe to re-run:
//   node scripts/apply-e242-e243.mjs
//
//   drizzle/E-242_quotation_draft_dispatch.sql
//   drizzle/E-243_quotation_dealer_decision.sql   (depends on E-242)
//
// ⚠ These were authored as E-237/E-238 and renumbered on 2026-08-16, because
// `main` reached E-241 while the branch was in flight and
// E-237_neodove_crm_assignment / E-238_offer_negotiation already held those
// numbers. If a database was already migrated under the OLD names, it is fully
// migrated — the numbers live in filenames and comments, never in the DB — and
// this script will simply report OK. Do not confuse this with
// scripts/apply-e237.mjs, which applies the unrelated neodove migration.
//
// What breaks without them, and how loudly:
//
//   E-242 is NOT a graceful degradation. dealer_lead_commercials IS mirrored in
//   schema.ts, so drizzle names quote_number and the other four columns in the
//   INSERT the inside-sales commercials route issues. On a database without
//   this file, RAISING A QUOTE 500s outright with `column "quote_number" does
//   not exist`. That is the same trade E-226 made on the same table.
//
//   quotation_dispatches is a new table — without it every send attempt fails
//   at the logging step, so the dealer may receive a quotation we have no
//   record of having sent. That is worse than not sending.
//
//   dealer_leads.contact_email / .gstin are deliberately ABSENT from schema.ts
//   (see the note there, and E-224/E-236 before it) and are read through raw
//   `sql` projections, so an unapplied E-242 costs the quotation feature and
//   leaves the ~20 bare `db.select().from(dealerLeads)` call sites — the leads
//   list, the AI dialer, the CEO overview — untouched.
//
//   E-243 adds the dealer's own answer. Without it the approval link and the
//   WhatsApp buttons resolve but the write fails, so a dealer can tap Approve
//   and have it recorded nowhere.
//
// Both files are wrapped in BEGIN/COMMIT, so a failure anywhere leaves the
// database exactly as it was.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = readFileSync(".env.local", "utf8");
const url = env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g, "");

const FILES = [
  "drizzle/E-242_quotation_draft_dispatch.sql",
  "drizzle/E-243_quotation_dealer_decision.sql",
];

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });
let bad = 0;
try {
  console.log("HOST:", new URL(url).hostname);

  for (const f of FILES) {
    await sql.unsafe(readFileSync(f, "utf8"));
    console.log(`applied ${f}`);
  }

  // Verify by reading the catalogue rather than trusting the apply. A hand-run
  // in pgAdmin can stop halfway through a script; "no error" is not evidence.
  const cols = async (table, names) =>
    (await sql`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ${table}
         AND column_name = ANY(${names})`).map((r) => r.column_name);

  const draft = await cols("dealer_lead_commercials", [
    "quote_number", "quote_pdf_url", "quote_pdf_generated_at", "quote_pdf_error", "quote_snapshot",
  ]);
  const decision = await cols("dealer_lead_commercials", [
    "dealer_decision", "dealer_decision_at", "dealer_decision_via", "dealer_decision_actor", "dealer_decision_note",
  ]);
  const masters = await Promise.all(
    ["product_master_batteries", "product_master_chargers", "product_master_paraphernalia"]
      .map((t) => cols(t, ["hsn_code", "gst_rate_pct"])),
  );
  const lead = await cols("dealer_leads", ["gstin", "contact_email"]);
  const dispatches = (await sql`SELECT to_regclass('public.quotation_dispatches') AS t`)[0].t;
  const seq = (await sql`SELECT to_regclass('public.quotation_number_seq') AS t`)[0].t;
  const idx = (await sql`
    SELECT indexname FROM pg_indexes
     WHERE schemaname = 'public' AND indexname IN (
       'dealer_lead_commercials_quote_number_uniq',
       'dealer_lead_commercials_dealer_decision_idx',
       'quotation_dispatches_commercial_idx',
       'quotation_dispatches_lead_idx')`).length;

  const say = (ok, msg) => { if (!ok) bad++; console.log(`${ok ? "OK" : "FAILED"} — ${msg}`); };

  say(draft.length === 5, `E-242 draft columns on dealer_lead_commercials: ${draft.length}/5. Raising a quote needs all five.`);
  say(!!dispatches, `E-242 quotation_dispatches table: ${dispatches ? "present" : "MISSING"}. Without it a send cannot be recorded.`);
  say(!!seq, `E-242 quotation_number_seq: ${seq ? "present" : "MISSING"}. Without it no quote number can be allocated.`);
  say(masters.every((m) => m.length === 2), `E-242 hsn_code + gst_rate_pct on all three product masters: ${masters.map((m) => m.length).join("/")} of 2 each.`);
  say(lead.length === 2, `E-242 dealer_leads.gstin + .contact_email: ${lead.length}/2. Not in schema.ts by design — read via raw sql.`);
  say(decision.length === 5, `E-243 dealer decision columns: ${decision.length}/5.`);
  say(idx === 4, `indexes: ${idx}/4 present.`);

  // Not a failure — the catalogue is filled by hand, product by product, and a
  // guessed tax rate is a wrong number on a document sent to a dealer.
  const rated = await sql`
    SELECT (SELECT count(*) FROM product_master_batteries      WHERE gst_rate_pct IS NOT NULL)
         + (SELECT count(*) FROM product_master_chargers       WHERE gst_rate_pct IS NOT NULL)
         + (SELECT count(*) FROM product_master_paraphernalia  WHERE gst_rate_pct IS NOT NULL) AS n,
           (SELECT count(*) FROM product_master_batteries)
         + (SELECT count(*) FROM product_master_chargers)
         + (SELECT count(*) FROM product_master_paraphernalia) AS total`;
  const { n, total } = rated[0];
  console.log(
    Number(n) === Number(total)
      ? `INFO — all ${total} catalogue products carry a GST rate.`
      : `INFO — ${n}/${total} catalogue products carry a GST rate. Quotation lines for the rest print "Not set" with a banner rather than a silent 0%. Fill hsn_code + gst_rate_pct before the first quote goes to a dealer.`,
  );

  console.log(bad === 0 ? "\nE-242 + E-243 fully applied." : `\n${bad} check(s) FAILED.`);
} finally {
  await sql.end();
}
process.exit(bad === 0 ? 0 : 1);
