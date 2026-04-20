import "dotenv/config";
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const ADMIN_EMAIL = "anirudh@itarang.com";
const ADMIN_ROLES = new Set(["admin", "ceo", "business_head", "sales_head"]);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = postgres(url, {
  ssl: { rejectUnauthorized: false },
  max: 1,
});

async function main() {
  console.log(`\nChecking admin access for ${ADMIN_EMAIL}\n`);

  const users = await sql<
    { id: string; email: string; role: string; is_active: boolean; name: string | null }[]
  >`SELECT id, email, role, is_active, name FROM users WHERE email = ${ADMIN_EMAIL} LIMIT 1`;

  if (users.length === 0) {
    console.log(`No row in 'users' table for ${ADMIN_EMAIL}.`);
    console.log(`   Ensure a matching auth user AND a row in 'users' with a role in: admin, ceo, business_head, sales_head.\n`);
  } else {
    const u = users[0];
    const roleOk = ADMIN_ROLES.has(u.role);
    const activeOk = u.is_active === true;

    console.log(`id          : ${u.id}`);
    console.log(`email       : ${u.email}`);
    console.log(`name        : ${u.name ?? "(null)"}`);
    console.log(`role        : ${u.role}${roleOk ? "  OK" : "  NOT an admin role"}`);
    console.log(`is_active   : ${u.is_active}${activeOk ? "  OK" : "  INACTIVE"}`);

    if (!roleOk || !activeOk) {
      console.log(`\nTo fix, run one of:`);
      if (!roleOk) {
        console.log(`   UPDATE users SET role='admin' WHERE email='${ADMIN_EMAIL}';`);
      }
      if (!activeOk) {
        console.log(`   UPDATE users SET is_active=true WHERE email='${ADMIN_EMAIL}';`);
      }
    }
  }

  console.log(`\nDealer applications awaiting review:`);
  const pending = await sql<
    { id: string; company_name: string; onboarding_status: string; review_status: string | null; submitted_at: Date | null; owner_email: string | null }[]
  >`SELECT id, company_name, onboarding_status, review_status, submitted_at, owner_email
    FROM dealer_onboarding_applications
    WHERE onboarding_status IN ('submitted', 'pending_sales_head', 'under_review', 'agreement_in_progress', 'agreement_completed')
    ORDER BY submitted_at DESC NULLS LAST
    LIMIT 10`;

  if (pending.length === 0) {
    console.log(`   No pending applications. After a dealer submits, they will appear here.`);
  } else {
    for (const app of pending) {
      const when = app.submitted_at ? app.submitted_at.toISOString() : "(no submittedAt)";
      console.log(`   - ${app.company_name}  [${app.onboarding_status} / ${app.review_status ?? "-"}]  ${when}  owner=${app.owner_email ?? "-"}`);
    }
    console.log(`\n   These will render at /admin/dealer-verification for ${ADMIN_EMAIL}.`);
  }

  await sql.end();
  console.log();
}

main().catch((err) => {
  console.error("check failed:", err);
  process.exit(1);
});
