// ID 166 / E-349: record who uploaded a co-borrower file or a requested
// document, so the file opener can show a dealer only the files it uploaded.
//
// Raw SQL on purpose: the E-349 columns are NOT mirrored in schema.ts (a
// Drizzle INSERT lists every schema column, so mirroring before the migration
// is applied everywhere would break the upload itself). A failure here — most
// likely E-349 not applied yet — is logged and never fails the upload; the
// file then reads as an old row and keeps the old rule.

import { and, desc, eq, isNotNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { dealerOnboardingApplications } from "@/lib/db/schema";

export type UploadSource = "portal" | "public_link" | "whatsapp";

export type UploaderStampTable = "co_borrower_documents" | "other_document_requests";

/**
 * Stamp uploaded_by / upload_source on the rows that now hold a file. `where`
 * picks the rows exactly as the upload just wrote them (by id, or by lead +
 * doc key for the co-borrower "other document" route).
 */
export async function stampUploader(
  table: UploaderStampTable,
  where: { id: string } | { leadId: string; docKey: string },
  uploader: { userId: string | null | undefined; source: UploadSource },
): Promise<void> {
  const userId = uploader.userId?.trim() || null;
  const tableSql = sql.raw(table === "co_borrower_documents" ? "co_borrower_documents" : "other_document_requests");
  const cond =
    "id" in where
      ? sql`id = ${where.id}`
      : sql`lead_id = ${where.leadId} AND doc_key = ${where.docKey}`;
  try {
    await db.execute(sql`
      UPDATE ${tableSql}
         SET uploaded_by = ${userId}::uuid, upload_source = ${uploader.source}
       WHERE ${cond}
    `);
  } catch (err) {
    console.error(
      `[uploader] could not record who uploaded to ${table} (is E-349 applied?):`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * The dealer login behind a WhatsApp console session: the user of the
 * session's dealer application. A WhatsApp upload on a dealer's lead console
 * is the dealer's own upload. Null when the session has no application.
 */
export async function whatsappUploaderId(applicationId: string | null | undefined): Promise<string | null> {
  if (!applicationId) return null;
  try {
    const [app] = await db
      .select({ dealer_user_id: dealerOnboardingApplications.dealer_user_id })
      .from(dealerOnboardingApplications)
      .where(
        and(
          eq(dealerOnboardingApplications.id, applicationId),
          isNotNull(dealerOnboardingApplications.dealer_user_id),
        ),
      )
      .orderBy(desc(dealerOnboardingApplications.updated_at))
      .limit(1);
    return app?.dealer_user_id ?? null;
  } catch (err) {
    console.error("[uploader] WhatsApp dealer lookup failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
