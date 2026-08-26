// Document SAVE (design §5 step 1, §16). Persists the original media exactly as
// the dealer sent it, into the same Supabase bucket the web onboarding flow uses
// (so the existing admin detail renders it unchanged). Uses the service-role
// admin client because the webhook has no user session.

import crypto from "crypto";

import { supabaseAdmin } from "@/lib/supabase/admin";
import { isS3Backend, putObject, removeObjects, filesProxyPath } from "@/lib/storage/s3";

const BUCKET = process.env.WHATSAPP_DOCS_BUCKET || "documents";

export interface SavedMedia {
  bucket: string;
  path: string;
  fileUrl: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
}

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  // Step-4 extra documents accept the same "any format" the web card does.
  "image/heic": "heic",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "video/quicktime": "mov",
};

function extFor(mimeType: string, fileName?: string): string {
  const fromName = fileName?.includes(".")
    ? fileName.split(".").pop()!.toLowerCase()
    : "";
  return EXT_BY_MIME[mimeType] || fromName || "bin";
}

export async function saveMedia(params: {
  buffer: Buffer;
  mimeType: string;
  /** Onboarding application id — used to build the default path prefix. */
  applicationId?: string;
  /** Override the path prefix (e.g. "leads/<leadId>/whatsapp" for customer-lead
   *  KYC docs). Falls back to `whatsapp/<applicationId>` when omitted. */
  keyPrefix?: string;
  docType: string;
  fileName?: string;
}): Promise<SavedMedia> {
  const { buffer, mimeType, applicationId, keyPrefix, docType, fileName } = params;
  const ext = extFor(mimeType, fileName);
  const objectName = `${Date.now()}-${crypto.randomUUID()}.${ext}`;
  const base = keyPrefix ?? `whatsapp/${applicationId ?? "unknown"}`;
  const path = `${base}/${docType}/${objectName}`;

  if (isS3Backend) {
    await putObject(BUCKET, path, buffer, mimeType);
    return {
      bucket: BUCKET,
      path,
      fileUrl: filesProxyPath(BUCKET, path),
      fileName: fileName || objectName,
      fileSize: buffer.length,
      mimeType,
    };
  }

  const { error } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(path, buffer, { contentType: mimeType, upsert: true });
  if (error) {
    throw new Error(`[WhatsApp/storage] upload failed: ${error.message}`);
  }

  const { data } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path);

  return {
    bucket: BUCKET,
    path,
    fileUrl: data.publicUrl,
    fileName: fileName || objectName,
    fileSize: buffer.length,
    mimeType,
  };
}

// Best-effort delete of stored objects (used when a re-uploaded document
// supersedes an older copy, so we don't leave orphaned files in the bucket). A
// failure here is logged but never throws — the DB dedupe is what matters.
export async function removeMedia(
  bucket: string,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return;
  try {
    if (isS3Backend) {
      await removeObjects(bucket, paths);
      return;
    }
    const { error } = await supabaseAdmin.storage.from(bucket).remove(paths);
    if (error) {
      console.error("[WhatsApp/storage] remove failed:", error.message);
    }
  } catch (err) {
    console.error("[WhatsApp/storage] remove threw:", err);
  }
}
