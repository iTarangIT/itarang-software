import { isS3Backend, getObject } from "@/lib/storage/s3";
import { parseFilesProxyPath } from "@/lib/storage/readStoredDocument";

/**
 * Fetch a public URL into a Node Buffer suitable for use as an email
 * attachment. Returns null on any failure — callers should treat a null
 * result as "attachment unavailable, send email without it" rather than an
 * error, because the welcome email must still go out.
 */
export async function downloadPdfBuffer(
  url: string | null | undefined
): Promise<Buffer | null> {
  if (!url || typeof url !== "string") return null;

  // On the S3 backend, newly-stored doc URLs are RELATIVE files-proxy paths
  // (`/api/files/<bucket>/<key>`) — a server-side fetch() can't parse a
  // relative URL and throws, which previously surfaced as "Signed agreement
  // is not ready yet" during dealer approval. Read straight from storage
  // instead: no HTTP round-trip, no relative-URL parse, no proxy auth.
  if (isS3Backend) {
    const parsed = parseFilesProxyPath(url);
    if (parsed) {
      try {
        const buf = await getObject(parsed.bucket, parsed.key);
        if (!buf || buf.byteLength < 100) {
          console.warn(
            `[downloadPdfBuffer] S3 object missing/too small for ${url}`
          );
          return null;
        }
        return buf;
      } catch (err) {
        console.error("[downloadPdfBuffer] S3 getObject failed:", err);
        return null;
      }
    }
  }

  try {
    // Bound the fetch so a slow/looping upstream (e.g. fetching our own
    // /nbfc-uploads back through the reverse proxy) can't hang the caller —
    // the email must still go out without the attachment.
    const response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      console.warn(
        `[downloadPdfBuffer] non-ok response ${response.status} for ${url}`
      );
      return null;
    }

    const contentType = response.headers.get("content-type") || "";
    // A JSON body here almost always means an error envelope from the
    // upstream storage — skip rather than attach garbage.
    if (contentType.includes("json")) {
      console.warn(`[downloadPdfBuffer] JSON content-type for ${url}`);
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength < 100) {
      console.warn(
        `[downloadPdfBuffer] suspiciously small file (${arrayBuffer.byteLength}b) for ${url}`
      );
      return null;
    }

    return Buffer.from(arrayBuffer);
  } catch (err) {
    console.error("[downloadPdfBuffer] fetch failed:", err);
    return null;
  }
}
