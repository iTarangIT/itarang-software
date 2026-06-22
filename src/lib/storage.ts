import { createClient } from "./supabase/server";
import { isS3Backend, putObject, filesProxyPath } from "./storage/s3";

type UploadParams = {
  fileBuffer: Buffer;
  fileName: string;
  folder?: string;
  bucket?: string;
  contentType?: string;
  upsert?: boolean;
};

type UploadResult = {
  url: string;
  path: string;
};

/**
 * Minimal Supabase storage helper for server routes.
 */
export async function uploadFileToStorage({
  fileBuffer,
  fileName,
  folder = "",
  bucket = "documents",
  contentType = "application/octet-stream",
  upsert = true,
}: UploadParams): Promise<UploadResult> {
  const cleanFolder = folder.replace(/^\/+|\/+$/g, "");
  const path = cleanFolder ? `${cleanFolder}/${fileName}` : fileName;

  if (isS3Backend) {
    await putObject(bucket, path, fileBuffer, contentType);
    // Store the authenticated-proxy URL (relative) — Block Public Access means
    // there is no public S3 URL. The /api/files route serves it.
    return { url: filesProxyPath(bucket, path), path };
  }

  const supabase = await createClient();
  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, fileBuffer, { contentType, upsert });

  if (error) {
    throw new Error(error.message);
  }

  const { data: publicUrlData } = supabase.storage.from(bucket).getPublicUrl(path);

  return {
    url: publicUrlData.publicUrl,
    path,
  };
}
