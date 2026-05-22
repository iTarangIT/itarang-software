import { readFileSync } from "node:fs";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, {
  ssl: "require",
  prepare: false,
  max: 1,
});

try {
  const content = readFileSync(
    "drizzle/E-117_widen_score_loan_refs.sql",
    "utf8",
  );
  await sql.unsafe(content);
  console.log("E-117 applied.");
  const cols = await sql`
    SELECT table_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name = 'loan_sanction_id'
      AND table_name IN ('borrower_risk_scores', 'nbfc_risk_alerts')
    ORDER BY table_name`;
  for (const c of cols) {
    console.log(`  ${c.table_name}.loan_sanction_id : ${c.data_type}`);
  }
} finally {
  await sql.end({ timeout: 2 });
}
