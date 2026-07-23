// DESTRUCTIVE: fully delete a lead and every row keyed to it. Atomic (one txn).
//   node scripts/_delete-lead.mjs <lead_internal_id | #IT-reference>
//
// A finance lead fans out across ~30 child tables, some of which FK-reference
// each other (kyc_documents -> kyc_verifications, co_borrower_documents ->
// co_borrowers, …). Rather than hard-code a delete order, we sweep every table
// that carries a `lead_id` column and DELETE in a retry loop guarded by
// savepoints: a delete blocked by a not-yet-cleared child FK rolls back its
// savepoint and is retried on the next pass, so the order resolves itself.
// Coupon / scraped-lead back-refs (different column names) are NULLed, not
// deleted, so we don't destroy shared coupon rows.
import { readFileSync } from "node:fs";
import postgres from "postgres";

let KEY = process.argv[2];
if (!KEY) { console.error("usage: node scripts/_delete-lead.mjs <lead_id | #IT-ref>"); process.exit(1); }
const val = (k) => (readFileSync(".env.local", "utf8").match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim().replace(/^["']|["']$/g, "");
const url = val("DATABASE_URL");
const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });

try {
  console.log("HOST:", new URL(url).hostname);

  // Resolve a #IT-reference to the internal id.
  if (/IT-\d{4}-/i.test(KEY)) {
    const ref = KEY.startsWith("#") ? KEY : "#" + KEY;
    const r = await sql`SELECT id FROM leads WHERE reference_id = ${ref}`;
    if (!r.length) { console.log("No lead with reference", ref); process.exit(0); }
    KEY = r[0].id;
  }
  const lead = await sql`SELECT id, reference_id, owner_name, mobile FROM leads WHERE id = ${KEY}`;
  if (!lead.length) { console.log("No lead with id", KEY); process.exit(0); }
  const LEAD = lead[0].id;
  console.log("Target lead:", LEAD, "|", lead[0].reference_id, "|", lead[0].owner_name, lead[0].mobile);

  const leadIdTables = (await sql`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema='public' AND column_name='lead_id' ORDER BY table_name`).map((r) => r.table_name);

  await sql.begin(async (tx) => {
    // NULL out non-lead_id FK back-refs that would block the final lead delete.
    for (const [t, c] of [
      ["coupon_codes", "reserved_for_lead_id"],
      ["coupon_codes", "used_by_lead_id"],
      ["scraped_dealer_leads", "converted_lead_id"],
    ]) {
      try {
        const u = await tx`UPDATE ${tx(t)} SET ${tx(c)} = NULL WHERE ${tx(c)} = ${LEAD}`;
        if (u.count) console.log(`  NULLed ${t}.${c}: ${u.count}`);
      } catch (e) { console.log(`  skip ${t}.${c} (${e.code})`); }
    }

    // Retry-loop delete of every lead_id table.
    let pending = [...leadIdTables];
    const deleted = {};
    for (let pass = 1; pending.length && pass <= 12; pass++) {
      const stillPending = [];
      let progress = false;
      for (const t of pending) {
        try {
          const n = await tx.savepoint((sp) => sp`DELETE FROM ${sp(t)} WHERE lead_id = ${LEAD}`);
          if (n.count) deleted[t] = n.count;
          progress = true;
        } catch (e) {
          if (e.code === "23503") stillPending.push(t); // FK violation → retry next pass
          else if (e.code === "42703" || e.code === "42P01") { /* no such col/table on this DB */ }
          else throw e;
        }
      }
      pending = stillPending;
      if (!progress && pending.length) throw new Error("FK deadlock, unresolved: " + pending.join(", "));
    }
    if (pending.length) throw new Error("Unresolved after 12 passes: " + pending.join(", "));

    for (const [t, n] of Object.entries(deleted).sort()) console.log(`  ${t}: ${n}`);

    const del = await tx`DELETE FROM leads WHERE id = ${LEAD}`;
    console.log(`  leads: ${del.count}`);
  });

  const remain = await sql`SELECT id FROM leads WHERE id = ${LEAD}`;
  console.log(remain.length ? "\nWARNING — lead still present." : "\nOK — lead and all linked rows deleted.");
} finally {
  await sql.end();
}
