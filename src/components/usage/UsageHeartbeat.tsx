"use client";

import { useEffect, useRef } from "react";

import {
  HEARTBEAT_MS,
  IDLE_MS,
  JITTER_MS,
  LEASE_TTL_MS,
  LS_LAST_ACTIVE,
  LS_LEADER,
  LS_OFF_UNTIL,
  LS_SESSION,
  MAX_SESSION_MS,
  OFF_CACHE_MS,
  heartbeatClientEnabled,
} from "@/lib/usage/constants";

/**
 * Tells the server, every five minutes, that this person is still using the CRM.
 * Renders nothing.
 *
 * Mounted once in LayoutWrapper — the only client component present on every
 * dashboard route, including /nbfc and /risk-head, which skip the sidebar and
 * header entirely.
 *
 * WHAT IT SENDS: a session id and nothing else. No page path, no page title, no
 * scroll position, no timing, no referrer. The server derives everything else
 * from the auth cookie. That is the whole payload, and it is the reason the
 * staff notice can say what it says.
 *
 * WHAT IT REFUSES TO DO:
 *   · ping while the tab is hidden — a tab left open in the background is not
 *     use, and counting it would make "time in the CRM" a measure of how many
 *     tabs people leave open;
 *   · ping while the person is idle — 15 minutes of no input ends the session,
 *     so a long lunch does not get billed as work;
 *   · ping from more than one tab — one person with three tabs is one person.
 */
