/**
 * E-088 — apply nbfc_audit_log_exports table directly via SQL.
 *
 * drizzle-kit push interactively asks whether the new table is a rename of
 * an existing one (admin_audit_log_exports from E-072 sibling work, etc.) —
 * we don't want any rename, just an additive CREATE TABLE IF NOT EXISTS.
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env.test.local' });
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const sql = postgres(url, { ssl: { rejectUnauthorized: false }, prepare: false });

const ddl = `
CREATE TABLE IF NOT EXISTS "nbfc_audit_log_exports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "requested_by" uuid NOT NULL,
  "approval_request_id" uuid NOT NULL,
  "mfa_verified_at" timestamp with time zone NOT NULL,
  "from_ts" timestamp with time zone NOT NULL,
  "to_ts" timestamp with time zone NOT NULL,
  "entity_type" varchar(50),
  "row_count" integer,
  "download_url" text,
  "checksum_sha256" varchar(64),
  "expires_at" timestamp with time zone,
  "completed_at" timestamp with time zone
);
CREATE INDEX IF NOT EXISTS "nbfc_audit_log_exports_approval_idx"
  ON "nbfc_audit_log_exports" ("approval_request_id");
CREATE INDEX IF NOT EXISTS "nbfc_audit_log_exports_requested_by_idx"
  ON "nbfc_audit_log_exports" ("requested_by");
`;

try {
  await sql.unsafe(ddl);
  console.log('[E-088] schema applied');
} finally {
  await sql.end({ timeout: 5 });
}
