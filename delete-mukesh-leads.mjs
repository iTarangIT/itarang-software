// One-off: hard-delete the 6 MUKESH PRAJAPATI test leads + all child rows.
// Mirrors the cascade in DELETE /api/dealer/leads/[id], plus
// admin_verification_queue and the `documents` table so the leads vanish from
// both the dealer dashboard and the admin KYC review. Each lead in its own tx.
import fs from "fs";
import postgres from "postgres";

const env = fs.readFileSync(".env.local", "utf8");
const url = env.match(/^DATABASE_URL\s*=\s*["']?([^"'\r\n]+)["']?/m)[1];
const sql = postgres(url, { ssl: "require", max: 1 });

const IDS = [
  "LEAD-20260625-e337b05b",
  "LEAD-20260625-9610e507",
  "LEAD-20260625-d63d905b",
  "LEAD-20260625-d3c80063",
  "LEAD-20260625-1ef84248",
  "LEAD-20260625-0db83b83",
];

try {
  for (const id of IDS) {
    await sql.begin(async (tx) => {
      // approvals reference deals via (entity_type, entity_id) — no lead_id col.
      await tx`DELETE FROM approvals WHERE entity_type = 'deal' AND entity_id IN (SELECT id FROM deals WHERE lead_id = ${id})`;
      await tx`DELETE FROM kyc_documents WHERE lead_id = ${id}`;
      await tx`DELETE FROM kyc_verifications WHERE lead_id = ${id}`;
      await tx`DELETE FROM consent_records WHERE lead_id = ${id}`;
      await tx`DELETE FROM admin_kyc_reviews WHERE lead_id = ${id}`;
      await tx`DELETE FROM admin_verification_queue WHERE lead_id = ${id}`;
      await tx`DELETE FROM other_document_requests WHERE lead_id = ${id}`;
      await tx`DELETE FROM co_borrower_documents WHERE lead_id = ${id}`;
      await tx`DELETE FROM co_borrowers WHERE lead_id = ${id}`;
      await tx`DELETE FROM personal_details WHERE lead_id = ${id}`;
      await tx`DELETE FROM lead_products WHERE lead_id = ${id}`;
      await tx`DELETE FROM documents WHERE lead_id = ${id}`;
      await tx`DELETE FROM loan_offers WHERE lead_id = ${id}`;
      await tx`DELETE FROM loan_applications WHERE lead_id = ${id}`;
      await tx`DELETE FROM loan_files WHERE lead_id = ${id}`;
      await tx`DELETE FROM facilitation_payments WHERE lead_id = ${id}`;
      await tx`DELETE FROM lead_assignments WHERE lead_id = ${id}`;
      await tx`DELETE FROM assignment_change_logs WHERE lead_id = ${id}`;
      await tx`DELETE FROM bolna_calls WHERE lead_id = ${id}`;
      await tx`DELETE FROM ai_call_logs WHERE lead_id = ${id}`;
      await tx`DELETE FROM call_records WHERE lead_id = ${id}`;
      await tx`DELETE FROM deployed_assets WHERE lead_id = ${id}`;
      await tx`DELETE FROM deals WHERE lead_id = ${id}`;
      await tx`UPDATE coupon_codes SET reserved_for_lead_id = NULL WHERE reserved_for_lead_id = ${id}`;
      await tx`UPDATE coupon_codes SET used_by_lead_id = NULL WHERE used_by_lead_id = ${id}`;
      await tx`UPDATE coupon_audit_log SET lead_id = NULL WHERE lead_id = ${id}`;
      await tx`UPDATE scraped_dealer_leads SET converted_lead_id = NULL WHERE converted_lead_id = ${id}`;
      const del = await tx`DELETE FROM leads WHERE id = ${id} RETURNING id`;
      console.log(del.length ? `deleted ${id}` : `not found ${id}`);
    });
  }
  console.log("done");
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