export function UsageHeartbeat() {
  // Held in refs, never in state: this component must never re-render, and
  // nothing it tracks should re-run an effect.
  const sessionRef = useRef<string | null>(null);
  const lastPingRef = useRef(0);
  const tabIdRef = useRef<string>("");

  useEffect(() => {
    // BUILD-TIME GATE. When off, no effect body runs at all: no timers, no
    // listeners, no requests. Flipping this needs a rebuild, which is the price
    // of absolute silence before the staff notice goes out.
    if (!heartbeatClientEnabled()) return;
    if (typeof window === "undefined") return;

    tabIdRef.current = crypto.randomUUID();
    let timer: number | undefined;
    let releaseLock: (() => void) | undefined;
    let stopped = false;

    const now = () => Date.now();
    const read = (k: string) => {
      try {
        return window.localStorage.getItem(k);
      } catch {
        // Safari in private mode throws on localStorage. Losing the heartbeat
        // is strictly better than breaking the page around it.
        return null;
      }
    };
    const write = (k: string, v: string) => {
      try {
        window.localStorage.setItem(k, v);
      } catch {
        /* ignore — see read() */
      }
    };

    // ---- activity ---------------------------------------------------------
    // Throttled to one write per 30s. These listeners are passive and do not
    // inspect the event: what was typed or clicked is never read, only that
    // something happened.
    const touch = () => {
      const last = Number(read(LS_LAST_ACTIVE) ?? 0);
      if (now() - last > 30_000) write(LS_LAST_ACTIVE, String(now()));
    };
    const isIdle = () => {
      const last = Number(read(LS_LAST_ACTIVE) ?? 0);
      return last > 0 && now() - last > IDLE_MS;
    };

    // ---- session ----------------------------------------------------------
    const mintSession = () => {
      const id = crypto.randomUUID();
      write(LS_SESSION, JSON.stringify({ id, startedAt: now() }));
      sessionRef.current = id;
      return id;
    };

    const currentSession = () => {
      const raw = read(LS_SESSION);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as { id: string; startedAt: number };
          const tooOld = now() - parsed.startedAt > MAX_SESSION_MS;
          // A session that has run past the ceiling is a machine left logged in,
          // not a working day. Rolling it stops one 70-hour "session" destroying
          // the p90 for everybody else.
          if (parsed.id && !tooOld) {
            sessionRef.current = parsed.id;
            return parsed.id;
          }
        } catch {
          /* malformed — fall through and re-mint */
        }
      }
      return mintSession();
    };

    // ---- leader election --------------------------------------------------
    // Only one tab pings. Web Locks is exact and self-releasing on crash or
    // close; the localStorage lease is the fallback for browsers without it,
    // where the worst case is one duplicate ping during a handover — which the
    // server's 240-second guard then swallows anyway.
    const leaseIsMine = () => {
      const raw = read(LS_LEADER);
      if (!raw) return claimLease();
      try {
        const l = JSON.parse(raw) as { tabId: string; at: number };
        if (l.tabId === tabIdRef.current) {
          write(LS_LEADER, JSON.stringify({ tabId: tabIdRef.current, at: now() }));
          return true;
        }
        if (now() - l.at > LEASE_TTL_MS) return claimLease();
        return false;
      } catch {
        return claimLease();
      }
    };
    const claimLease = () => {
      write(LS_LEADER, JSON.stringify({ tabId: tabIdRef.current, at: now() }));
      return true;
    };

    // ---- the ping ---------------------------------------------------------
    const ping = async () => {
      if (stopped) return;
      if (document.visibilityState !== "visible") return;

      // Server said tracking is off; do not ask again for a while.
      const offUntil = Number(read(LS_OFF_UNTIL) ?? 0);
      if (offUntil && now() < offUntil) return;

      // Background tabs coalesce timers, so a foregrounded tab can fire a burst.
      // A ping is a unit of billed time, not a data refresh — drop the extras.
      if (now() - lastPingRef.current < HEARTBEAT_MS * 0.8) return;

      // Idle: do not ping, and start a fresh session when they come back, so
      // the gap is a boundary rather than time credited to nobody.
      if (isIdle()) {
        sessionRef.current = null;
        return;
      }

      if (!hasLock && !leaseIsMine()) return;

      const sessionId = sessionRef.current ?? currentSession();
      lastPingRef.current = now();

      try {
        const res = await fetch("/api/usage/heartbeat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ session_id: sessionId }),
        });
        const json = (await res.json().catch(() => null)) as {
          enabled?: boolean;
        } | null;
        if (json && json.enabled === false) {
          write(LS_OFF_UNTIL, String(now() + OFF_CACHE_MS));
        }
      } catch {
        // Offline, navigating away, server down — all fine. The next tick tries
        // again, and a missing ping costs five minutes of one person's day.
      }
    };

    // ---- wiring -----------------------------------------------------------
    let hasLock = false;
    if (typeof navigator !== "undefined" && "locks" in navigator) {
      // Held for the lifetime of the tab; the browser releases it on close or
      // crash, so there is no lease to expire and no split brain.
      void navigator.locks
        .request("itarang-usage-heartbeat", { mode: "exclusive" }, () => {
          hasLock = true;
          return new Promise<void>((resolve) => {
            releaseLock = resolve;
          });
        })
        .catch(() => {
          /* another tab holds it, or the API refused — fall back to the lease */
        });
    }

    for (const ev of ["pointerdown", "keydown", "scroll"] as const) {
      window.addEventListener(ev, touch, { passive: true });
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        touch();
        void ping();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    touch();
    currentSession();
    // Jittered first ping, so N people arriving at 09:00 do not stay phase
    // locked and hit the route in the same second all day.
    const kickoff = window.setTimeout(
      () => {
        void ping();
        timer = window.setInterval(() => void ping(), HEARTBEAT_MS);
      },
      Math.random() * JITTER_MS,
    );

    return () => {
      stopped = true;
      window.clearTimeout(kickoff);
      if (timer) window.clearInterval(timer);
      for (const ev of ["pointerdown", "keydown", "scroll"] as const) {
        window.removeEventListener(ev, touch);
      }
      document.removeEventListener("visibilitychange", onVisible);
      releaseLock?.();
    };
    // EMPTY DEPS, deliberately. LayoutWrapper re-renders on every client-side
    // navigation because it calls usePathname(); if this effect depended on
    // anything that changes per route, the five-minute timer would restart on
    // every navigation and somebody who clicks every four minutes would never
    // ping at all.
  }, []);

  return null;
}
