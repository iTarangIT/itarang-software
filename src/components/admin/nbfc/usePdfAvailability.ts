"use client";

/**
 * usePdfAvailability — probe whether a document URL actually resolves to a
 * file before we render it inside a preview <iframe>.
 *
 * WHY: agreement templates / compliance docs live under public/nbfc-uploads/
 * and are served by the /api/nbfc-uploads route. When the underlying file
 * isn't on this server's disk (e.g. viewing on localhost a file uploaded on
 * the sandbox VPS, or a file lost in a past deploy), the route returns a
 * 404 JSON body. Without this probe the iframe renders that raw
 * `{"error":"Not found"}` JSON, which looks broken. This lets callers show a
 * clean "preview unavailable" placeholder instead.
 *
 * Uses a cheap HEAD request (Next.js auto-derives HEAD from the route's GET
 * handler), so no PDF bytes are downloaded just to check existence.
 */
import { useEffect, useState } from "react";

export type PdfAvailability = "loading" | "available" | "missing";

export function usePdfAvailability(
  url: string | null | undefined,
): PdfAvailability {
  const [state, setState] = useState<PdfAvailability>(
    url ? "loading" : "missing",
  );

  useEffect(() => {
    if (!url) {
      setState("missing");
      return;
    }
    let cancelled = false;
    setState("loading");
    fetch(url, { method: "HEAD", cache: "no-store" })
      .then((res) => {
        if (cancelled) return;
        const ct = (res.headers.get("content-type") || "").toLowerCase();
        // Treat anything that isn't a real file (404 JSON, the SPA HTML
        // fallback) as missing.
        const looksLikeFile =
          ct.includes("pdf") ||
          ct.includes("image/") ||
          ct.includes("octet-stream");
        setState(res.ok && looksLikeFile ? "available" : "missing");
      })
      .catch(() => {
        if (!cancelled) setState("missing");
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return state;
}
