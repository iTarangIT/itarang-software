"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Keeps an Ops Console page current without websockets: calls
 * router.refresh() on an interval, which re-runs the server components and
 * streams new HTML in place. Nothing here fetches — the pages read tables, so
 * a refresh is one cheap query set.
 *
 * Pauses while the tab is hidden. That is not a nicety: this console is the
 * kind of thing people leave open on a spare monitor for weeks, and a 15s
 * refresh running unattended in twelve background tabs is a self-inflicted
 * load test against the same RDS instance the console exists to protect.
 * On becoming visible again it refreshes immediately, so a tab you come back
 * to is never showing minutes-old numbers.
 */
export function AutoRefresh({
  intervalMs = 15_000,
  label = "Auto-refresh",
}: {
  intervalMs?: number;
  label?: string;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);

  useEffect(() => {
    // The effect re-runs when `enabled` flips, so inside this body it is
    // always true — no need to re-check it in the handlers below.
    if (!enabled) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      router.refresh();
      setLastRefresh(Date.now());
    };

    const start = () => {
      if (timer) return;
      timer = setInterval(refresh, intervalMs);
    };

    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refresh();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, intervalMs, router]);

  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-[11px] text-ink-muted">
      <input
        type="checkbox"
        checked={enabled}
        onChange={(e) => setEnabled(e.target.checked)}
        className="h-3 w-3 cursor-pointer accent-brand-sky"
      />
      <span className="inline-flex items-center gap-1.5">
        <span
          className={
            enabled
              ? "h-1.5 w-1.5 rounded-full bg-success"
              : "h-1.5 w-1.5 rounded-full bg-border"
          }
          aria-hidden
        />
        {label} · {Math.round(intervalMs / 1000)}s
      </span>
      {lastRefresh && (
        <span className="tabular-nums text-ink-muted/70">
          {new Date(lastRefresh).toLocaleTimeString("en-IN", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            timeZone: "Asia/Kolkata",
          })}
        </span>
      )}
    </label>
  );
}
