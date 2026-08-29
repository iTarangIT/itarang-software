"use client";

// Notification badges for the admin work queues (Dealer Validation, KYC Review,
// WhatsApp Onboarding).
//
// The badge counts what has arrived SINCE YOU LAST OPENED THAT PAGE, and clears
// when you open it — so it behaves like a notification rather than a permanent
// backlog counter. The "last looked" marks live in localStorage because they're
// a property of the person reading the screen, not of the account: two admins
// sharing a login shouldn't clear each other's alerts, and it needs no schema.
//
// First ever load seeds every mark to "now" and shows nothing, rather than
// announcing the entire existing backlog as new.

import { useCallback, useEffect, useRef, useState } from "react";

export type NavQueueKey =
  | "dealerValidation"
  | "kycReview"
  | "whatsappOnboarding";

type QueueSpec = {
  key: NavQueueKey;
  /** Opening any path under this prefix counts as "I've looked". */
  pathPrefix: string;
  /** Sidebar item ids that should carry this queue's badge. */
  navIds: string[];
};

const QUEUES: QueueSpec[] = [
  {
    key: "dealerValidation",
    pathPrefix: "/admin/dealer-verification",
    navIds: ["dealer-validation"],
  },
  {
    key: "kycReview",
    pathPrefix: "/admin/kyc-review",
    navIds: ["kyc-review"],
  },
  {
    key: "whatsappOnboarding",
    pathPrefix: "/admin/whatsapp-onboarding",
    navIds: ["sh-whatsapp-onboarding", "admin-whatsapp-onboarding"],
  },
];

const STORAGE_PREFIX = "itarang:nav-seen:";
const POLL_MS = 60_000;

function readSeen(key: NavQueueKey): string | null {
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + key);
  } catch {
    return null; // Private mode / storage disabled — badges just stay quiet.
  }
}

function writeSeen(key: NavQueueKey, iso: string): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, iso);
  } catch {
    /* ignore — a badge is not worth breaking navigation over */
  }
}

type Counts = Record<NavQueueKey, number>;
const ZERO: Counts = {
  dealerValidation: 0,
  kycReview: 0,
  whatsappOnboarding: 0,
};

/**
 * Returns a map of sidebar item id → count of new arrivals, ready to be merged
 * into the menu as `badge`. Ids with nothing new are absent.
 */
export function useNavActivity(enabled: boolean, pathname: string) {
  const [counts, setCounts] = useState<Counts>(ZERO);
  // Guards against a poll that started before a "mark seen" landing afterwards
  // and resurrecting a badge the user just cleared.
  const generation = useRef(0);

  // setState lives inside the .then callback rather than the effect body — the
  // same shape as the NBFC/vendor badge fetches in sidebar.tsx.
  const refresh = useCallback(() => {
    const mine = ++generation.current;
    const params = new URLSearchParams();
    for (const q of QUEUES) {
      const seen = readSeen(q.key);
      if (seen) params.set(q.key, seen);
    }
    if ([...params.keys()].length === 0) return;
    fetch(`/api/admin/nav-activity?${params.toString()}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((json) => {
        if (generation.current !== mine) return;
        setCounts({ ...ZERO, ...(json?.data ?? {}) });
      })
      .catch(() => {
        /* silent — badges stay as they are on a failed poll */
      });
  }, []);

  useEffect(() => {
    if (!enabled) return;

    // Seed any missing mark to "now" so a first load never announces the whole
    // existing backlog as new.
    const now = new Date().toISOString();
    for (const q of QUEUES) {
      if (!readSeen(q.key)) writeSeen(q.key, now);
    }

    // Being on a queue's page IS looking at it: re-stamp before refreshing, so
    // the response comes back with that queue already at zero.
    const visited = QUEUES.find((q) => pathname.startsWith(q.pathPrefix));
    if (visited) writeSeen(visited.key, now);

    refresh();
    const id = window.setInterval(refresh, POLL_MS);
    // Returning to the tab is when a stale badge is most obvious.
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", refresh);
    };
  }, [enabled, pathname, refresh]);

  const badges: Record<string, number> = {};
  for (const q of QUEUES) {
    const n = counts[q.key];
    if (n > 0) for (const id of q.navIds) badges[id] = n;
  }
  return badges;
}
