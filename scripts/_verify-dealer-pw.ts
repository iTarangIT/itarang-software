import "./_load-env";

import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { supabaseAdmin } from "../src/lib/supabase/admin";
import { createClient } from "@supabase/supabase-js";

const EMAIL = "gurpreetsidana1979@gmail.com";
const PASSWORD = "password";

async function main() {
  console.log("DB host:", (process.env.DATABASE_URL || "").split("@")[1]?.split("/")[0]);

  const rows: any = await db.execute(
    sql`select id, email, role, is_active, dealer_id, must_change_password
        from users where lower(email) = ${EMAIL.toLowerCase()}`,
  );
  const list = Array.isArray(rows) ? rows : rows?.rows || [];
  console.log("users rows:", JSON.stringify(list, null, 2));

  const { data: authUsers, error } = await supabaseAdmin.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  if (error) throw error;
  const au = authUsers?.users?.find(
    (u) => u.email?.toLowerCase() === EMAIL.toLowerCase(),
  );
  console.log("auth user:", au ? { id: au.id, email: au.email, confirmed: au.email_confirmed_at } : null);

  const anon = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
  const signin = await anon.auth.signInWithPassword({
    email: EMAIL,
    password: PASSWORD,
  });
  console.log(
    "signInWithPassword:",
    signin.error ? `FAILED — ${signin.error.message}` : `OK (user ${signin.data.user?.id})`,
  );
  await new Promise((r) => setTimeout(r, 200));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("VERIFY FAILED:", e?.message || e);
    process.exit(1);
  });
