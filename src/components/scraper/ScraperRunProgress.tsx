"use client";

import { useQuery } from "@tanstack/react-query";
import { CheckCircle, AlertCircle, Loader2, Clock } from "lucide-react";
import { useEffect } from "react";

interface Progress {
  id: string;
  status: string | null;
  totalChunks: number;
  completedChunks: number;
  percent: number;
  breakdown: {
    pending: number;
    running: number;
    done: number;
    failed: number;
  };
  rawLeadsFound: number;
  totalFound: number;
  newLeadsSaved: number;
  duplicatesSkipped: number;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

interface Props {
  runId: string;
  onComplete?: () => void;
  onDismiss?: () => void;
}

export function ScraperRunProgress({ runId, onComplete, onDismiss }: Props) {
  const { data, isLoading } = useQuery<Progress>({
    queryKey: ["scraper-run-progress", runId],
    queryFn: async () => {
      const res = await fetch(`/api/scraper/runs/${runId}/progress`);
      const json = await res.json();
      if (!json.success) throw new Error("Failed to load progress");
      return json.data as Progress;
    },
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === "completed" || status === "failed") return false;
      return 2500;
    },
  });

  const isTerminal = data?.status === "completed" || data?.status === "failed";

  useEffect(() => {
    if (isTerminal && onComplete) onComplete();
  }, [isTerminal, onComplete]);

  if (isLoading || !data) {
    return (
      <div className="flex items-center gap-3 p-4 rounded-xl border border-gray-200 bg-white">
        <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
        <span className="text-sm text-gray-500">Loading run progress…</span>
      </div>
    );
  }

  const elapsedSeconds = data.startedAt
    ? Math.floor(
        ((data.completedAt ? new Date(data.completedAt).getTime() : Date.now()) -
          new Date(data.startedAt).getTime()) /
          1000,
      )
    : 0;

  const colorClasses =
    data.status === "completed"
      ? "border-green-200 bg-green-50"
      : data.status === "failed"
        ? "border-red-200 bg-red-50"
        : "border-teal-200 bg-teal-50/60";

  const barColor =
    data.status === "completed"
      ? "bg-green-500"
      : data.status === "failed"
        ? "bg-red-500"
        : "bg-teal-500";

  const statusLabel =
    data.status === "completed"
      ? "Completed"
      : data.status === "failed"
        ? "Failed"
        : data.totalChunks === 0
          ? "Preparing chunks…"
          : `Processing ${data.completedChunks}/${data.totalChunks} chunks`;

  const Icon =
    data.status === "completed"
      ? CheckCircle
      : data.status === "failed"
        ? AlertCircle
        : Loader2;

  return (
    <div className={`rounded-xl border p-4 space-y-3 ${colorClasses}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Icon
            className={`w-5 h-5 ${
              data.status === "completed"
                ? "text-green-600"
                : data.status === "failed"
                  ? "text-red-600"
                  : "text-teal-600 animate-spin"
            }`}
          />
          <div>
            <p className="text-sm font-semibold text-gray-900">
              {statusLabel}
            </p>
            <p className="text-xs text-gray-500 font-mono">{data.id}</p>
          </div>
        </div>

        {isTerminal && onDismiss && (
          <button
            onClick={onDismiss}
            className="text-xs text-gray-500 hover:text-gray-800 px-2 py-1"
          >
            Dismiss
          </button>
        )}
      </div>

      {/* Progress bar */}
      <div className="space-y-1">
        <div className="flex justify-between text-xs text-gray-600">
          <span>{data.percent}% complete</span>
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {formatElapsed(elapsedSeconds)}
          </span>
        </div>
        <div className="h-2 bg-white/70 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-500 ${barColor}`}
            style={{ width: `${Math.max(data.percent, data.totalChunks > 0 ? 3 : 0)}%` }}
          />
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 text-xs">
        <Stat label="Running" value={data.breakdown.running} tone="teal" />
        <Stat label="Done" value={data.breakdown.done} tone="green" />
        <Stat label="Failed" value={data.breakdown.failed} tone="red" />
        <Stat
          label={isTerminal ? "Leads saved" : "Leads found"}
          value={isTerminal ? data.newLeadsSaved : data.rawLeadsFound}
          tone="gray"
        />
      </div>

      {data.status === "failed" && data.errorMessage && (
        <p className="text-xs text-red-700 bg-white/70 p-2 rounded-lg">
          {data.errorMessage}
        </p>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "teal" | "green" | "red" | "gray";
}) {
  const color =
    tone === "teal"
      ? "text-teal-700"
      : tone === "green"
        ? "text-green-700"
        : tone === "red"
          ? "text-red-700"
          : "text-gray-700";
  return (
    <div className="bg-white/70 rounded-lg p-2">
      <p className="text-gray-500">{label}</p>
      <p className={`text-base font-semibold ${color}`}>{value}</p>
    </div>
  );
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}
