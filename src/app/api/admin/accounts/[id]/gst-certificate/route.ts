// /api/admin/accounts/[id]/gst-certificate (IDs 65 / 41). Multipart: `file`.
//
// POST            attach (or replace) the GST certificate behind the account's
//                 GSTIN. Stored on the account's onboarding application as a
//                 `gst_certificate` document, the slot the onboarding wizard
//                 writes, so "certificate on file" turns true.
// POST ?read=1    do not store anything: read the GSTIN printed on the file so
//                 Correct GSTIN can pre-fill it for the person to confirm.
//
// The dealer-verification upload route is sales_head / CEO only; this one
// follows the Account management roles so Admin can do it too.

export const runtime = "nodejs";

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { ACCOUNT_MANAGE_ROLES } from "@/lib/accounts/access";
import { readCertificateFile, saveAccountGstCertificate } from "@/lib/accounts/gstCertificate";
import { AccountActionError } from "@/lib/accounts/accountOwner";
import { readDocument } from "@/lib/assistant/vision";

export const POST = withErrorHandler(async (req: Request, context: { params: Promise<{ id: string }> }) => {
    const user = await requireRole([...ACCOUNT_MANAGE_ROLES]);
    const { id } = await context.params;

    let form: FormData;
    try {
        form = await req.formData();
    } catch {
        throw new AccountActionError("Expected a file upload.");
    }
    const file = await readCertificateFile(form.get("file"));

    if (new URL(req.url).searchParams.get("read") === "1") {
        const read = await readDocument({ bytes: file.buffer, mimeType: file.mimeType });
        if (read.kind !== "ok") return successResponse({ gstin: null, summary: null, is_gst_certificate: false });
        return successResponse({
            gstin: read.fields.gstin,
            summary: read.summary,
            is_gst_certificate: read.doc_kind === "gst_certificate",
        });
    }

    return successResponse(await saveAccountGstCertificate({ accountId: decodeURIComponent(id), file, uploadedBy: user.id }));
});
