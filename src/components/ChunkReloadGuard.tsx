"use client";

import { useEffect } from "react";
import {
  cleanupStaleCaches,
  hardReload,
  isChunkErrorMessage,
  shouldGuardReload,
} from "@/lib/chunk-recovery";

function isChunkError(src: string | undefined, msg: string | undefined): boolean {
  const combined = `${src ?? ""} ${msg ?? ""}`;
  return isChunkErrorMessage(combined);
}
// helo world

async function tryReload(signature: string): Promise<void> {
  if (shouldGuardReload(signature)) return;
  await hardReload();
}

export default function ChunkReloadGuard() {
  useEffect(() => {
    // Preventive: if a stale SW from a prior deploy is still installed for
    // this user, evict it on first paint so it can't intercept the next
    // navigation. Fire-and-forget here is fine — the actual recovery path
    // (tryReload) awaits the same cleanup before navigating.
    void cleanupStaleCaches();

    const onError = (e: ErrorEvent) => {
      const tgt = e.target as HTMLScriptElement | HTMLLinkElement | null;
      const src =
        tgt && "src" in tgt && tgt.src
          ? tgt.src
          : tgt && "href" in tgt && tgt.href
            ? tgt.href
            : undefined;
      if (isChunkError(src, e.message)) {
        void tryReload(src ?? e.message ?? "unknown");
      }
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const reason = e.reason as
        | { message?: string; name?: string; request?: string; filename?: string }
        | undefined;
      const msg = reason?.message ?? String(reason ?? "");
      const url = reason?.request ?? reason?.filename;
      if (reason?.name === "ChunkLoadError" || isChunkError(url, msg)) {
        void tryReload(url ?? msg);
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
