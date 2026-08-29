"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Silently re-fetches the server component on an interval so new attack events
 * appear without a manual reload. Pauses while the tab is hidden.
 */
export default function AutoRefresh({ intervalMs = 15000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);
  return null;
}
