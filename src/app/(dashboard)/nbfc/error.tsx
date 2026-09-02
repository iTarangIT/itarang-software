"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * A dropped RSC stream, not a render failure. When the server accepts the
 * navigation, starts streaming, and then goes away mid-response (dev server
 * recompiling, PM2 reload, laptop sleeping, VPN flap), the browser aborts the
 * body stream and React surfaces it here.
 *
 * These are the *browser's* fetch messages, and Chrome distinguishes the two
 * halves of the failure:
 *   - "Failed to fetch"  → could not connect at all
 *   - "network error"    → connected, then the body stream broke
 * Firefox says "NetworkError when attempting to fetch resource."; Safari says
 * "Load failed". None of them means the page code is wrong.
 *
 * Deliberately narrow. Node-side transport words ("fetch failed", "socket hang
 * up", "Connection terminated") are NOT matched here: those reach us wrapped in
 * a server-component error — usually Drizzle's "Failed query: …" — which the DB
 * branch already handles and which we still want reported to the server logs.
 */
function isTransportError(err: Error): boolean {
  const m = (err?.message ?? "").trim();
  return (
    /^network error\.?$/i.test(m) ||
    /^Failed to fetch$/i.test(m) ||
    /^NetworkError when attempting to fetch resource\.?$/i.test(m) ||
    /^Load failed$/i.test(m) ||
    /^net::ERR_[A-Z_]+$/.test(m)
  );
}

export default function NbfcError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const pathname = usePathname();
  const [reported, setReported] = useState<"idle" | "sending" | "ok" | "fail">("idle");

  const msg = error?.message ?? "";
  const isNetworkError = isTransportError(error);

  // Reporting a transport error over the same transport that just failed is
  // pointless — it produces the "✗ failed" badge and tells us nothing. Skip it.
  useEffect(() => {
    if (isNetworkError) return;
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
  }, [error, pathname, isNetworkError]);

  // One automatic retry for a dropped stream — by the time the boundary paints,
  // the server is usually back (an on-demand dev compile has finished, or the
  // process has restarted). Guarded by a ref so a genuinely dead server shows
  // the card instead of spinning in a reset loop.
  const retried = useRef(false);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    if (!isNetworkError || retried.current) return;
    retried.current = true;
    setRetrying(true);
    const t = setTimeout(() => {
      setRetrying(false);
      reset();
    }, 1200);
    return () => clearTimeout(t);
  }, [isNetworkError, reset]);

  if (retrying) {
    return (
      <div className="max-w-3xl mx-auto py-12 px-4">
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm px-6 py-8 flex items-center gap-3">
          <svg className="animate-spin h-4 w-4 text-gray-500" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
            <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
          <p className="text-sm text-gray-600">
            Lost connection to the server — reconnecting…
          </p>
        </div>
      </div>
    );
  }

  // A transient DB connection blip (CONNECT_TIMEOUT / ECONNRESET to the RDS
  // host) manifests as a "Failed query: …" error even though the SQL is fine.
  // The AWS RDS instance has no pooler and lives in ap-south-1, so a momentary
  // network hiccup from the dev machine trips the 10s connect_timeout. Retry
  // almost always succeeds — say so instead of showing a raw stack trace.
  //
  // But Drizzle's "Failed query: <sql>" message is ALSO what an unapplied
  // migration looks like — the real cause (`relation "x" does not exist`,
  // `column "y" does not exist`, 42P01/42703) sits on `error.cause`, which
  // Next strips before the message reaches this client boundary. So a bare
  // "Failed query" must NOT be sold as a timeout: on 2026-08-26 the Recovery
  // queue showed "connection timed out — retry" for a `recovery_assignments`
  // table that simply did not exist on database-2 (E-262/E-263 unapplied),
  // and Retry could never have fixed that. Only the transport words earn the
  // timeout copy; "Failed query" alone gets an honest "query failed" card
  // that names both possibilities and points at the server log.
  const isDbTimeout =
    /CONNECT_TIMEOUT|ECONNRESET|ETIMEDOUT|ENOTFOUND|Connection terminated/i.test(msg);
  const isDbQueryError = !isDbTimeout && /Failed query/.test(msg);

  const isChunkError =
    /ChunkLoadError/.test(msg) ||
    /Loading (CSS )?chunk \d+ failed/.test(msg) ||
    /\/_next\/static\/(chunks|css)\//.test(msg);

  return (
    <div className="max-w-3xl mx-auto py-12 px-4">
      <div className="bg-white border border-red-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="bg-red-50 border-b border-red-200 px-6 py-4">
          <h1 className="text-lg font-semibold text-red-900">
            {isNetworkError
              ? "Lost connection to the server"
              : isDbTimeout
                ? "Couldn’t reach the database"
                : isDbQueryError
                  ? "A database query failed"
                  : "This page failed to load"}
          </h1>
          <p className="text-sm text-red-700 mt-1">
            {isNetworkError
              ? "The connection dropped while this page was loading, so it never rendered. The server was most likely restarting or recompiling. Retrying usually works."
              : isDbTimeout
                ? "The database connection timed out — usually a brief network blip, not a data problem. Retrying should load the page."
                : isDbQueryError
                  ? "The database rejected this query. If Retry doesn’t fix it, the usual cause is a table or column missing on the database this server points at — an unapplied drizzle/E-NNN migration. The exact Postgres error (e.g. ‘relation … does not exist’) is in the server log next to this digest."
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
            {isNetworkError ? (
              <>Not reported — the server was unreachable, so there was nothing to report to.</>
            ) : (
              <>
                Reported to server logs:{" "}
                <span className="font-medium">
                  {reported === "ok"
                    ? "✓ logged"
                    : reported === "fail"
                      ? "✗ failed"
                      : "sending…"}
                </span>
              </>
            )}
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
