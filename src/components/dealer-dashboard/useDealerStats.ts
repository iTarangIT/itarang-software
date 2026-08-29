"use client";

/**
 * Shared access to GET /api/dealer/stats.
 *
 * Three components on the dealer portal need it at once: the page (to decide
 * WHICH dashboard to render, by dealer type), and then whichever dashboard it
 * picks (for its own cards and metrics). Fetching independently would run that
 * endpoint's ~6 queries twice on every single dashboard load.
 *
 * The in-flight promise is cached at module scope, so every caller that mounts
 * in the same tick shares one request. The cache is cleared as soon as the
 * request settles: this is request de-duplication, not a data cache, and a
 * dashboard opened later must still see fresh numbers (the endpoint is
 * `cache: "no-store"` for that reason).
 *
 * Deliberately not React Query, which the buyback module uses: the dealer
 * dashboard has no QueryClientProvider in its tree, and adding one to fix a
 * duplicate request would be a larger change than the problem.
 */

import { useEffect, useState } from "react";

export type DealerApiData = {
  id: string | null;
  companyName: string;
  dealerCode: string | null;
  onboardingStatus: string;
  reviewStatus: string;
  dealerAccountStatus: string;
  approvedAt: string | null;
  submittedAt: string | null;
  financeEnabled: boolean;
  /** E-202 — 'new' | 'scrap' | 'both'. Decides which modules this dealer has. */
  dealerType: string | null;
  isApproved: boolean;
};

export type DealerStatsResponse = {
  dealer: DealerApiData | null;
  metrics: {
    totalLeads: number;
    convertedLeads: number;
    conversionRate: number;
    commission: number;
    inventoryCount: number;
    totalPayments: number;
    loanCount: number;
    rewards: number;
  };
  recentLeads: unknown[];
};

let inFlight: Promise<DealerStatsResponse | null> | null = null;

/** One request per tick, shared by every caller. */
export function fetchDealerStats(): Promise<DealerStatsResponse | null> {
  if (inFlight) return inFlight;

  inFlight = fetch("/api/dealer/stats", { cache: "no-store" })
    .then((r) => r.json())
    .then((json) => (json?.success && json?.data ? (json.data as DealerStatsResponse) : null))
    .catch(() => null)
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/** `stats` is null until the request settles; `loading` distinguishes the two. */
export function useDealerStats() {
  const [stats, setStats] = useState<DealerStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    fetchDealerStats().then((data) => {
      if (cancelled) return;
      setStats(data);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return { stats, loading };
}
