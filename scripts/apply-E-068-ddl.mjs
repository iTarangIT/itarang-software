// Apply only the E-068 DDL directly to sandbox. Self-contained — does not
// invoke drizzle-kit (which interactively prompts on rename heuristics that
// keep tripping during parallel multi-unit loops).
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL missing");
  process.exit(2);
}

const sql = postgres(url, { ssl: "require" });

try {
  await sql`
    CREATE TABLE IF NOT EXISTS nbfc_risk_rule_change_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      rule_key varchar(64) NOT NULL,
      previous_value numeric(12, 4) NOT NULL,
      new_value numeric(12, 4) NOT NULL,
      requested_by uuid NOT NULL,
      approved_by uuid,
      status varchar(32) NOT NULL,
      requested_at timestamptz NOT NULL DEFAULT now(),
      applied_at timestamptz
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS nbfc_risk_rule_change_requests_status_idx
      ON nbfc_risk_rule_change_requests(status)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS nbfc_risk_rule_change_requests_rule_key_idx
      ON nbfc_risk_rule_change_requests(rule_key)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS nbfc_risk_rule_change_requests_requested_by_idx
      ON nbfc_risk_rule_change_requests(requested_by)
  `;
  console.log("E-068 DDL applied successfully");
} catch (e) {
  console.error("E-068 DDL failed:", e);
  process.exit(1);
} finally {
  await sql.end({ timeout: 1 });
}
