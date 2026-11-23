/**
 * Campaign / reply attachments, kept in the CRM's existing private file store
 * (documents bucket). The sha256 goes into the approval hash.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { liAttachments } from "@/lib/db/schema";
import { uploadFileToStorage } from "@/lib/storage";
import { getObject, isS3Backend } from "@/lib/storage/s3";

import { sha256 } from "../lib/hash";
import type { AttachmentRef } from "../providers/messaging/types";

export const ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024;
const BUCKET = "documents";

export async function saveAttachment(file: File, actorId: string | null) {
  if (file.size > ATTACHMENT_MAX_BYTES) throw Object.assign(new Error("Attachment is larger than 15 MB"), { status: 400 });
  const buf = Buffer.from(await file.arrayBuffer());
  const safe = file.name.replace(/[^\w.\-]+/g, "_").slice(-120) || "attachment";
  const { url, path } = await uploadFileToStorage({
    fileBuffer: buf,
    fileName: `${randomUUID()}-${safe}`,
    folder: "linkedin-attachments",
    bucket: BUCKET,
    contentType: file.type || "application/octet-stream",
  });
  const [row] = await db
    .insert(liAttachments)
    .values({
      file_name: file.name.slice(0, 200),
      content_type: file.type || null,
      size_bytes: buf.length,
      storage_path: path,
      storage_url: url,
      sha256: sha256(buf),
      uploaded_by: actorId,
    })
    .returning();
  return row;
}

/** The bytes to send, re-hashed so the send ticker can check them against the approval. */
export async function loadAttachment(id: string): Promise<(AttachmentRef & { sha256: string }) | null> {
  const [a] = await db.select().from(liAttachments).where(eq(liAttachments.id, id)).limit(1);
  if (!a) return null;
  let data: Buffer | null = null;
  if (isS3Backend) {
    data = await getObject(BUCKET, a.storage_path);
  } else if (/^https?:\/\//.test(a.storage_url)) {
    const res = await fetch(a.storage_url, { signal: AbortSignal.timeout(30_000) });
    if (res.ok) data = Buffer.from(await res.arrayBuffer());
  }
  if (!data) return null;
  return { fileName: a.file_name, contentType: a.content_type, data, sha256: sha256(data) };
}
