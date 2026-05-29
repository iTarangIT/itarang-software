"use client";

/**
 * E-111 — CEO per-item correction flag context.
 *
 * Wraps the CEO review page. Exposes a "flag mode" toggle. While flag mode
 * is on, FlagButtons render inline next to each flaggable element. Toggling
 * one adds/removes it from the pending-flag map. The floating tray reads
 * `pendingFlags.size` to show a Submit drawer.
 *
 * Only the CEO ever sees the toggle (gated on `viewerIsCeo` prop). Admin
 * viewers still see the rendered "Resolved" badges off the latestRound
 * snapshot, but no FlagButton UI.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { CorrectionKind } from "@/lib/nbfc/admin/correction-catalog";

export interface PendingFlag {
  kind: CorrectionKind;
  targetKey: string;
  targetRefId?: number;
  remark: string;
}

export interface ResolvedItemSnapshot {
  kind: CorrectionKind;
  targetKey: string;
  resolutionStatus: "pending" | "resolved" | "dismissed";
  previousValue: string | null;
  previousFileUrl: string | null;
  newValue: string | null;
  newFileUrl: string | null;
  remark: string | null;
}

export interface LatestRoundSummary {
  id: number;
  roundNumber: number;
  status: "open" | "resolved" | "superseded";
  items: ResolvedItemSnapshot[];
  pendingCount: number;
  totalCount: number;
}

interface CorrectionFlagContextValue {
  nbfcId: number;
  viewerIsCeo: boolean;
  flagMode: boolean;
  setFlagMode: (v: boolean) => void;
  pendingFlags: Map<string, PendingFlag>;
  toggleFlag: (flag: Omit<PendingFlag, "remark">) => void;
  setRemark: (compositeKey: string, remark: string) => void;
  clearFlags: () => void;
  submitting: boolean;
  submit: (summaryRemarks: string) => Promise<{ ok: boolean; error?: string }>;
  latestRound: LatestRoundSummary | null;
  flaggedItemFor: (
    kind: CorrectionKind,
    targetKey: string,
  ) => ResolvedItemSnapshot | null;
}

const Ctx = createContext<CorrectionFlagContextValue | null>(null);

export function compositeKey(kind: CorrectionKind, targetKey: string): string {
  return `${kind}::${targetKey}`;
}

export function useCorrectionFlagContext(): CorrectionFlagContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error(
      "useCorrectionFlagContext must be used inside <CorrectionFlagProvider>",
    );
  }
  return ctx;
}

/**
 * Same as `useCorrectionFlagContext` but returns null when not inside a
 * provider, for components shared across pages where some don't have the
 * provider yet (e.g. read-only embeds elsewhere in the dashboard).
 */
export function useOptionalCorrectionFlagContext():
  | CorrectionFlagContextValue
  | null {
  return useContext(Ctx);
}

export function CorrectionFlagProvider({
  nbfcId,
  viewerIsCeo,
  initialLatestRound,
  children,
}: {
  nbfcId: number;
  viewerIsCeo: boolean;
  initialLatestRound: LatestRoundSummary | null;
  children: ReactNode;
}) {
  const [flagMode, setFlagMode] = useState(false);
  const [pendingFlags, setPendingFlags] = useState<Map<string, PendingFlag>>(
    new Map(),
  );
  const [submitting, setSubmitting] = useState(false);
  const [latestRound, setLatestRound] = useState<LatestRoundSummary | null>(
    initialLatestRound,
  );

  const toggleFlag = useCallback(
    (flag: Omit<PendingFlag, "remark">) => {
      const key = compositeKey(flag.kind, flag.targetKey);
      setPendingFlags((prev) => {
        const next = new Map(prev);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.set(key, { ...flag, remark: "" });
        }
        return next;
      });
    },
    [],
  );

  const setRemark = useCallback((key: string, remark: string) => {
    setPendingFlags((prev) => {
      const next = new Map(prev);
      const existing = next.get(key);
      if (existing) {
        next.set(key, { ...existing, remark });
      }
      return next;
    });
  }, []);

  const clearFlags = useCallback(() => {
    setPendingFlags(new Map());
    setFlagMode(false);
  }, []);

  const submit = useCallback(
    async (summaryRemarks: string) => {
      if (pendingFlags.size === 0)
        return { ok: false, error: "No items flagged." };
      setSubmitting(true);
      try {
        const items = Array.from(pendingFlags.values()).map((f) => ({
          kind: f.kind,
          targetKey: f.targetKey,
          targetRefId: f.targetRefId,
          remark: f.remark.trim() || undefined,
        }));
        const res = await fetch(
          `/api/admin/nbfc/${nbfcId}/corrections`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              summaryRemarks: summaryRemarks.trim() || undefined,
              items,
            }),
          },
        );
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          return {
            ok: false,
            error:
              (body as { message?: string; error?: string }).message ??
              (body as { error?: string }).error ??
              `Submit failed (${res.status})`,
          };
        }
        // Refresh latest round from server.
        const latestRes = await fetch(
          `/api/admin/nbfc/${nbfcId}/corrections/latest`,
          { cache: "no-store" },
        );
        if (latestRes.ok) {
          const latestBody = (await latestRes.json()) as {
            round: LatestRoundSummary | null;
          };
          setLatestRound(latestBody.round);
        }
        setPendingFlags(new Map());
        setFlagMode(false);
        return { ok: true };
      } finally {
        setSubmitting(false);
      }
    },
    [nbfcId, pendingFlags],
  );

  const flaggedItemFor = useCallback(
    (kind: CorrectionKind, targetKey: string): ResolvedItemSnapshot | null => {
      if (!latestRound) return null;
      return (
        latestRound.items.find(
          (i) => i.kind === kind && i.targetKey === targetKey,
        ) ?? null
      );
    },
    [latestRound],
  );

  const value = useMemo<CorrectionFlagContextValue>(
    () => ({
      nbfcId,
      viewerIsCeo,
      flagMode,
      setFlagMode,
      pendingFlags,
      toggleFlag,
      setRemark,
      clearFlags,
      submitting,
      submit,
      latestRound,
      flaggedItemFor,
    }),
    [
      nbfcId,
      viewerIsCeo,
      flagMode,
      pendingFlags,
      toggleFlag,
      setRemark,
      clearFlags,
      submitting,
      submit,
      latestRound,
      flaggedItemFor,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
