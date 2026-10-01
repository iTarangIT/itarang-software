// Attachment ids ("m7k2q9") as tools take them. Resolved for the acting user
// ONLY (media.ts findMedia), so a guessed or copied ref from someone else is
// simply "not found". Write tools also require it unused: a photo files once.

import { z } from "zod";
import { findMedia, type MediaKind, type MediaRow } from "../media";
import type { ToolContext, ToolResult } from "../types";

export const AttachmentId = z
    .string()
    .trim()
    .min(2)
    .max(12)
    .describe("An attachment id from the attachments list (e.g. m7k2q9). Never invent one.");

export const DOC_TYPES = [
    "gst_certificate",
    "pan",
    "shop_licence",
    "shop_photo",
    "visiting_card",
    "purchase_order",
    "other",
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DOC_TYPE_LABEL: Record<DocType, string> = {
    gst_certificate: "GST certificate",
    pan: "PAN card",
    shop_licence: "Shop licence",
    shop_photo: "Shop photo",
    visiting_card: "Visiting card",
    purchase_order: "Purchase order",
    other: "Document",
};

/** read_document's classification → the document type it is filed as. */
export function docTypeFromKind(kind: string | null | undefined): DocType {
    if (kind === "shop_board") return "shop_photo";
    return (DOC_TYPES as readonly string[]).includes(kind ?? "") ? (kind as DocType) : "other";
}

/** "photo" / "PDF" / "location" — how a card names an attachment. */
export function attachmentNoun(m: Pick<MediaRow, "kind" | "mime_type">): string {
    if (m.kind === "location") return "location";
    if (m.kind === "image") return "photo";
    return m.mime_type === "application/pdf" ? "PDF" : "file";
}

export function countNoun(rows: readonly Pick<MediaRow, "kind" | "mime_type">[]): string {
    const n = new Map<string, number>();
    for (const r of rows) n.set(attachmentNoun(r), (n.get(attachmentNoun(r)) ?? 0) + 1);
    return [...n.entries()].map(([k, c]) => `${c} ${k}${c > 1 ? "s" : ""}`).join(" + ");
}

/**
 * Resolve refs for the acting user. `forWrite` = must not be used yet.
 * Returns the rows in the order given, or the result the tool returns instead.
 */
export async function resolveAttachments(
    ctx: ToolContext,
    refs: readonly string[],
    opts: { kinds: readonly MediaKind[]; forWrite: boolean },
): Promise<{ rows: MediaRow[]; result?: undefined } | { rows?: undefined; result: ToolResult }> {
    const rows: MediaRow[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
        const m = await findMedia(ctx.user.id, ref);
        if (!m) {
            return { result: { kind: "question", question: `I can't find attachment ${ref}. Could you send the photo or file again?` } };
        }
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        if (!opts.kinds.includes(m.kind)) {
            const want = opts.kinds.map((k) => (k === "image" ? "a photo" : k === "document" ? "a file" : "a location")).join(" or ");
            return { result: { kind: "declined", reason: `${m.ref} is a ${attachmentNoun(m)}; this needs ${want}.` } };
        }
        if (opts.forWrite && m.used_at) {
            return { result: { kind: "declined", reason: `${m.ref} was already saved with an earlier change. Send it again to use it here.` } };
        }
        rows.push(m);
    }
    return { rows };
}

/** What the executor needs of a stored file, frozen into the plan. */
export const PlannedFile = z.object({
    media_id: z.string().uuid(),
    ref: z.string(),
    kind: z.enum(["image", "document"]),
    storage_bucket: z.string(),
    storage_key: z.string(),
    mime_type: z.string().nullable(),
    byte_size: z.number().nullable(),
    file_name: z.string().nullable(),
});
export type PlannedFile = z.infer<typeof PlannedFile>;

export function plannedFile(m: MediaRow): PlannedFile {
    if (m.kind === "location" || !m.storage_bucket || !m.storage_key) throw new Error(`${m.ref} has no stored file`);
    return {
        media_id: m.id,
        ref: m.ref,
        kind: m.kind,
        storage_bucket: m.storage_bucket,
        storage_key: m.storage_key,
        mime_type: m.mime_type,
        byte_size: m.byte_size,
        file_name: m.file_name,
    };
}
