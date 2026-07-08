"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

export default function NbfcError({
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
        scope: "nbfc",
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

  const msg = error?.message ?? "";

  // A transient DB connection blip (CONNECT_TIMEOUT / ECONNRESET to the RDS
  // host) manifests as a "Failed query: …" error even though the SQL is fine.
  // The AWS RDS instance has no pooler and lives in ap-south-1, so a momentary
  // network hiccup from the dev machine trips the 10s connect_timeout. Retry
  // almost always succeeds — say so instead of showing a raw stack trace.
  const isDbConnError =
    /Failed query/.test(msg) ||
    /CONNECT_TIMEOUT|ECONNRESET|ETIMEDOUT|ENOTFOUND|Connection terminated/i.test(msg);

  const isChunkError =
    /ChunkLoadError/.test(msg) ||
    /Loading (CSS )?chunk \d+ failed/.test(msg) ||
    /\/_next\/static\/(chunks|css)\//.test(msg);

  return (
    <div className="max-w-3xl mx-auto py-12 px-4">
      <div className="bg-white border border-red-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="bg-red-50 border-b border-red-200 px-6 py-4">
          <h1 className="text-lg font-semibold text-red-900">
            {isDbConnError
              ? "Couldn’t reach the database"
              : "This page failed to load"}
          </h1>
          <p className="text-sm text-red-700 mt-1">
            {isDbConnError
              ? "The database connection timed out — usually a brief network blip, not a data problem. Retrying should load the page."
              : isChunkError
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
              {error?.name ? `${error.name}: ` : ""}{msg || "Unknown error"}
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
              {reported === "ok"
                ? "✓ logged"
                : reported === "fail"
                  ? "✗ failed"
                  : "sending…"}
            </span>
          </div>
        </div>

        <div className="bg-gray-50 border-t border-gray-200 px-6 py-4 flex gap-3 justify-end">
          <button
            type="button"
            onClick={() => reset()}
            className="px-4 py-2 text-sm font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            Reload page
          </button>
        </div>
      </div>
    </div>
  );
}
