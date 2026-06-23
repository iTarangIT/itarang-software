import { isS3Backend, getObject } from "@/lib/storage/s3";

/**
 * Resolve an internal files-proxy path (`/api/files/<bucket>/<key...>`) to a
 * logical bucket + key. Mirrors filesProxyPath() in lib/storage/s3.ts, which
 * URL-encodes each key segment. Returns null for anything that isn't a proxy
 * path (absolute http(s) URLs, supabase public URLs, etc.).
 */
function parseFilesProxyPath(
  url: string
): { logicalBucket: string; key: string } | null {
  // Tolerate an absolute origin in front of the proxy path.
  const idx = url.indexOf("/api/files/");
  if (idx === -1) return null;
  const rest = url.slice(idx + "/api/files/".length).split("?")[0];
  const segments = rest.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const [logicalBucket, ...keyParts] = segments;
  const key = keyParts
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .join("/");
  if (!logicalBucket || !key) return null;
  return { logicalBucket, key };
}

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
        const buf = await getObject(parsed.logicalBucket, parsed.key);
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
