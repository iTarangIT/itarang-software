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

  try {
    const response = await fetch(url, { cache: "no-store" });
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
