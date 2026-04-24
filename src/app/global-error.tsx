"use client";

import { useEffect } from "react";

const KEY = "chunk-reload-guard";
const TTL_MS = 60_000;

function isChunkError(msg: string | undefined): boolean {
  if (!msg) return false;
  if (/ChunkLoadError/.test(msg)) return true;
  if (/Loading (CSS )?chunk \d+ failed/.test(msg)) return true;
  if (/\/_next\/static\/(chunks|css)\//.test(msg)) return true;
  return false;
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (!isChunkError(error?.message)) return;
    try {
      const raw = sessionStorage.getItem(KEY);
      const prev = raw ? (JSON.parse(raw) as { sig: string; at: number }) : null;
      const sig = error.message;
      if (prev && prev.sig === sig && Date.now() - prev.at < TTL_MS) return;
      sessionStorage.setItem(KEY, JSON.stringify({ sig, at: Date.now() }));
      window.location.reload();
    } catch {
      window.location.reload();
    }
  }, [error]);

  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, -apple-system, sans-serif", margin: 0 }}>
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1.5rem",
            backgroundColor: "#f8fafc",
          }}
        >
          <div
            style={{
              maxWidth: "28rem",
              backgroundColor: "white",
              padding: "2rem",
              borderRadius: "1rem",
              boxShadow: "0 4px 12px rgba(0,0,0,0.05)",
              textAlign: "center",
            }}
          >
            <h1 style={{ fontSize: "1.25rem", fontWeight: 600, color: "#0f172a", marginTop: 0 }}>
              Something went wrong
            </h1>
            <p style={{ color: "#64748b", fontSize: "0.875rem", lineHeight: 1.5 }}>
              The app ran into an unexpected error. Reloading usually fixes it.
            </p>
            <button
              onClick={() => {
                try {
                  sessionStorage.removeItem(KEY);
                } catch {}
                reset();
              }}
              style={{
                marginTop: "1rem",
                padding: "0.625rem 1.25rem",
                backgroundColor: "#059669",
                color: "white",
                border: "none",
                borderRadius: "0.5rem",
                fontSize: "0.875rem",
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Reload
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
