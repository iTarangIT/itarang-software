/**
 * Shared helpers for building ZIP exports that bundle stored documents.
 *
 * Lifted out of `src/lib/lead/profile-export.ts` so the AI-expense monthly
 * export (and any future bundle) can reuse the same fetch/slug/ext utilities.
 */

import { readStoredDocument } from "@/lib/storage/readStoredDocument";

/** Lowercased file extension from a name, e.g. "INVOICE.PDF" -> "pdf". */
export function extOf(
  fileName: string | null | undefined,
  fallback = "bin",
): string {
  if (!fileName) return fallback;
  const m = fileName.match(/\.([a-zA-Z0-9]{1,8})$/);
  return m ? m[1].toLowerCase() : fallback;
}

/** Filesystem-safe slug for use as a ZIP entry name. */
export function safeSlug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/_+/g, "_").slice(0, 80);
}

/**
 * Load a stored document URL into a Buffer, returning null (with a warning) on
 * any failure or empty body so the caller can skip rather than abort the
 * bundle. Handles relative `/api/files/...` proxy paths (direct storage read),
 * Supabase storage URLs, and plain absolute URLs.
 */
export async function fetchAsBuffer(
  url: string,
  logPrefix = "[ZIP Export]",
): Promise<Buffer | null> {
  try {
    const { buffer } = await readStoredDocument(url);
    return buffer.byteLength > 0 ? buffer : null;
  } catch (err) {
    console.warn(
      `${logPrefix} fetch ${url} failed:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
