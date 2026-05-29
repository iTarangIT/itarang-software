// Per-call detail drawer that opens when a row in TopCampaignsTable is
// clicked. Renders the call list with full component breakdown. Mirrors
// the slide-over pattern already established by the campaign transcript
// drawer.

"use client";

import { useEffect } from "react";
import { X, Phone, Clock } from "lucide-react";
import { formatINR, formatINRDetailed } from "@/lib/currency";
import type { CallDetail } from "./types";

const SEGMENT_COLORS: Record<string, string> = {
  llm: "bg-teal-600",
  tts: "bg-indigo-500",
  stt: "bg-amber-500",
  telephony: "bg-blue-500",
  platform: "bg-purple-500",
};

const SEGMENT_LABELS: Record<string, string> = {
  llm: "LLM",
  tts: "TTS",
  stt: "STT",
  telephony: "Telephony",
  platform: "Platform",
};

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDuration(secs: number | null): string {
  if (secs == null) return "—";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

type CallDetailDrawerProps = {
  open: boolean;
  campaignName: string;
  calls: CallDetail[];
  total: number;
  loading?: boolean;
  onClose: () => void;
};

export function CallDetailDrawer({
  open,
  campaignName,
  calls,
  total,
  loading,
  onClose,
}: CallDetailDrawerProps) {
  useEffect(() => {
    if (!open) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleEsc);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleEsc);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  const aggregate = calls.reduce(
    (acc, c) => acc + (c.totalCostCents ?? 0),
    0,
  );

  return (
    <div className="fixed inset-0 z-50 flex">
      <div
        className="flex-1 bg-black/30 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div className="w-full max-w-2xl bg-white shadow-2xl overflow-hidden flex flex-col">
        <div className="px-6 py-5 border-b border-gray-100">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-gray-500">
                Per-call breakdown
              </span>
              <h2 className="text-lg font-bold text-gray-900 truncate mt-0.5">
                {campaignName}
              </h2>
              <p className="text-xs text-gray-500 mt-1 tabular-nums">
                {total.toLocaleString("en-IN")} call
                {total === 1 ? "" : "s"} · {formatINR(aggregate)} on this page
              </p>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
              aria-label="Close"
            >
              <X className="w-4 h-4 text-gray-500" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-6 text-sm text-gray-400">Loading calls…</div>
          ) : calls.length === 0 ? (
            <div className="p-12 text-center">
              <p className="text-sm font-medium text-gray-700">
                No call cost data yet for this campaign
              </p>
              <p className="text-xs text-gray-400 mt-1">
                Cost is captured a few seconds after a call ends. The
                backfill cron retries any that webhooks missed.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {calls.map((c) => {
                const components = [
                  { key: "llm", value: c.components.llm },
                  { key: "tts", value: c.components.tts },
                  { key: "stt", value: c.components.stt },
                  { key: "telephony", value: c.components.telephony },
                  { key: "platform", value: c.components.platform },
                ].filter((s) => s.value != null && s.value > 0);
                const localTotal = components.reduce(
                  (s, x) => s + (x.value ?? 0),
                  0,
                );
                return (
                  <li key={c.callId} className="px-6 py-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-semibold text-gray-900 truncate">
                            {c.shopName ?? "Unknown shop"}
                          </span>
                          <span
                            className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                              c.provider === "bolna"
                                ? "bg-blue-50 text-blue-700"
                                : "bg-violet-50 text-violet-700"
                            }`}
                          >
                            {c.provider}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 text-[11px] text-gray-500 tabular-nums">
                          <span className="flex items-center gap-1">
                            <Phone className="w-3 h-3" />
                            {c.phone ?? "—"}
                          </span>
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {fmtDuration(c.durationSecs)}
                          </span>
                          <span>{fmtTime(c.endedAt ?? c.startedAt)}</span>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-base font-bold text-gray-900 tabular-nums">
                          {formatINRDetailed(c.totalCostCents ?? 0)}
                        </div>
                        {c.costFetchedAt == null && (
                          <span className="text-[10px] font-medium text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded">
                            Pending cost
                          </span>
                        )}
                      </div>
                    </div>

                    {components.length > 0 && localTotal > 0 && (
                      <>
                        <div className="mt-3 flex h-1.5 rounded-full overflow-hidden bg-gray-100">
                          {components.map((seg) => (
                            <div
                              key={seg.key}
                              className={`h-full ${SEGMENT_COLORS[seg.key]}`}
                              style={{
                                width: `${((seg.value ?? 0) / localTotal) * 100}%`,
                              }}
                            />
                          ))}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                          {components.map((seg) => (
                            <span
                              key={seg.key}
                              className="flex items-center gap-1.5 text-gray-500"
                            >
                              <span
                                className={`w-1.5 h-1.5 rounded-full ${SEGMENT_COLORS[seg.key]}`}
                              />
                              {SEGMENT_LABELS[seg.key]}{" "}
                              <span className="text-gray-700 tabular-nums font-medium">
                                {formatINRDetailed(seg.value ?? 0)}
                              </span>
                            </span>
                          ))}
                        </div>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
