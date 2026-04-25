"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

export default function KycReviewError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const pathname = usePathname();
  const [reported, setReported] = useState<"idle" | "sending" | "ok" | "fail">("idle");

  useEffect(() => {
    void fetch("/api/internal/log-client-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "admin/kyc-review/[leadId]",
        pathname,
        message: error?.message ?? String(error),
        name: error?.name,
        stack: error?.stack,
        digest: error?.digest,
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
        timestamp: new Date().toISOString(),
      }),
    })
      .then((r) => setReported(r.ok ? "ok" : "fail"))
      .catch(() => setReported("fail"));
  }, [error, pathname]);

  const isChunkError =
    /ChunkLoadError/.test(error?.message ?? "") ||
    /Loading (CSS )?chunk \d+ failed/.test(error?.message ?? "") ||
    /\/_next\/static\/(chunks|css)\//.test(error?.message ?? "");

  return (
    <div className="max-w-3xl mx-auto py-12 px-4">
      <div className="bg-white border border-red-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="bg-red-50 border-b border-red-200 px-6 py-4">
          <h1 className="text-lg font-semibold text-red-900">
            KYC Review failed to load
          </h1>
          <p className="text-sm text-red-700 mt-1">
            {isChunkError
              ? "A required script bundle is missing — usually a stale tab from before a deploy. Reloading should fix it."
              : "An unexpected error occurred while rendering this page."}
          </p>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">
              Error
            </p>
            <p className="text-sm font-mono bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 break-words">
              {error?.name ? `${error.name}: ` : ""}{error?.message ?? "Unknown error"}
            </p>
          </div>

          {error?.digest ? (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">
                Digest
              </p>
              <p className="text-sm font-mono bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                {error.digest}
              </p>
            </div>
          ) : null}

          {error?.stack ? (
            <details className="text-sm">
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1 select-none">
                Stack trace
              </summary>
              <pre className="mt-2 text-xs bg-gray-900 text-gray-100 rounded-lg p-3 overflow-auto max-h-72 whitespace-pre-wrap break-words">
                {error.stack}
              </pre>
            </details>
          ) : null}

          <div className="text-xs text-gray-500">
            Reported to server logs:{" "}
            <span className="font-medium">
              {reported === "idle"
                ? "sending…"
                : reported === "sending"
                  ? "sending…"
                  : reported === "ok"
                    ? "✓ logged"
                    : "✗ failed"}
            </span>
          </div>
        </div>

        <div className="bg-gray-50 border-t border-gray-200 px-6 py-4 flex gap-3 justify-end">
          <button
            type="button"
            onClick={() => reset()}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="px-4 py-2 text-sm font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700"
          >
            Reload page
          </button>
        </div>
      </div>
    </div>
  );
}
