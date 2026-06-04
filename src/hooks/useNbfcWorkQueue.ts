"use client";

/**
 * useNbfcWorkQueue — polls /api/nbfc/notifications/summary for the current NBFC
 * tenant's live work-queue counts. Used by the portal sidebar (Acquire badge)
 * and the header bell. Both share the queryKey, so React Query dedupes them to
 * a single request. Auto-refreshes every 45s and on window refocus, so a number
 * appears/decrements as work arrives or is cleared — no manual refresh needed.
 */
import { useQuery } from "@tanstack/react-query";

export interface NbfcRecentEvent {
  type: "agreement" | "vkyc";
  lead_id: string;
  customer_name: string | null;
  at: string;
}

export interface NbfcWorkQueue {
  acquire_pending: number;
  fi: number;
  vkyc: number;
  enach: number;
  agreement: number;
  attention_total: number;
  recent: NbfcRecentEvent[];
  total: number;
}

const EMPTY: NbfcWorkQueue = {
  acquire_pending: 0,
  fi: 0,
  vkyc: 0,
  enach: 0,
  agreement: 0,
  attention_total: 0,
  recent: [],
  total: 0,
};

export function useNbfcWorkQueue(): NbfcWorkQueue {
  const { data } = useQuery({
    queryKey: ["nbfc", "work-queue"],
    queryFn: async (): Promise<NbfcWorkQueue> => {
      const res = await fetch("/api/nbfc/notifications/summary");
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) throw new Error(j.error ?? "Failed to load notifications");
      return {
        acquire_pending: j.acquire_pending ?? 0,
        fi: j.fi ?? 0,
        vkyc: j.vkyc ?? 0,
        enach: j.enach ?? 0,
        agreement: j.agreement ?? 0,
        attention_total: j.attention_total ?? 0,
        recent: Array.isArray(j.recent) ? (j.recent as NbfcRecentEvent[]) : [],
        total: j.total ?? 0,
      };
    },
    refetchInterval: 45_000,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
  return data ?? EMPTY;
}
