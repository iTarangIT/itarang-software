/**
 * The GST certificate behind an account's GSTIN (tracker ID 65).
 *
 * Correct GSTIN is an action on the ACCOUNT, but the certificate lives where
 * the onboarding already keeps documents: a `gst_certificate` row on the
 * account's onboarding application. A certificate is asked for only when none
 * is on file. SERVER ONLY.
 */
import { and, eq, inArray, notInArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { dealerOnboardingDocuments, dealers } from "@/lib/db/schema";
import { removeMedia, saveMedia } from "@/lib/whatsapp/storage";
import { AccountActionError } from "./ownership";

const ALLOWED_MIME = new Set(["application/pdf", "image/jpeg", "image/jpg", "image/png", "image/webp"]);
const MAX_BYTES = 20 * 1024 * 1024; // 20 MB
const DOC_TYPE = "gst_certificate";

export type CertificateFile = { buffer: Buffer; mimeType: string; fileName: string };

/** Type and size checks; throws AccountActionError with the message to show. */
export async function readCertificateFile(file: unknown): Promise<CertificateFile> {
    if (!(file instanceof File)) throw new AccountActionError("A file is required.");
    const mimeType = file.type || "application/octet-stream";
    if (!ALLOWED_MIME.has(mimeType)) throw new AccountActionError("Only PDF or image (JPG/PNG/WEBP) files are allowed.");
    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.byteLength < 100) throw new AccountActionError("File is empty or corrupted.");
    if (buffer.byteLength > MAX_BYTES) throw new AccountActionError("File exceeds the 20 MB limit.");
    return { buffer, mimeType, fileName: file.name };
}

/** The onboarding application an account's documents are kept on; null when it has none. */
export async function accountApplicationId(accountId: string): Promise<string | null> {
    const [dealer] = await db
        .select({ applicationId: dealers.application_id })
        .from(dealers)
        .where(eq(dealers.dealer_id, accountId))
        .limit(1);
    if (!dealer) throw new AccountActionError("Dealer account not found.", 404);
    return dealer.applicationId ? String(dealer.applicationId) : null;
}

/** Store the certificate as the one live `gst_certificate`; earlier copies are superseded. */
export async function saveAccountGstCertificate(input: {
    accountId: string;
    file: CertificateFile;
    uploadedBy: string;
}): Promise<{ document_id: string; file_name: string | null; replaced: number }> {
    const applicationId = await accountApplicationId(input.accountId);
    if (!applicationId) {
        throw new AccountActionError("This account has no onboarding application to keep the certificate on.", 422);
    }
    const { buffer, mimeType, fileName } = input.file;
    const saved = await saveMedia({ buffer, mimeType, applicationId, docType: DOC_TYPE, fileName });

    const prior = await db
        .select({
            id: dealerOnboardingDocuments.id,
            bucket: dealerOnboardingDocuments.bucket_name,
            path: dealerOnboardingDocuments.storage_path,
        })
        .from(dealerOnboardingDocuments)
        .where(
            and(
                eq(dealerOnboardingDocuments.application_id, applicationId),
                eq(dealerOnboardingDocuments.document_type, DOC_TYPE),
                notInArray(dealerOnboardingDocuments.doc_status, ["superseded", "pending_correction"]),
            ),
        );
    if (prior.length) {
        await db
            .update(dealerOnboardingDocuments)
            .set({ doc_status: "superseded", updated_at: new Date() })
            .where(inArray(dealerOnboardingDocuments.id, prior.map((r) => r.id)));
        const byBucket = new Map<string, string[]>();
        for (const r of prior) {
            if (!r.path) continue;
            byBucket.set(r.bucket, [...(byBucket.get(r.bucket) ?? []), r.path]);
        }
        for (const [bucket, paths] of byBucket) await removeMedia(bucket, paths);
    }

    const [inserted] = await db
        .insert(dealerOnboardingDocuments)
        .values({
            application_id: applicationId,
            document_type: DOC_TYPE,
            bucket_name: saved.bucket,
            storage_path: saved.path,
            file_name: saved.fileName,
            file_url: saved.fileUrl,
            mime_type: mimeType,
            file_size: saved.fileSize,
            uploaded_by: input.uploadedBy,
            doc_status: "uploaded",
            verification_status: "pending",
            metadata: { uploaded_via: "account_management", mode: "replace" },
            source: "admin",
        })
        .returning({ id: dealerOnboardingDocuments.id, fileName: dealerOnboardingDocuments.file_name });

    return { document_id: String(inserted.id), file_name: inserted.fileName ?? null, replaced: prior.length };
}
