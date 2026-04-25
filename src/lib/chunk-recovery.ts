// Shared helpers used by ChunkReloadGuard and global-error.tsx to recover
// from a ChunkLoadError. The interesting behavior is the ordering: a stale
// service worker can re-serve the same broken HTML/manifest on reload, so
// we MUST evict it before navigating, and we MUST cache-bust the URL to
// defeat any intermediate proxy that ignored Cache-Control: no-store.

export const CHUNK_RELOAD_KEY = "chunk-reload-guard";
export const CHUNK_RELOAD_TTL_MS = 60_000;

export function isChunkErrorMessage(msg: string | undefined): boolean {
  if (!msg) return false;
  if (/ChunkLoadError/.test(msg)) return true;
  if (/Loading (CSS )?chunk \d+ failed/.test(msg)) return true;
  if (/\/_next\/static\/(chunks|css)\//.test(msg)) return true;
  return false;
}

export async function cleanupStaleCaches(): Promise<void> {
  try {
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (typeof window !== "undefined" && "caches" in window) {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
    }
  } catch {
    // Best-effort cleanup — never let a failure here block recovery.
  }
}

export function cacheBustedUrl(): string {
  if (typeof window === "undefined") return "/";
  const { pathname, search, hash } = window.location;
  const sep = search ? "&" : "?";
  const bustedSearch = `${search}${sep}_cb=${Date.now()}`;
  return `${pathname}${bustedSearch}${hash}`;
}

export async function hardReload(): Promise<void> {
  await cleanupStaleCaches();
  if (typeof window !== "undefined") {
    window.location.replace(cacheBustedUrl());
  }
}

export function shouldGuardReload(signature: string): boolean {
  try {
    const raw =
      typeof sessionStorage !== "undefined"
        ? sessionStorage.getItem(CHUNK_RELOAD_KEY)
        : null;
    const prev = raw ? (JSON.parse(raw) as { sig: string; at: number }) : null;
    if (
      prev &&
      prev.sig === signature &&
      Date.now() - prev.at < CHUNK_RELOAD_TTL_MS
    ) {
      return true;
    }
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(
        CHUNK_RELOAD_KEY,
        JSON.stringify({ sig: signature, at: Date.now() })
      );
    }
    return false;
  } catch {
    return false;
  }
}

export function clearReloadGuard(): void {
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem(CHUNK_RELOAD_KEY);
    }
  } catch {
    // ignore
  }
}
