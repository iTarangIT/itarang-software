// Temporary: a throwaway requester login for the E-316 browser walkthrough.
// `node scripts/_fr-test-requester.js` creates it; `... --remove` deactivates it.
const { createClient } = require('@supabase/supabase-js');
const postgres = require('postgres');
require('dotenv').config({ path: '.env.local', quiet: true });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const sql = postgres(process.env.DATABASE_URL, { ssl: { rejectUnauthorized: false }, max: 1 });
const EMAIL = 'fr-test-ceo@itarangjosh.com';
(async () => {
  const { data } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  let u = data.users.find(x => x.email === EMAIL);
  if (process.argv.includes('--remove')) {
    if (u) {
      await sql`UPDATE feature_request_members SET is_active = false, updated_at = NOW() WHERE user_id = ${u.id}::uuid`;
      await sql`UPDATE users SET is_active = false, updated_at = NOW() WHERE id = ${u.id}::uuid`;
      await supabase.auth.admin.deleteUser(u.id);
    }
    console.log('removed');
  } else {
    if (!u) u = (await supabase.auth.admin.createUser({ email: EMAIL, password: process.env.FR_TEST_PASSWORD || require('crypto').randomBytes(12).toString('base64url'), email_confirm: true, app_metadata: { role: 'product_head' } })).data.user;
    await sql`INSERT INTO users (id,email,name,role,is_active,must_change_password,created_at,updated_at) VALUES (${u.id}::uuid, ${EMAIL}, 'Test CEO', 'product_head', true, false, NOW(), NOW()) ON CONFLICT (id) DO UPDATE SET is_active = true`;
    await sql`INSERT INTO feature_request_members (user_id, seat) VALUES (${u.id}::uuid, 'requester') ON CONFLICT (user_id) DO UPDATE SET seat='requester', is_active = true`;
    console.log('ready', u.id);
  }
  await sql.end();
})().catch(async e => { console.error(e); await sql.end(); process.exit(1); });
