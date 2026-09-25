// E-307 — upload a document or an EPC quote PDF to an Ecofy lead.
//
// multipart/form-data:
//   file            the file (≤ 25 MB, Ecofy's limit)
//   kind            "document" | "quote"
//   typeCode        document type (kind=document)
//   recordingConsent "true" for CALL_RECORDING
//   quote           JSON of the quote fields (kind=quote)
//   idempotencyKey  uuid, reused on retry (kind=quote)
//
// The server does Ecofy's upload-url → PUT → sha256 commit, so the browser
// never talks to Ecofy and the signing secret stays here.
import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { checkEcofyAction, ECOFY_ALL_ROLES } from "@/lib/ecofy/access";
import { notifyEcofyUpload } from "@/lib/ecofy/notify";
import { ecofyActorName, getEcofyLeadForViewer } from "@/lib/ecofy/queries";
import { refreshLeadFromEcofy, uploadQuote, uploadToEcofy } from "@/lib/ecofy/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BYTES = 25 * 1024 * 1024;

class UploadRefused extends Error {
    constructor(message: string, public status = 400) {
        super(message);
    }
}

const quoteSchema = z.object({
    assessmentId: z.string().min(1),
    epcPartnerId: z.string().min(1),
    systemDesc: z.string().trim().min(3).max(500),
    batteryKwh: z.number().nonnegative().optional(),
    inverterKva: z.number().nonnegative().optional(),
    solarKwp: z.number().nonnegative().optional(),
    equipmentInr: z.number().nonnegative(),
    installationInr: z.number().nonnegative(),
    gstInr: z.number().nonnegative(),
    validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    notes: z.string().trim().max(2000).optional(),
    provisional: z.boolean().optional(),
    provisionalReason: z.string().trim().max(2000).optional(),
});

export const POST = withErrorHandler(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireRole([...ECOFY_ALL_ROLES]);
    const { id } = await ctx.params;
    const lead = await getEcofyLeadForViewer(id, user);

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) throw new UploadRefused("Choose a file");
    if (file.size > MAX_BYTES) throw new UploadRefused("Max 25 MB");
    const kind = form.get("kind") === "quote" ? "quote" : "document";

    const allowed = checkEcofyAction(
        { id: user.id, role: user.role },
        lead,
        kind === "quote" ? "upload_quote" : "upload_document",
    );
    if (!allowed.ok) throw new UploadRefused(allowed.reason, allowed.status);

    const upload = {
        bytes: Buffer.from(await file.arrayBuffer()),
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        typeCode: String(form.get("typeCode") ?? ""),
        recordingConsent: form.get("recordingConsent") === "true" ? true : undefined,
    };
    const actorName = ecofyActorName(user);

    let result: unknown;
    if (kind === "quote") {
        if (upload.mimeType !== "application/pdf") throw new UploadRefused("The EPC quote must be a PDF");
        const fields = quoteSchema.parse(JSON.parse(String(form.get("quote") ?? "{}")));
        const key = z.string().uuid().parse(form.get("idempotencyKey"));
        result = await uploadQuote(lead, upload, fields, actorName, key);
    } else {
        if (!upload.typeCode) throw new UploadRefused("Choose a document type");
        if (upload.typeCode === "EPC_QUOTE") throw new UploadRefused("Upload EPC quotes from the Offer tab");
        result = await uploadToEcofy(lead, upload, actorName);
    }

    await refreshLeadFromEcofy(lead);
    await notifyEcofyUpload({
        leadId: lead.id,
        actor: { id: user.id, name: user.name, role: user.role },
        kind,
        fileName: file.name,
    });
    return successResponse({ result });
});
