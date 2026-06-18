import 'dotenv/config';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
import pg from 'pg';
const phone = process.argv[2] || '918208677782';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const apps = await c.query(
  `select id, company_name, owner_email, owner_phone, wa_phone, source, onboarding_status, review_status
   from dealer_onboarding_applications
   where wa_phone=$1 or owner_email='yogendratyagi802@gmail.com' or id='0ec97fe5-ac46-41df-9d58-b830b3fdf4ac'`,
  [phone]
);
console.log('matching applications:');
console.table(apps.rows);
const sess = await c.query(`select id, wa_phone, application_id, current_state, session_status from whatsapp_onboarding_sessions where wa_phone=$1`, [phone]);
console.log('sessions for phone', phone, ':');
console.table(sess.rows);
const docs = await c.query(`select count(*)::int n from dealer_onboarding_documents where application_id = any($1)`, [apps.rows.map(r=>r.id)]);
console.log('documents tied to those apps:', docs.rows[0].n);
await c.end();
