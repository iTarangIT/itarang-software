// attach_document — file 1-5 photos / PDFs the rep sent on a lead they own, as
// one document type (GST certificate, PAN card, shop licence, shop photo,
// visiting card, purchase order, other). PROPOSES only; on Confirm the applier
// consumes the attachments and writes dealer_lead_documents rows (E-311) in
// the executor's transaction. The files are already in S3 (stored on arrival).
//
// No touchpoint: filing a document is not an interaction with the dealer (the
// same reasoning as the lead edit route), and the lead's staleness is not
// checked — a document does not depend on the lead's status.

import { z } from "zod";
import { dealerLeadDocuments } from "@/lib/db/schema";
import { consumeMedia } from "../../media";
import { createPending } from "../../actions";
import type { Preview, ToolResult } from "../../types";
import { defineTool, LeadId, ownedLeadOr, type ToolFactory } from "../spec";
import { leadUrl } from "../leads";
import { defineApplier, type Tx } from "../../applierSpec";
import {
    AttachmentId,
    countNoun,
    DOC_TYPE_LABEL,
    DOC_TYPES,
    PlannedFile,
    plannedFile,
    resolveAttachments,
    type DocType,
} from "../attachments";

const Note = z.string().trim().max(500);

export const AttachDocumentPlan = z.object({
    lead_id: z.string().min(1),
    doc_type: z.enum(DOC_TYPES),
    files: z.array(PlannedFile).min(1).max(5),
    note: z.string().nullable(),
});
export type AttachDocumentPlan = z.infer<typeof AttachDocumentPlan>;

/**
 * The one writer for documents on a dealer lead, shared by attach_document,
 * create_lead and update_lead: consume the attachments (used once — a race
 * rejects the whole action), then one row per file.
 */
export async function fileDocuments(
    tx: Tx,
    a: { leadId: string; docType: DocType; files: readonly PlannedFile[]; note: string | null; userId: string; actionId?: string },
): Promise<string[]> {
    if (a.files.length === 0) return [];
    await consumeMedia(tx, a.files.map((f) => f.media_id), a.actionId);
    const rows = await tx
        .insert(dealerLeadDocuments)
        .values(
            a.files.map((f) => ({
                dealer_lead_id: a.leadId,
                doc_type: a.docType,
                storage_bucket: f.storage_bucket,
                storage_key: f.storage_key,
                mime_type: f.mime_type,
                byte_size: f.byte_size,
                file_name: f.file_name,
                note: a.note,
                source: "whatsapp_assistant",
                media_id: f.media_id,
                uploaded_by: a.userId,
            })),
        )
        .returning({ id: dealerLeadDocuments.id });
    return rows.map((r) => r.id);
}

export const attachDocument: ToolFactory = () =>
    defineTool({
        name: "attach_document",
        kind: "write",
        description:
            "Propose saving photos / PDFs the user sent (attachment ids) to a lead they own, as one document type. " +
            "Use read_document's doc_kind for the type when you read it (shop_board → shop_photo). " +
            "Nothing is saved until Confirm.",
        schema: z.object({
            lead_id: LeadId,
            attachment_ids: z.array(AttachmentId).min(1).max(5),
            doc_type: z.enum(DOC_TYPES),
            note: Note.optional(),
        }),
        run: async (ctx, input): Promise<ToolResult> => {
            const owned = await ownedLeadOr(ctx, input.lead_id);
            if (owned.result) return owned.result;
            const lead = owned.lead;
            const found = await resolveAttachments(ctx, input.attachment_ids, { kinds: ["image", "document"], forWrite: true });
            if (found.result) return found.result;

            const plan: AttachDocumentPlan = {
                lead_id: lead.id,
                doc_type: input.doc_type,
                files: found.rows.map(plannedFile),
                note: input.note?.trim() || null,
            };
            const lines: Preview["lines"] = [
                { label: "Save", value: `${countNoun(found.rows)} as ${DOC_TYPE_LABEL[plan.doc_type]}` },
            ];
            if (plan.note) lines.push({ label: "Note", value: plan.note });
            const preview: Preview = {
                title: `📎 Attach to ${lead.shop_name || lead.dealer_name || lead.id}`,
                lines,
                resets_idle_clock: false,
                warning: null,
                needs_second_confirm: false,
                crm_url: leadUrl(ctx.user, lead.id),
            };
            const { id } = await createPending({
                userId: ctx.user.id,
                tool: "attach_document",
                leadId: lead.id,
                leadVersion: null,
                plan,
                preview,
                before: {},
                sourceMessageId: ctx.messageId,
            });
            return { kind: "preview", action_id: id, preview };
        },
    });

export const attachDocumentApplier = defineApplier<AttachDocumentPlan>({
    schema: AttachDocumentPlan,
    apply: async ({ tx, user, actionId }, p) => {
        const ids = await fileDocuments(tx, {
            leadId: p.lead_id,
            docType: p.doc_type,
            files: p.files,
            note: p.note,
            userId: user.id,
            actionId,
        });
        return { document_ids: ids };
    },
});
