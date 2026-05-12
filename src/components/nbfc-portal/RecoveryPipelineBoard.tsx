"use client";

/**
 * E-036 — Recovery pipeline board (BRD §6.1.7)
 *
 * Lane-style view of recovery pipeline rows grouped by stage. Each row card
 * surfaces the battery serial, estimated recovery value, and a "Move to..."
 * dropdown of allowed-next-stages. Selecting a target stage issues a PATCH
 * to /api/nbfc/recovery/[id]/stage and refreshes the lane data.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

const STAGES = [
  "needs_inspection",
  "refurbishable",
  "scrap",
  "ready_for_auction",
  "resold",
] as const;
type Stage = (typeof STAGES)[number];

const STAGE_LABEL: Record<Stage, string> = {
  needs_inspection: "Needs Inspection",
  refurbishable: "Refurbishable",
  scrap: "Scrap",
  ready_for_auction: "Ready for Auction",
  resold: "Resold",
};

const ALLOWED: Record<Stage, Stage[]> = {
  needs_inspection: ["refurbishable", "scrap"],
  refurbishable: ["ready_for_auction"],
  scrap: [],
  ready_for_auction: ["resold"],
  resold: [],
};

interface PipelineItem {
  id: string;
  battery_serial: string;
  stage: string;
  estimated_recovery_value: number | null;
  updated_at: string;
}

function fmtINR(n: number | null): string {
  if (n === null || n === undefined) return "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);
}

export function RecoveryPipelineBoard() {
  const [items, setItems] = useState<PipelineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      // Pull a generous page so all live lanes are populated client-side.
      const res = await fetch(`/api/nbfc/recovery?page=1&page_size=100`, {
        cache: "no-store",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { items: PipelineItem[] };
      setItems(body.items ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const lanes = useMemo(() => {
    const grouped: Record<Stage, PipelineItem[]> = {
      needs_inspection: [],
      refurbishable: [],
      scrap: [],
      ready_for_auction: [],
      resold: [],
    };
    for (const it of items) {
      if ((STAGES as readonly string[]).includes(it.stage)) {
        grouped[it.stage as Stage].push(it);
      }
    }
    return grouped;
  }, [items]);

  async function handleTransition(item: PipelineItem, target: Stage) {
    setActing(item.id);
    setErr(null);
    try {
      const res = await fetch(`/api/nbfc/recovery/${item.id}/stage`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: target }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setActing(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Recovery Pipeline</h1>
        <button
          type="button"
          onClick={() => void refresh()}
          className="text-sm px-3 py-1.5 border border-slate-300 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800"
        >
          Refresh
        </button>
      </div>

      {err && (
        <div className="bg-red-50 border border-red-200 text-red-800 text-sm rounded-md p-3">
          {err}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-slate-500">Loading pipeline…</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
          {STAGES.map((stage) => (
            <div
              key={stage}
              data-testid={`recovery-lane-${stage}`}
              className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-3 min-h-[200px]"
            >
              <div className="flex items-baseline justify-between mb-2">
                <h2 className="text-sm font-semibold">{STAGE_LABEL[stage]}</h2>
                <span className="text-xs text-slate-500">
                  {lanes[stage].length}
                </span>
              </div>
              <div className="space-y-2">
                {lanes[stage].length === 0 ? (
                  <p className="text-xs text-slate-400 italic">No batteries</p>
                ) : (
                  lanes[stage].map((it) => (
                    <div
                      key={it.id}
                      data-testid={`recovery-card-${it.id}`}
                      className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md p-2 text-xs space-y-1"
                    >
                      <div className="font-mono font-semibold">
                        {it.battery_serial}
                      </div>
                      <div className="text-slate-500">
                        {fmtINR(it.estimated_recovery_value)}
                      </div>
                      {ALLOWED[stage].length > 0 && (
                        <div className="flex flex-wrap gap-1 pt-1">
                          {ALLOWED[stage].map((next) => (
                            <button
                              key={next}
                              type="button"
                              disabled={acting === it.id}
                              onClick={() => void handleTransition(it, next)}
                              className="px-2 py-0.5 text-[11px] border border-slate-300 dark:border-slate-700 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
                            >
                              {acting === it.id ? "…" : `→ ${STAGE_LABEL[next]}`}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default RecoveryPipelineBoard;
