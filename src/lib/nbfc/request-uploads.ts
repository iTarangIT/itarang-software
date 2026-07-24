/**
 * Multipart file intake for the admin → NBFC request loop (E-210).
 *
 * The admin can attach documents to an NBFC reply (answering a per-document
 * verdict) or to a direct message. Files land in the same private
 * `nbfc-documents` bucket the NBFC's own verdict attachments use (E-207), under
 * `admin-attachments/<leadId>/`, and are served through the authenticated
 * /api/nbfc-uploads route — so both the admin and the NBFC can open them.
 */
import { putNbfcObject } from "@/lib/nbfc/nbfc-storage";
import type { RequestAttachment } from "@/lib/nbfc/doc-requests";

export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // 15 MB per file
export const MAX_ATTACHMENTS = 5;

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "file";
}

/**
 * Upload every non-empty `files` entry of a multipart form. Throws
 * `BAD_REQUEST: …` (the routes map that prefix to a 400) when the count or a
 * single file's size is over the limit.
 */
export async function uploadAdminAttachments(
  form: FormData,
  leadId: string,
  field = "files",
): Promise<RequestAttachment[]> {
  const files = form.getAll(field).filter((f): f is File => f instanceof File);
  const real = files.filter((f) => f.size > 0);
  if (real.length > MAX_ATTACHMENTS) {
    throw new Error(`BAD_REQUEST: at most ${MAX_ATTACHMENTS} files per message`);
  }

  const attachments: RequestAttachment[] = [];
  for (const file of real) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`BAD_REQUEST: '${file.name}' exceeds the 15 MB limit`);
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const key = `admin-attachments/${leadId}/${Date.now()}-${safeName(file.name)}`;
    const { url } = await putNbfcObject(
      key,
      buffer,
      file.type || "application/octet-stream",
      { upsert: true },
    );
    attachments.push({
      url,
      name: file.name,
      type: file.type || "application/octet-stream",
      size: file.size,
    });
  }
  return attachments;
}
