// read_document — what a photo / PDF the rep sent says: the kind of document and
// the dealer details printed on it (visiting card, shop board, GST certificate,
// shop licence, PO). Reads only; the rep's next step (create_lead, update_lead,
// attach_document) proposes the write with these values on its card.
//
// Only the rep's OWN attachment (by ref). No PAN / Aadhaar / bank field exists
// (vision.ts, Invariant 8); a PAN card comes back as doc_kind "pan" with its
// number left out, so it can still be filed on the lead.

import { z } from "zod";
import { log } from "@/lib/log";
import { mediaBytes } from "../../media";
import { readDocument as readWithModel } from "../../vision";
import type { ToolResult } from "../../types";
import { defineTool, type ToolFactory } from "../spec";
import { AttachmentId, resolveAttachments } from "../attachments";

export const readDocument: ToolFactory = () =>
    defineTool({
        name: "read_document",
        kind: "read",
        description:
            "Look at a photo or PDF the user sent (by attachment id): says what it is (visiting_card, shop_board, " +
            "gst_certificate, pan, shop_licence, purchase_order, shop_photo, other) and copies the dealer details printed " +
            "on it (name, shop, mobile, email, GSTIN, address, city, state, pincode). Use it before create_lead / " +
            "update_lead from a document, or when you need to know what an uncaptioned photo is.",
        schema: z.object({ attachment_id: AttachmentId }),
        run: async (ctx, input): Promise<ToolResult> => {
            const found = await resolveAttachments(ctx, [input.attachment_id], { kinds: ["image", "document"], forWrite: false });
            if (found.result) return found.result;
            const m = found.rows[0];
            const bytes = await mediaBytes(m);
            if (!bytes || !m.mime_type) return { kind: "unavailable", message: "I couldn't open that file. Please send it again." };
            const read = await readWithModel({ bytes, mimeType: m.mime_type });
            if (read.kind !== "ok") {
                log.warn("[assistant] read_document failed", { userId: ctx.user.id, ref: m.ref, error: read.error });
                return { kind: "unavailable", message: "I couldn't read that file just now. Please try again, or type the details." };
            }
            return {
                kind: "document",
                attachment_id: m.ref,
                doc_kind: read.doc_kind,
                summary: read.summary,
                fields: read.fields,
                unreadable: read.dropped,
            };
        },
    });
