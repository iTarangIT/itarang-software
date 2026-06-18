// Fetch a PDF from DigiO's binary endpoints with retry on transient failures.
//
// DigiO's /document/download and /document/download_audit_trail endpoints
// intermittently return HTTP 500 `{code:"SYSTEM_ERROR","message":"System error
// has occurred"}` even when the document status is "completed" and the PDF is
// available moments later. (The status endpoint exposes no signed/audit URL, so
// these binary endpoints are the only source.) A short retry almost always
// catches a working window — without it, whichever endpoint happens to 500 at
// approval time silently drops its attachment from the welcome email/WhatsApp.
//
// Returns the PDF bytes, or null if it never succeeds (callers treat null as
// "attachment unavailable" and proceed without it). A 4xx (genuine not-found /
// bad request) is NOT retried — only 5xx and empty/JSON-error bodies are.

export async function fetchDigioPdfWithRetry(
  url: string,
  authHeader: string,
  opts: { attempts?: number; baseDelayMs?: number; label?: string } = {},
): Promise<ArrayBuffer | null> {
  // The 500s are per-request flakiness (a parallel signed-doc fetch can succeed
  // while the audit-trail fetch fails at the same instant), so several quick
  // retries have good odds of catching a success. 5 attempts with ~0.8s linear
  // backoff ≈ 8s worst case — acceptable for an admin approval, and only paid on
  // a cache miss (the ensure* helpers short-circuit once the URL is cached).
  const attempts = opts.attempts ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 800;
  const label = opts.label ?? "fetchDigioPdfWithRetry";

  for (let i = 0; i < attempts; i++) {
    let retryable = false;
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { Authorization: authHeader, Accept: "application/pdf" },
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });

      if (res.ok) {
        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("json")) {
          // A JSON body on a 200 is an error envelope — retry.
          const body = await res.text().catch(() => "");
          console.warn(`[${label}] returned JSON (attempt ${i + 1})`, {
            body: body.slice(0, 300),
          });
          retryable = true;
        } else {
          const buf = await res.arrayBuffer();
          if (buf.byteLength >= 100) return buf;
          console.warn(`[${label}] pdf too small (attempt ${i + 1})`, {
            byteLength: buf.byteLength,
          });
          retryable = true;
        }
      } else if (res.status >= 500) {
        // Transient DigiO SYSTEM_ERROR — retry.
        const body = await res.text().catch(() => "");
        console.warn(`[${label}] ${res.status} (attempt ${i + 1}/${attempts})`, {
          url,
          body: body.slice(0, 300),
        });
        retryable = true;
      } else {
        // 4xx — genuine not-found / bad request. Don't retry.
        const body = await res.text().catch(() => "");
        console.warn(`[${label}] non-retryable ${res.status}`, {
          url,
          body: body.slice(0, 300),
        });
        return null;
      }
    } catch (err) {
      console.warn(`[${label}] fetch threw (attempt ${i + 1})`, err);
      retryable = true;
    }

    if (retryable && i < attempts - 1) {
      // Linear backoff: 1.2s, 2.4s, 3.6s …
      await new Promise((r) => setTimeout(r, baseDelayMs * (i + 1)));
    }
  }

  return null;
}
