// Tracker ID 166-B: a returning dealer keeps the files it already uploaded.
//
// The onboarding form now remembers each upload by storage path (never by a
// URL), and sends that path back on autosave / submit instead of uploading
// again. A path is only text, so the server must check it before attaching it
// to an application:
//
//   - already one of THIS application's documents → fine (keeps its stored URL);
//   - one of ANOTHER application's documents → refused (no taking someone
//     else's file by naming its path);
//   - otherwise it must look like a fresh upload from the public form route
//     (/api/uploads/dealer-documents: `<folder>/<ms>-<uuid>-<name>` in the
//     dealer-documents bucket) — never a private folder or an arbitrary key.
//
// The URL stored for a document is always derived here from bucket + path;
// the one the browser sends is ignored. Server only (reads the db).

import { inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { dealerOnboardingDocuments } from "@/lib/db/schema";
import { publicUploadFolder } from "@/lib/storage/fileAccess";
import { filesProxyPath, isS3Backend } from "@/lib/storage/s3";

export const FORM_UPLOAD_BUCKET = "dealer-documents";

const FORM_UPLOAD_FILE = /^\d{10,}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[^/]+$/i;

/** Is this bucket/key what the public onboarding upload route writes? Pure. */
export function isFormUploadKey(bucket: string, key: string): boolean {
  if (bucket !== FORM_UPLOAD_BUCKET) return false;
  const parts = key.split("/");
  if (parts.length !== 2) return false;
  const [folder, file] = parts;
  return publicUploadFolder(folder) === folder && FORM_UPLOAD_FILE.test(file);
}

/** The URL to store for a bucket/key — what the upload route itself returns. */
export function storedDocumentUrl(bucket: string, key: string): string {
  if (isS3Backend) return filesProxyPath(bucket, key);
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
  return base ? `${base}/storage/v1/object/public/${bucket}/${key}` : filesProxyPath(bucket, key);
}

export type StoredPathCheck =
  | { ok: true; urlFor: (bucket: string, key: string) => string }
  | { ok: false; storagePath: string };

/**
 * Check every bucket/path a form sent for `applicationId` (null = a new
 * application). On success `urlFor` gives the URL to store for each one.
 */
export async function checkStoredPaths(
  applicationId: string | null,
  docs: ReadonlyArray<{ bucketName: string; storagePath: string }>,
): Promise<StoredPathCheck> {
  const paths = Array.from(new Set(docs.map((d) => d.storagePath).filter(Boolean)));
  const rows = paths.length
    ? await db
        .select({
          applicationId: dealerOnboardingDocuments.application_id,
          bucketName: dealerOnboardingDocuments.bucket_name,
          storagePath: dealerOnboardingDocuments.storage_path,
          fileUrl: dealerOnboardingDocuments.file_url,
        })
        .from(dealerOnboardingDocuments)
        .where(inArray(dealerOnboardingDocuments.storage_path, paths))
    : [];

  const own = new Map<string, string | null>();
  for (const r of rows) {
    if (applicationId && r.applicationId === applicationId) {
      own.set(`${r.bucketName}/${r.storagePath}`, r.fileUrl);
    }
  }

  for (const d of docs) {
    const id = `${d.bucketName}/${d.storagePath}`;
    if (own.has(id)) continue;
    const elsewhere = rows.some(
      (r) => r.storagePath === d.storagePath && r.applicationId !== applicationId,
    );
    if (elsewhere || !isFormUploadKey(d.bucketName, d.storagePath)) {
      return { ok: false, storagePath: d.storagePath };
    }
  }

  return {
    ok: true,
    urlFor: (bucket, key) => own.get(`${bucket}/${key}`) || storedDocumentUrl(bucket, key),
  };
}
