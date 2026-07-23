// DESTRUCTIVE: fully delete a WhatsApp-onboarded dealer application + all linked
// rows so the same phone can start a FRESH onboarding. Atomic (one txn).
//   node scripts/_delete-dealer.mjs <application_id>
//
// getOrCreateSession() returns the newest session for a phone REGARDLESS of
// status, so the session row must be DELETED (not just closed) for a clean
// re-onboard. Storage objects (S3) for uploaded docs are intentionally left in
// place — orphaned files are harmless and re-onboarding uploads fresh ones.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const APP_ID = process.argv[2];
if (!APP_ID) { console.error("usage: node scripts/_delete-dealer.mjs <application_id>"); process.exit(1); }

const env = readFileSync(".env.local", "utf8");
const val = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim().replace(/^["']|["']$/g, "");
const url = val("DATABASE_URL");

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });
try {
  console.log("HOST:", new URL(url).hostname);
  const app = await sql`SELECT id, company_name, wa_phone FROM dealer_onboarding_applications WHERE id = ${APP_ID}`;
  if (!app.length) { console.log("No application with that id — nothing to do."); process.exit(0); }
  const phone = app[0].wa_phone;
  console.log("Target:", app[0].company_name, "| phone:", phone);

  // Discover every child table with a real FK to dealer_onboarding_applications
  // (defensive: covers child tables not listed explicitly, on whichever DB).
  const fks = await sql`
    SELECT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'dealer_onboarding_applications'`;

  await sql.begin(async (tx) => {
    const sessions = await tx`SELECT id FROM whatsapp_onboarding_sessions WHERE wa_phone = ${phone} OR application_id = ${APP_ID}`;
    const sessIds = sessions.map((s) => s.id);
    if (sessIds.length) {
      const wm = await tx`DELETE FROM whatsapp_messages WHERE session_id = ANY(${sessIds})`;
      console.log(`  whatsapp_messages: ${wm.count}`);
    }

    // Break app -> session ref, then remove the session row(s) for this phone.
    await tx`UPDATE dealer_onboarding_applications SET wa_session_id = NULL WHERE id = ${APP_ID}`;
    const sess = await tx`DELETE FROM whatsapp_onboarding_sessions WHERE wa_phone = ${phone} OR application_id = ${APP_ID}`;
    console.log(`  whatsapp_onboarding_sessions: ${sess.count}`);

    // FK-discovered children (documents, agreement signers/events, etc.).
    for (const f of fks) {
      if (f.table_name === "whatsapp_onboarding_sessions") continue; // handled above
      const d = await tx`DELETE FROM ${tx(f.table_name)} WHERE ${tx(f.column_name)} = ${APP_ID}`;
      if (d.count) console.log(`  ${f.table_name}.${f.column_name}: ${d.count}`);
    }

    // Explicit belt-and-braces for known children even if no FK is declared
    // (database-2 has partial FK coverage).
    for (const t of ["dealer_onboarding_documents", "dealer_agreement_signers", "dealer_agreement_events"]) {
      const d = await tx`DELETE FROM ${tx(t)} WHERE application_id = ${APP_ID}`;
      if (d.count) console.log(`  ${t} (explicit): ${d.count}`);
    }

    const da = await tx`DELETE FROM dealer_onboarding_applications WHERE id = ${APP_ID}`;
    console.log(`  dealer_onboarding_applications: ${da.count}`);
  });

  const remain = await sql`SELECT id FROM dealer_onboarding_applications WHERE id = ${APP_ID}`;
  const sessLeft = await sql`SELECT count(*)::int AS n FROM whatsapp_onboarding_sessions WHERE wa_phone = ${phone}`;
  console.log("\nApplication remaining:", remain.length ? "STILL PRESENT" : "(none — success)");
  console.log("Sessions remaining for phone:", sessLeft[0].n);
  console.log(!remain.length && sessLeft[0].n === 0 ? "\nOK — phone is clean, ready for a fresh WhatsApp onboarding." : "\nWARNING — residue remains, investigate.");
} finally {
  await sql.end();
}
