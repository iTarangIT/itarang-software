// Provision the fixed "house" dealer that owns WhatsApp customer-onboarding
// leads (entry-chooser option 2 → resolveHouseDealer in src/lib/whatsapp/
// customer-lead.ts). Idempotent: safe to re-run.
//
// Creates/repairs, mirroring the dealer-approve route:
//   1. Supabase Auth user for dealer@itarang.com  (so the account can log in)
//   2. accounts row  id = ACC-ITARANG-HOUSE        (leads.dealer_id FK target)
//   3. dealers row   dealer_id = ACC-ITARANG-HOUSE (active)
//   4. users row     id = auth uuid, role=dealer, dealer_id = ACC-ITARANG-HOUSE
//
// Env (from .env.local): DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL,
//   SUPABASE_SERVICE_ROLE_KEY. Optional: WHATSAPP_HOUSE_DEALER_EMAIL,
//   HOUSE_DEALER_PASSWORD.
//
// Usage:
//   node scripts/provision-house-dealer.mjs --dry   # preview, no writes
//   node scripts/provision-house-dealer.mjs         # apply
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import bcrypt from "bcryptjs";
import { createClient } from "@supabase/supabase-js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
function loadEnv(p){ if(!existsSync(p))return; for(const l of readFileSync(p,"utf8").split(/\r?\n/)){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<0)continue;const k=t.slice(0,i).trim();let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!(k in process.env))process.env[k]=v;}}
loadEnv(join(ROOT,".env.local"));

const DRY = process.argv.includes("--dry");
const EMAIL = (process.env.WHATSAPP_HOUSE_DEALER_EMAIL || "dealer@itarang.com").trim().toLowerCase();
const CODE = "ACC-ITARANG-HOUSE";
const GSTIN = "HOUSEITARANG001"; // 15 chars, satisfies accounts.gstin NOT NULL + UNIQUE
const NAME = "iTarang (House)";
const PASSWORD = process.env.HOUSE_DEALER_PASSWORD || "Itarang@House1";

const host = (process.env.DATABASE_URL || "").replace(/.*@/, "").split(/[:/]/)[0];
console.log(`Host: ${host}`);
console.log(`Mode: ${DRY ? "DRY-RUN (no writes)" : "APPLY"}`);
console.log(`House dealer: ${EMAIL}  code=${CODE}\n`);

