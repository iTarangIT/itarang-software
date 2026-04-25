"use client";

import { useEffect } from "react";

const RELOAD_FLAG = "itarang:chunk-reload-attempted";

function isChunkLoadError(error: Error & { digest?: string }): boolean {
  return (
    error.name === "ChunkLoadError" ||
    /Loading chunk [\w/]+ failed/i.test(error.message) ||
    /Failed to load chunk/i.test(error.message)
  );
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (!isChunkLoadError(error)) return;
    if (typeof window === "undefined") return;

    const alreadyReloaded = sessionStorage.getItem(RELOAD_FLAG) === "true";
    if (!alreadyReloaded) {
      sessionStorage.setItem(RELOAD_FLAG, "true");
      const url = new URL(window.location.href);
      url.searchParams.set("_r", Date.now().toString(36));
      window.location.replace(url.toString());
      return;
    }

    sessionStorage.removeItem(RELOAD_FLAG);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#fafafa",
          color: "#111",
          padding: "24px",
        }}
      >
        <div style={{ maxWidth: 520, textAlign: "center" }}>
          <h1 style={{ fontSize: 22, marginBottom: 12 }}>
            Something went wrong loading this page.
          </h1>
          <p style={{ color: "#555", marginBottom: 20 }}>
            A new version was just deployed. Please refresh to continue. If the
            problem persists, contact support.
          </p>
          <button
            onClick={() => {
              sessionStorage.removeItem(RELOAD_FLAG);
              reset();
            }}
            style={{
              padding: "10px 18px",
              borderRadius: 8,
              border: "1px solid #111",
              background: "#111",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
