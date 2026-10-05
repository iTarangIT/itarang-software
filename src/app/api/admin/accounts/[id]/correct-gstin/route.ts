// POST /api/admin/accounts/[id]/correct-gstin — set a missing ("PENDING") or
// wrong GSTIN on the ACCOUNT (ID 65). The onboarding is not edited. The GSTIN
// passes the shared check (shape, check digit, not iTarang's own — ID 62).
//
// Body: JSON { gstin }, or multipart with `gstin` and `file`. The GST
// certificate is required only when the onboarding does not already hold one
// (decided 29 Sep 2026); when it does, a file is optional and replaces it.

export const runtime = "nodejs";

import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { ACCOUNT_MANAGE_ROLES } from "@/lib/accounts/access";
import { accountApplicationId, readCertificateFile, saveAccountGstCertificate, type CertificateFile } from "@/lib/accounts/gstCertificate";
import { AccountActionError, correctAccountGstin, gstCertificateOnFile } from "@/lib/accounts/ownership";

const Gstin = z.string().min(1).max(20);

export const POST = withErrorHandler(async (req: Request, context: { params: Promise<{ id: string }> }) => {
    const user = await requireRole([...ACCOUNT_MANAGE_ROLES]);
    const { id } = await context.params;
    const accountId = decodeURIComponent(id);

    let gstin: string;
    let file: CertificateFile | null = null;
    if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
        const form = await req.formData();
        gstin = Gstin.parse(String(form.get("gstin") ?? ""));
        if (form.get("file")) file = await readCertificateFile(form.get("file"));
    } else {
        gstin = Gstin.parse(((await req.json()) as { gstin?: unknown })?.gstin);
    }

    // An account with no onboarding application has nowhere to keep a
    // certificate, so none can be asked of it.
    const applicationId = await accountApplicationId(accountId);
    if (applicationId && !file && !(await gstCertificateOnFile(accountId))) {
        throw new AccountActionError("No GST certificate is on file for this account. Upload it with the correction.", 422);
    }
    if (file && !applicationId) file = null;

    const result = await correctAccountGstin({ accountId, gstin, correctedBy: user.id });

    // The GSTIN is saved; a storage failure here must not read as "nothing happened".
    let certificate: "saved" | "failed" | null = null;
    if (file) {
        try {
            await saveAccountGstCertificate({ accountId, file, uploadedBy: user.id });
            certificate = "saved";
        } catch (err) {
            console.error("[accounts] GSTIN corrected but the certificate was not stored", accountId, err);
            certificate = "failed";
        }
    }
    return successResponse({ ...result, certificate });
});
