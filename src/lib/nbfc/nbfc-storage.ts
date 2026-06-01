/**
 * NBFC document storage — Supabase Storage backend for the files that used to
 * live under `public/nbfc-uploads/` (FI visit photos, FI agent reference
 * photos, compliance docs, LSP agreement templates, signer identity docs, and
 * cached signed/audit PDFs from Digio).
 *
 * Why: local-disk storage is not durable across deploys, isn't shared across
 * instances, and (served from a public path) exposed KYC PII. These objects now
 * live in a PRIVATE bucket (`nbfc-documents`) and are served only through the
 * authenticated `/api/nbfc-uploads/[...path]` route.
 *
 * URL scheme is unchanged on purpose: callers still store `/nbfc-uploads/<key>`
 * in the DB, so no DB migration and no read/display-component changes are
 * needed — only the storage backend behind that path changed. The object key
 * inside the bucket is `<key>` (the same sub-path used on disk before, e.g.
 * `fi/<id>/exterior-...jpg` or `<nbfcId>/agreement-template/...pdf`).
 *
 * Uploads/signing use the service-role admin client (server-only) so they work
 * regardless of per-user RLS on a private bucket.
 */
import { supabaseAdmin } from "@/lib/supabase/admin";

export const NBFC_BUCKET = "nbfc-documents";
const URL_PREFIX = "/nbfc-uploads";

/**
 * Normalize a stored value (a `/nbfc-uploads/...` URL, a bare key, or a full
 * origin URL) down to the bucket object key — no leading slash, no
 * `nbfc-uploads/` prefix.
 */
export function normalizeNbfcKey(keyOrUrl: string): string {
  let k = keyOrUrl.trim().replace(/^https?:\/\/[^/]+/i, ""); // drop origin if present
  k = k.replace(/^\/+/, "");
  if (k.startsWith("nbfc-uploads/")) k = k.slice("nbfc-uploads/".length);
  return k;
}

/** The canonical `/nbfc-uploads/<key>` URL stored in the DB for a given key. */
export function nbfcPublicPath(key: string): string {
  return `${URL_PREFIX}/${normalizeNbfcKey(key)}`;
}

/**
 * Upload bytes to the private NBFC bucket and return the `/nbfc-uploads/<key>`
 * URL to persist (identical scheme to the previous local-disk implementation).
 */
export async function putNbfcObject(
  key: string,
  body: Buffer,
  contentType: string,
  opts: { upsert?: boolean } = {},
): Promise<{ url: string; key: string }> {
  const k = normalizeNbfcKey(key);
  const { error } = await supabaseAdmin.storage
    .from(NBFC_BUCKET)
    .upload(k, body, { contentType, upsert: opts.upsert ?? true });
  if (error) throw new Error(`nbfc-storage: upload failed for ${k}: ${error.message}`);
  return { url: nbfcPublicPath(k), key: k };
}

/** Download an object's bytes, or null if it doesn't exist. */
export async function getNbfcObject(key: string): Promise<Buffer | null> {
  const k = normalizeNbfcKey(key);
  const { data, error } = await supabaseAdmin.storage.from(NBFC_BUCKET).download(k);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}

/** A short-lived signed URL for direct browser access, or null if missing. */
export async function signNbfcObject(key: string, expiresSec = 120): Promise<string | null> {
  const k = normalizeNbfcKey(key);
  const { data, error } = await supabaseAdmin.storage.from(NBFC_BUCKET).createSignedUrl(k, expiresSec);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}
