/**
 * PATCH /api/admin/accounts/[id]/gstin — Correct GSTIN (tracker P1-2).
 *
 * Validates the new GSTIN, refuses it if another account already holds it
 * (as its primary or as an alias), updates accounts.gstin, and keeps the old
 * GSTIN in account_gstins (source 'correction') so invoices raised under it
 * still match this account. One audit_logs row.
 *
 * A GST certificate is required ONLY when the account's onboarding
 * application has none on file. It can come as:
 *   - multipart/form-data: gstin, reason, certificate (PDF / image file), or
 *   - JSON / form field certificate_url (an already-stored file).
 * An uploaded file is stored in the private `documents` bucket and recorded
 * as a dealer_onboarding_documents row (document_type 'gst_certificate') on
 * the application. Without a certificate when one is needed → 422 with
 * code 'certificate_required'.
 *
 * The onboarding application itself is not edited.
 */
import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { accountGstins, accounts, auditLogs, dealerOnboardingDocuments } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { generateId, storedFileUrl, successResponse, withErrorHandler } from "@/lib/api-utils";
import { checkCustomerGstin, GSTIN_CHECK_MESSAGE, isValidGstin, normalizeGstin } from "@/lib/leads/gstin";
import { saveMedia } from "@/lib/whatsapp/storage";
import {
    ACCOUNT_ADMIN_ROLES,
    GST_CERT_DOC_TYPES,
    HttpError,
    requireAccountTables,
} from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const ALLOWED_MIME = new Set(["application/pdf", "image/jpeg", "image/jpg", "image/png", "image/webp"]);
const MAX_BYTES = 20 * 1024 * 1024;

const FieldsSchema = z.object({
    gstin: z.string().trim().min(1, "GSTIN is required").max(20),
    reason: z.string().trim().min(1, "A reason is required").max(1000),
    certificate_url: storedFileUrl.optional().nullable(),
});