const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supaUrl || !supaKey) { console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env."); process.exit(1); }
const supa = createClient(supaUrl, supaKey, { auth: { autoRefreshToken: false, persistSession: false } });

// 1) Find the Supabase Auth user (paginate), else create.
async function findAuthUser(email){
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await supa.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listUsers: ${error.message}`);
    const hit = data.users.find(u => u.email?.toLowerCase() === email);
    if (hit) return hit;
    if (data.users.length < 1000) break;
  }
  return null;
}

let authUserId;
const existing = await findAuthUser(EMAIL);
if (existing) {
  console.log(`Auth user exists: ${existing.id}`);
  authUserId = existing.id;
  if (!DRY) {
    const { error } = await supa.auth.admin.updateUserById(existing.id, {
      password: PASSWORD, email_confirm: true,
      user_metadata: { role: "dealer", dealer_code: CODE },
    });
    if (error) throw new Error(`updateUserById: ${error.message}`);
  }
} else {
  console.log(`Auth user not found — ${DRY ? "would create" : "creating"}.`);
  if (!DRY) {
    const { data, error } = await supa.auth.admin.createUser({
      email: EMAIL, password: PASSWORD, email_confirm: true,
      user_metadata: { role: "dealer", dealer_code: CODE },
    });
    if (error) throw new Error(`createUser: ${error.message}`);
    authUserId = data.user.id;
    console.log(`Created auth user: ${authUserId}`);
  } else {
    authUserId = "(new-auth-uuid)";
  }
}

if (DRY) {
  console.log("\nDRY-RUN — would upsert accounts / dealers / users for the above. Re-run without --dry to apply.");
  process.exit(0);
}

const passwordHash = await bcrypt.hash(PASSWORD, 10);
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query("BEGIN");
try {
  // 2) accounts row (leads.dealer_id FK target)
  await c.query(
    `INSERT INTO accounts (id, business_entity_name, gstin, dealer_code, contact_name, contact_email, status, onboarding_status, created_by)
     VALUES ($1,$2,$3,$1,$4,$5,'active','approved',$6)
     ON CONFLICT (id) DO UPDATE SET status='active', onboarding_status='approved',
       contact_email=EXCLUDED.contact_email, dealer_code=EXCLUDED.dealer_code, updated_at=now()`,
    [CODE, NAME, GSTIN, "iTarang House", EMAIL, authUserId],
  );

  // 3) dealers row (active) — keyed by unique dealer_id
  await c.query(
    `INSERT INTO dealers (dealer_id, company_name, company_type, owner_email, finance_enabled, onboarding_status, activated_at)
     VALUES ($1,$2,'individual',$3,true,'active',now())
     ON CONFLICT (dealer_id) DO UPDATE SET onboarding_status='active', finance_enabled=true, activated_at=now(), updated_at=now()`,
    [CODE, NAME, EMAIL],
  );

  // 4) users row — match by id or email, else insert. id MUST equal auth uuid.
  const found = (await c.query(
    `SELECT id, email FROM users WHERE id=$1 OR lower(email)=lower($2) LIMIT 1`,
    [authUserId, EMAIL],
  )).rows[0];
  if (found) {
    await c.query(
      `UPDATE users SET id=$1, email=$2, name=$3, role='dealer', dealer_id=$4,
              is_active=true, password_hash=$5, must_change_password=false, updated_at=now()
       WHERE id=$6 OR lower(email)=lower($2)`,
      [authUserId, EMAIL, "iTarang House Dealer", CODE, passwordHash, found.id],
    );
  } else {
    await c.query(
      `INSERT INTO users (id, email, name, role, dealer_id, is_active, password_hash, must_change_password)
       VALUES ($1,$2,$3,'dealer',$4,true,$5,false)`,
      [authUserId, EMAIL, "iTarang House Dealer", CODE, passwordHash],
    );
  }

  // 5) Approved dealer_onboarding_applications row. The web dealer dashboard
  //    reads this (findLatestDealerOnboardingApplication by dealer_user_id /
  //    owner_email) to decide Approved/Active vs "Under Review". WhatsApp routing
  //    is unaffected (it keys off the session's own application, not this row).
  const app = (await c.query(
    `SELECT id FROM dealer_onboarding_applications
      WHERE dealer_user_id=$1 OR lower(owner_email)=lower($2)
      ORDER BY updated_at DESC LIMIT 1`,
    [authUserId, EMAIL],
  )).rows[0];
  if (app) {
    await c.query(
      `UPDATE dealer_onboarding_applications
          SET dealer_user_id=$1, dealer_code=$2, owner_email=$3, company_name=$4,
              onboarding_status='approved', review_status='approved',
              dealer_account_status='active', completion_status='completed',
              finance_enabled=true, approved_at=now(),
              submitted_at=COALESCE(submitted_at, now()), updated_at=now()
        WHERE id=$5`,
      [authUserId, CODE, EMAIL, NAME, app.id],
    );
  } else {
    await c.query(
      `INSERT INTO dealer_onboarding_applications
         (dealer_user_id, dealer_code, owner_email, owner_name, company_name, company_type,
          finance_enabled, onboarding_status, review_status, dealer_account_status,
          completion_status, source, submitted_at, approved_at, dealer_confirmed_at)
       VALUES ($1,$2,$3,$4,$5,'sole_proprietorship',true,'approved','approved','active',
               'completed','web',now(),now(),now())`,
      [authUserId, CODE, EMAIL, "iTarang House Dealer", NAME],
    );
  }

  await c.query("COMMIT");
  console.log("\n✓ COMMIT.");
} catch (e) {
  await c.query("ROLLBACK");
  console.error("\nROLLBACK —", e.message);
  await c.end();
  process.exit(1);
}

// Verify
const v = (await c.query(
  `SELECT u.id, u.email, u.role, u.dealer_id, a.id AS account_id, a.status
     FROM users u LEFT JOIN accounts a ON a.id=u.dealer_id
    WHERE lower(u.email)=lower($1)`, [EMAIL])).rows;
console.log("\nVerification:");
console.table(v);
await c.end();
console.log(`\nHouse dealer ready. Login: ${EMAIL} / ${PASSWORD}`);
