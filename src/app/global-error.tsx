"use client";

import { useEffect, useState } from "react";
import {
  clearReloadGuard,
  hardReload,
  isChunkErrorMessage,
  shouldGuardReload,
} from "@/lib/chunk-recovery";

function reportToServer(error: Error & { digest?: string }, chunkError: boolean): void {
  try {
    const body = JSON.stringify({
      scope: "global-error",
      pathname: typeof window !== "undefined" ? window.location.pathname : null,
      message: error?.message ?? String(error),
      name: error?.name,
      stack: error?.stack,
      digest: error?.digest,
      chunkError,
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
      timestamp: new Date().toISOString(),
    });
    // Use sendBeacon when available so the report still goes out even if we
    // immediately reload the page right after.
    if (typeof navigator !== "undefined" && "sendBeacon" in navigator) {
      const blob = new Blob([body], { type: "application/json" });
      navigator.sendBeacon("/api/internal/log-client-error", blob);
    } else {
      void fetch("/api/internal/log-client-error", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      });
    }
  } catch {
    // Best-effort — never let a logging failure compound the user-visible error.
  }
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const chunk = isChunkErrorMessage(error?.message);
  const [reloadGuarded, setReloadGuarded] = useState(false);

  useEffect(() => {
    reportToServer(error, chunk);
    if (!chunk) return;
    if (shouldGuardReload(error.message)) {
      // Already auto-reloaded once for this signature — don't loop. Show the
      // diagnostic UI so the user can see what actually broke.
      setReloadGuarded(true);
      return;
    }
    void hardReload();
  }, [error, chunk]);

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
              maxWidth: "42rem",
              width: "100%",
              backgroundColor: "white",
              borderRadius: "1rem",
              boxShadow: "0 4px 12px rgba(0,0,0,0.05)",
              overflow: "hidden",
              border: "1px solid #fecaca",
            }}
          >
            <div style={{ backgroundColor: "#fef2f2", padding: "1rem 1.5rem", borderBottom: "1px solid #fecaca" }}>
              <h1 style={{ fontSize: "1.125rem", fontWeight: 600, color: "#7f1d1d", margin: 0 }}>
                {chunk ? "Required script bundle missing" : "Application error"}
              </h1>
              <p style={{ color: "#b91c1c", fontSize: "0.875rem", marginTop: "0.25rem", marginBottom: 0 }}>
                {chunk
                  ? reloadGuarded
                    ? "Auto-reload was already attempted and didn't help — the chunk genuinely isn't on the server. Please contact support."
                    : "The app tried to load a script bundle that no longer exists on the server. Reloading…"
                  : "An unexpected error occurred while rendering this page."}
              </p>
            </div>

            <div style={{ padding: "1.25rem 1.5rem" }}>
              <p style={{ fontSize: "0.7rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "#6b7280", margin: "0 0 0.25rem 0" }}>
                Error
              </p>
              <p style={{
                fontSize: "0.875rem",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                backgroundColor: "#f9fafb",
                border: "1px solid #e5e7eb",
                borderRadius: "0.5rem",
                padding: "0.5rem 0.75rem",
                margin: 0,
                wordBreak: "break-word",
              }}>
                {error?.name ? `${error.name}: ` : ""}{error?.message ?? "Unknown error"}
              </p>

              {error?.digest ? (
                <>
                  <p style={{ fontSize: "0.7rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "#6b7280", margin: "1rem 0 0.25rem 0" }}>
                    Digest
                  </p>
                  <p style={{
                    fontSize: "0.875rem",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    backgroundColor: "#f9fafb",
                    border: "1px solid #e5e7eb",
                    borderRadius: "0.5rem",
                    padding: "0.5rem 0.75rem",
                    margin: 0,
                  }}>
                    {error.digest}
                  </p>
                </>
              ) : null}

              <p style={{ marginTop: "0.75rem", fontSize: "0.75rem", color: "#6b7280" }}>
                This error has been reported to server logs.
              </p>
            </div>

            <div style={{ backgroundColor: "#f9fafb", borderTop: "1px solid #e5e7eb", padding: "0.875rem 1.5rem", display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
              <button
                onClick={() => {
                  clearReloadGuard();
                  reset();
                }}
                style={{
                  padding: "0.5rem 1rem",
                  fontSize: "0.875rem",
                  fontWeight: 500,
                  color: "#374151",
                  backgroundColor: "white",
                  border: "1px solid #d1d5db",
                  borderRadius: "0.5rem",
                  cursor: "pointer",
                }}
              >
                Retry
              </button>
              <button
                onClick={() => {
                  clearReloadGuard();
                  void hardReload();
                }}
                style={{
                  padding: "0.5rem 1rem",
                  fontSize: "0.875rem",
                  fontWeight: 500,
                  color: "white",
                  backgroundColor: "#059669",
                  border: "none",
                  borderRadius: "0.5rem",
                  cursor: "pointer",
                }}
              >
                Reload
              </button>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