export const PATCH = withErrorHandler(async (req: Request, context: RouteContext) => {
    const user = await requireRole(ACCOUNT_ADMIN_ROLES);
    await requireAccountTables();
    const { id } = await context.params;

    // ── Parse JSON or multipart ────────────────────────────────────────────
    let file: File | null = null;
    let raw: Record<string, unknown>;
    const ctype = req.headers.get("content-type") ?? "";
    if (ctype.includes("multipart/form-data")) {
        const form = await req.formData();
        const f = form.get("certificate");
        if (f instanceof File && f.size > 0) file = f;
        raw = {
            gstin: String(form.get("gstin") ?? ""),
            reason: String(form.get("reason") ?? ""),
            certificate_url: form.get("certificate_url") ? String(form.get("certificate_url")) : null,
        };
    } else {
        raw = (await req.json()) as Record<string, unknown>;
    }
    const fields = FieldsSchema.parse(raw);

    const gstin = normalizeGstin(fields.gstin);
    // ID 62 — the check character, and never iTarang's own registration.
    const check = checkCustomerGstin(gstin);
    if (check !== "ok") throw new HttpError(`"${gstin}": ${GSTIN_CHECK_MESSAGE[check]}`, 400);

    // ── Account + current GSTIN ────────────────────────────────────────────
    const [acc] = await db
        .select({ id: accounts.id, gstin: accounts.gstin, pan: accounts.pan })
        .from(accounts)
        .where(eq(accounts.id, id))
        .limit(1);
    if (!acc) throw new HttpError("Account not found", 404);
    const oldGstin = normalizeGstin(acc.gstin);
    if (oldGstin === gstin) throw new HttpError("That is already this account's GSTIN", 400);

    // ── Conflicts: another account's primary GSTIN or alias ───────────────
    const conflicts = (await db.execute(sql`
        SELECT a.id, a.business_entity_name AS name, 'primary' AS kind
          FROM accounts a
         WHERE upper(regexp_replace(a.gstin, '\\s', '', 'g')) = ${gstin} AND a.id <> ${id}
        UNION ALL
        SELECT g.account_id, a.business_entity_name, 'alias'
          FROM account_gstins g
          LEFT JOIN accounts a ON a.id = g.account_id
         WHERE g.gstin = ${gstin} AND g.account_id <> ${id}
         LIMIT 5
    `)) as unknown as Array<{ id: string; name: string | null; kind: string }>;
    if (conflicts.length > 0) {
        const c = conflicts[0];
        return NextResponse.json(
            {
                success: false,
                error: {
                    message: `GSTIN ${gstin} already belongs to account ${c.id}${c.name ? ` (${c.name})` : ""}${c.kind === "alias" ? " as an earlier GSTIN" : ""}.`,
                    code: "gstin_conflict",
                    details: conflicts,
                },
                timestamp: new Date().toISOString(),
            },
            { status: 409 },
        );
    }

    const warnings: string[] = [];
    const pan = (acc.pan ?? "").trim().toUpperCase();
    if (pan && gstin.slice(2, 12) !== pan) {
        warnings.push(`The PAN inside this GSTIN (${gstin.slice(2, 12)}) differs from the account's PAN (${pan}).`);
    }

    // ── Certificate: only when the application has none on file ────────────
    const appRows = (await db.execute(sql`
        SELECT app.id::text AS id
          FROM dealer_onboarding_applications app
         WHERE app.id::text = (SELECT source_application_id FROM account_ownership WHERE account_id = ${id})
            OR app.dealer_code = ${id}
         ORDER BY (app.id::text = (SELECT source_application_id FROM account_ownership WHERE account_id = ${id})) DESC NULLS LAST,
                  app.created_at ASC
         LIMIT 1
    `)) as unknown as Array<{ id: string }>;
    const applicationId = appRows[0]?.id ?? null;

    let hasCert = false;
    if (applicationId) {
        const certs = (await db.execute(sql`
            SELECT 1 FROM dealer_onboarding_documents
             WHERE application_id::text = ${applicationId}
               AND document_type IN (${sql.join(GST_CERT_DOC_TYPES.map((t) => sql`${t}`), sql`, `)})
               AND doc_status <> 'superseded'
             LIMIT 1
        `)) as unknown as unknown[];
        hasCert = certs.length > 0;
    }

    let certificateUrl: string | null = null;
    if (!hasCert) {
        if (file) {
            const mimeType = file.type || "application/octet-stream";
            if (!ALLOWED_MIME.has(mimeType)) {
                throw new HttpError("The certificate must be a PDF or an image (JPG / PNG / WEBP).", 400);
            }
            const buffer = Buffer.from(await file.arrayBuffer());
            if (buffer.byteLength < 100) throw new HttpError("The certificate file is empty or corrupted.", 400);
            if (buffer.byteLength > MAX_BYTES) throw new HttpError("The certificate exceeds the 20 MB limit.", 400);
            const saved = await saveMedia({
                buffer,
                mimeType,
                keyPrefix: applicationId ? `onboarding/${applicationId}` : `accounts/${id}`,
                docType: "gst_certificate",
                fileName: file.name,
            });
            certificateUrl = saved.fileUrl;
            if (applicationId) {
                await db.insert(dealerOnboardingDocuments).values({
                    application_id: applicationId,
                    document_type: "gst_certificate",
                    bucket_name: saved.bucket,
                    storage_path: saved.path,
                    file_name: saved.fileName,
                    file_url: saved.fileUrl,
                    mime_type: mimeType,
                    file_size: saved.fileSize,
                    uploaded_by: user.id,
                    doc_status: "uploaded",
                    verification_status: "pending",
                    metadata: { uploaded_via: "account_gstin_correction", account_id: id, gstin },
                    source: "admin",
                });
            }
        } else if (fields.certificate_url) {
            certificateUrl = fields.certificate_url;
        } else {
            return NextResponse.json(
                {
                    success: false,
                    error: {
                        message:
                            "This account has no GST certificate on file. Upload the certificate for the new GSTIN to correct it.",
                        code: "certificate_required",
                    },
                    timestamp: new Date().toISOString(),
                },
                { status: 422 },
            );
        }
    }

    // ── Apply ──────────────────────────────────────────────────────────────
    const keptOld = Boolean(oldGstin) && isValidGstin(oldGstin);
    await db.transaction(async (tx) => {
        await tx
            .update(accounts)
            .set({ gstin, updated_at: new Date() })
            .where(eq(accounts.id, id));
        // The new GSTIN is now the primary; drop it from this account's aliases.
        await tx.execute(sql`DELETE FROM account_gstins WHERE gstin = ${gstin} AND account_id = ${id}`);
        if (keptOld) {
            await tx
                .insert(accountGstins)
                .values({ gstin: oldGstin, account_id: id, source: "correction", added_by: user.id })
                .onConflictDoNothing();
        }
        await tx.insert(auditLogs).values({
            id: await generateId("AUDIT", auditLogs),
            entity_type: "account",
            entity_id: id,
            action: "account_gstin_correction",
            performed_by: user.id,
            old_data: { gstin: acc.gstin },
            new_data: {
                gstin,
                reason: fields.reason,
                kept_old_as_alias: keptOld,
                certificate_url: certificateUrl,
                application_id: applicationId,
            },
        });
    });

    return successResponse({
        account_id: id,
        gstin,
        previous_gstin: acc.gstin,
        kept_old_as_alias: keptOld,
        certificate_url: certificateUrl,
        warnings,
    });
});
