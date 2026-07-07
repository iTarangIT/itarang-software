import { readFileSync } from "node:fs";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

const env = readFileSync(".env.local", "utf8");
const val = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim().replace(/^["']|["']$/g, "");
const url = val("DATABASE_URL");
const supaUrl = val("SUPABASE_URL") || val("NEXT_PUBLIC_SUPABASE_URL");
const supaKey = val("SUPABASE_SERVICE_ROLE_KEY");

const appId = "2405f0d6-2e6f-4849-930f-1241b84d48a5";     // YOGENDRA ENTERPRISES onboarding app
const userId = "909463a4-2a27-4878-98d0-abdccf272931";    // dealer login user
const sessionId = "395619b7-4d49-4166-8cfe-56562c1db305"; // whatsapp onboarding session

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });
try {
  console.log("HOST:", new URL(url).hostname);

  // Discover FK columns pointing at the applications table (defensive: covers any new child tables)
  const fks = await sql`
    SELECT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'dealer_onboarding_applications'`;

  await sql.begin(async (tx) => {
    const wm = await tx`DELETE FROM whatsapp_messages WHERE session_id = ${sessionId}`;
    console.log(`  whatsapp_messages: ${wm.count}`);

    for (const f of fks) {
      const d = await tx`DELETE FROM ${tx(f.table_name)} WHERE ${tx(f.column_name)} = ${appId}`;
      if (d.count) console.log(`  ${f.table_name}.${f.column_name}: ${d.count}`);
    }

    const dz = await tx`DELETE FROM dealers WHERE application_id = ${appId}`;
    console.log(`  dealers: ${dz.count}`);

    const da = await tx`DELETE FROM dealer_onboarding_applications WHERE id = ${appId}`;
    console.log(`  dealer_onboarding_applications: ${da.count}`);

    const du = await tx`DELETE FROM users WHERE id = ${userId}`;
    console.log(`  users: ${du.count}`);
  });

  // Verify DB
  const remain = await sql`SELECT id FROM dealer_onboarding_applications WHERE id = ${appId}`;
  console.log("DB remaining application:", remain.length ? "STILL PRESENT" : "(none — success)");

  // Remove the Supabase Auth login user so re-onboarding with the same email is clean
  const supa = createClient(supaUrl, supaKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: authUser } = await supa.auth.admin.getUserById(userId).catch(() => ({ data: null }));
  if (authUser?.user) {
    const { error } = await supa.auth.admin.deleteUser(userId);
    console.log("Supabase Auth user:", error ? "DELETE ERROR " + error.message : "deleted (" + authUser.user.email + ")");
  } else {
    console.log("Supabase Auth user: not found (nothing to delete)");
  }
} finally {
  await sql.end();
}
