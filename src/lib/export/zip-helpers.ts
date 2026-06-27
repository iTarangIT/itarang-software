/**
 * Shared helpers for building ZIP exports that bundle stored documents.
 *
 * Lifted out of `src/lib/lead/profile-export.ts` so the AI-expense monthly
 * export (and any future bundle) can reuse the same fetch/slug/ext utilities.
 */

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
 * Fetch a public URL into a Buffer, returning null (with a warning) on any
 * failure or empty body so the caller can skip rather than abort the bundle.
 */
export async function fetchAsBuffer(
  url: string,
  logPrefix = "[ZIP Export]",
): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`${logPrefix} fetch ${url} -> HTTP ${res.status}`);
      return null;
    }
    const ab = await res.arrayBuffer();
    if (ab.byteLength === 0) return null;
    return Buffer.from(ab);
  } catch (err) {
    console.warn(
      `${logPrefix} fetch ${url} failed:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
