import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
const sql = postgres(url, { ssl: { rejectUnauthorized: false } });

// Columns the app's INSERT/SELECT expect (from schema.ts videoKycVerifications).
const expected = [
  "id", "lead_id", "nbfc_id", "tenant_id", "vkyc_ref", "mode", "status",
  "match_score", "liveliness", "static_risk", "prerecorded_risk",
  "face_match_score", "geo_location", "provider_name", "provider_raw_status",
  "provider_raw_payload", "failure_reason", "link_channel", "link_sent_at",
  "link_expires_at", "triggered_by", "triggered_at", "completed_at",
  "admin_action", "admin_action_by", "admin_action_at", "admin_action_notes",
  "created_at", "updated_at",
];

async function main() {
  const rows = await sql<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]>`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = 'video_kyc_verifications'
    ORDER BY ordinal_position`;
  const present = new Set(rows.map((r) => r.column_name));
  console.log("=== Actual columns in DB ===");
  for (const r of rows) {
    console.log(
      `${r.column_name}  ::${r.data_type}  ${r.is_nullable === "NO" ? "NOT NULL" : "null"}` +
        (r.column_default ? `  default=${r.column_default}` : ""),
    );
  }
  const missing = expected.filter((c) => !present.has(c));
  console.log("\n=== Expected by schema.ts but MISSING in DB ===");
  console.log(missing.length ? missing.join(", ") : "(none — all present)");
  await sql.end();
}
main().catch(async (e) => { console.error(e); await sql.end(); process.exit(1); });
