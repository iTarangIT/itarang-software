/**
 * Rewrites legacy ABSOLUTE Supabase-storage URLs held in the DB into the
 * internal proxy paths that actually serve bytes today.
 *
 * Why this exists: rows written before the S3 migration store a fully-qualified
 * Supabase public URL, e.g.
 *   https://<ref>.supabase.co/storage/v1/object/public/dealer-documents/<key>
 * The Supabase project those point at has since been DELETED — its subdomain no
 * longer resolves, so a browser following such a link gets
 * DNS_PROBE_FINISHED_NXDOMAIN, not a 404. The bytes themselves were copied into
 * S3 under `<bucket>/<key>`, and /api/files (and /api/nbfc-uploads) serve them
 * — but only if the href points there.
 *
 * Server code that READS the bytes already handles both URL shapes
 * (readStoredDocument.ts). This module is the counterpart for URLs handed to
 * the BROWSER: normalize before they reach an <a href>/<img src>.
 *
 * Pure — no AWS/Supabase/node imports — so it is safe in client components.
 * The E-251 backfill rewrites the stored rows too; this keeps environments
 * where that migration hasn't been applied yet working regardless.
 */

/** …/storage/v1/object/(public|sign|authenticated)/<bucket>/<key> */
const SUPABASE_OBJECT_RE =
  /^https?:\/\/[^/]+\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+)$/i;

// Buckets served by /api/files/<bucket>/<key>.
const FILES_PROXY_BUCKETS = new Set(["documents", "dealer-documents", "call-recordings"]);
// nbfc-documents has its own route, keyed without the bucket segment.
const NBFC_BUCKET = "nbfc-documents";

/**
 * Map an absolute Supabase storage URL to the proxy path that serves the same
 * object. Returns null for anything that isn't such a URL (already-relative
 * proxy paths, provider-hosted links, empty values) — callers should keep the
 * original in that case.
 */
export function supabaseUrlToProxyPath(url: string): string | null {
  const m = SUPABASE_OBJECT_RE.exec(url.split("?")[0]);
  if (!m) return null;
  const [, bucket, key] = m;
  // `key` keeps the percent-encoding it already carries in the URL, which is
  // exactly what the proxy routes expect (they decode each segment).
  if (bucket === NBFC_BUCKET) return `/api/nbfc-uploads/${key}`;
  if (FILES_PROXY_BUCKETS.has(bucket)) return `/api/files/${bucket}/${key}`;
  // Unknown bucket — /api/files rejects it, so leave the caller's URL alone
  // rather than minting a link that 404s for a different reason.
  return null;
}

/** Normalize a stored file URL for display/linking. Passthrough when it is
 *  already a proxy path, an external link, or empty. */
export function viewableFileUrl<T extends string | null | undefined>(url: T): T | string {
  if (!url || typeof url !== "string") return url;
  return supabaseUrlToProxyPath(url) ?? url;
}
