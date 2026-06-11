// Document SAVE (design §5 step 1, §16). Persists the original media exactly as
// the dealer sent it, into the same Supabase bucket the web onboarding flow uses
// (so the existing admin detail renders it unchanged). Uses the service-role
// admin client because the webhook has no user session.

import crypto from "crypto";

import { supabaseAdmin } from "@/lib/supabase/admin";

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
  applicationId: string;
  docType: string;
  fileName?: string;
}): Promise<SavedMedia> {
  const { buffer, mimeType, applicationId, docType, fileName } = params;
  const ext = extFor(mimeType, fileName);
  const objectName = `${Date.now()}-${crypto.randomUUID()}.${ext}`;
  const path = `whatsapp/${applicationId}/${docType}/${objectName}`;

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
