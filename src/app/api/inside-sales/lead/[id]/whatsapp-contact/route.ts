// POST /api/inside-sales/lead/[id]/whatsapp-contact   (multipart)
//   screenshot      image (jpeg / png / webp), optional
//   remarks         text, required
//   dealer_replied  "true" | "false"
//
// Tracker ID 79 (handover P2-7): a WhatsApp chat counts as contact only with a
// screenshot. The file is stored, hashed (a reused image is flagged) and the
// touchpoint written by recordWhatsappContact — the same writer the WhatsApp
// Assistant's log_call uses.

import { randomUUID } from "node:crypto";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { assertOwner } from "@/lib/leads/ownership";
import { withLeadActor } from "@/lib/leads/actorContext";
import { uploadFileToStorage } from "@/lib/storage";
import { recordWhatsappContact, screenshotHash } from "@/lib/leads/whatsappContact";

const MUTATE_ROLES = ["inside_sales_rep", "asm", "admin", "partner"];
const IMAGE_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp" };
const MAX_BYTES = 8 * 1024 * 1024;

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(MUTATE_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);
        await assertOwner(id, user.id);

        const form = await req.formData();
        const remarks = String(form.get("remarks") ?? "").trim();
        if (!remarks) return errorResponse("Remarks are required.", 400);
        const dealerReplied = String(form.get("dealer_replied") ?? "") === "true";
        const file = form.get("screenshot");

        let screenshot: { url: string; sha256: string } | null = null;
        if (file instanceof File && file.size > 0) {
            const ext = IMAGE_TYPES[file.type];
            if (!ext) return errorResponse("The screenshot must be a JPG, PNG or WEBP image.", 400);
            if (file.size > MAX_BYTES) return errorResponse("The screenshot must be under 8 MB.", 400);
            const bytes = Buffer.from(await file.arrayBuffer());
            const stored = await uploadFileToStorage({
                fileBuffer: bytes,
                fileName: `${randomUUID()}.${ext}`,
                folder: `whatsapp-screenshots/${id}`,
                bucket: "documents",
                contentType: file.type,
            });
            screenshot = { url: stored.url, sha256: screenshotHash(bytes) };
        }

        const result = await withLeadActor(user.id, (tx) =>
            recordWhatsappContact(tx, { leadId: id, actorId: user.id, remarks, dealerReplied, screenshot }),
        );
        return successResponse(result);
    },
);
