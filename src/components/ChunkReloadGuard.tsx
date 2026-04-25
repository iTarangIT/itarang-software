"use client";

import { useEffect } from "react";

const KEY = "chunk-reload-guard";
const TTL_MS = 60_000;

function isChunkError(src: string | undefined, msg: string | undefined): boolean {
  const s = `${src ?? ""} ${msg ?? ""}`;
  if (/\/_next\/static\/(chunks|css)\//.test(s)) return true;
  if (/ChunkLoadError/.test(msg ?? "")) return true;
  if (/Loading (CSS )?chunk \d+ failed/.test(msg ?? "")) return true;
  return false;
}

function tryReload(signature: string): void {
  try {
    const raw = sessionStorage.getItem(KEY);
    const prev = raw ? (JSON.parse(raw) as { sig: string; at: number }) : null;
    if (prev && prev.sig === signature && Date.now() - prev.at < TTL_MS) return;
    sessionStorage.setItem(KEY, JSON.stringify({ sig: signature, at: Date.now() }));
    window.location.reload();
  } catch {
    window.location.reload();
  }
}

async function cleanupStaleCaches(): Promise<void> {
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if ("caches" in window) {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
    }
  } catch {
    // Best-effort cleanup — ignore failures.
  }
}

export default function ChunkReloadGuard() {
  useEffect(() => {
    void cleanupStaleCaches();
    const onError = (e: ErrorEvent) => {
      const tgt = e.target as HTMLScriptElement | HTMLLinkElement | null;
      const src =
        tgt && "src" in tgt && tgt.src
          ? tgt.src
          : tgt && "href" in tgt && tgt.href
            ? tgt.href
            : undefined;
      if (isChunkError(src, e.message)) tryReload(src ?? e.message ?? "unknown");
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const reason = e.reason as { message?: string; name?: string; request?: string; filename?: string } | undefined;
      const msg = reason?.message ?? String(reason ?? "");
      const url = reason?.request ?? reason?.filename;
      if (reason?.name === "ChunkLoadError" || isChunkError(url, msg)) {
        tryReload(url ?? msg);
      }
    };
    window.addEventListener("error", onError, true);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError, true);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
