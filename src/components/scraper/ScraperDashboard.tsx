"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, AlertCircle, CheckCircle } from "lucide-react";
import { ScraperRunsTable } from "./ScraperRunsTable";
import { QueryManager } from "./QueryManager";
import { ScraperRunProgress } from "./ScraperRunProgress";

const ACTIVE_RUN_KEY = "scraper:active-run-id";

interface ScraperDashboardProps {
  onSelectRun?: (runId: string) => void;
}

export function ScraperDashboard({ onSelectRun }: ScraperDashboardProps) {
  const queryClient = useQueryClient();

  const [toast, setToast] = useState<{
    type: "success" | "error";
    msg: string;
  } | null>(null);

  const [tab, setTab] = useState<"history" | "queries">("history");

  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  useEffect(() => {
    const stored =
      typeof window !== "undefined"
        ? localStorage.getItem(ACTIVE_RUN_KEY)
        : null;
    if (stored) setActiveRunId(stored);
  }, []);

  // On mount (and on any history refresh), check the server for any run
  // currently in 'running' state — this surfaces a scrape that was started
  // from another tab/session so the user always sees live progress.
  const { data: runsList } = useQuery({
    queryKey: ["scraper-runs", 1],
    queryFn: async () => {
      const res = await fetch(`/api/scraper/run?page=1`);
      const json = await res.json();
      if (!json.success) throw new Error("Failed to load runs");
      return json.data;
    },
  });

  useEffect(() => {
    if (activeRunId) return;
    const activeRun = (runsList?.data ?? []).find(
      (r: any) => r.status === "running" || r.status === "cancelling",
    );
    if (activeRun) {
      setActiveRunId(activeRun.id);
      if (typeof window !== "undefined") {
        localStorage.setItem(ACTIVE_RUN_KEY, activeRun.id);
      }
    }
  }, [runsList, activeRunId]);

  const showToast = (type: "success" | "error", msg: string) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), type === "success" ? 4000 : 8000);
  };

  const handleRunStarted = (runId: string) => {
    setActiveRunId(runId);
    if (typeof window !== "undefined") {
      localStorage.setItem(ACTIVE_RUN_KEY, runId);
    }
    queryClient.invalidateQueries({ queryKey: ["scraper-runs"] });
    showToast("success", "Scraper started — tracking progress below");
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-teal-50 rounded-xl flex items-center justify-center shadow-sm">
            <Search className="w-5 h-5 text-teal-600" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-900">
              Dealer Lead Scraper
            </h1>
            <p className="text-sm text-gray-500">
              Discover 3-wheeler battery dealers from the web automatically
            </p>
          </div>
        </div>

        <QueryManager
          disabled={
            !!activeRunId &&
            !!runsList?.data?.find(
              (r: any) =>
                r.id === activeRunId &&
                (r.status === "running" || r.status === "cancelling"),
            )
          }
          onRunStarted={handleRunStarted}
          onError={(msg) => showToast("error", msg)}
        />
      </div>

      {/* Live progress for active run */}
      {activeRunId && (
        <ScraperRunProgress
          runId={activeRunId}
          onComplete={() => {
            queryClient.invalidateQueries({ queryKey: ["scraper-runs"] });
          }}
          onDismiss={() => {
            setActiveRunId(null);
            if (typeof window !== "undefined") {
              localStorage.removeItem(ACTIVE_RUN_KEY);
            }
          }}
        />
      )}

      {/* Toast */}
      {toast && (
        <div
          className={`flex items-start gap-3 p-4 rounded-xl text-sm ${
            toast.type === "success"
              ? "bg-green-50 text-green-800 border border-green-100"
              : "bg-red-50 text-red-800 border border-red-100"
          }`}
        >
          {toast.type === "success" ? (
            <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          )}
          <span>{toast.msg}</span>
        </div>
      )}

      {/* Info Cards */}
      {/* <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-teal-50/60 border border-teal-100 rounded-xl p-4">
          <p className="text-xs text-teal-600 font-medium mb-0.5">
            Data Sources
          </p>
          <p className="text-sm text-gray-700">
            JustDial · IndiaMART · Sulekha · Google
          </p>
        </div>
        <div className="bg-teal-50/60 border border-teal-100 rounded-xl p-4">
          <p className="text-xs text-teal-600 font-medium mb-0.5">
            Deduplication
          </p>
          <p className="text-sm text-gray-700">
            Phone · Name + City · Source URL
          </p>
        </div>
        <div className="bg-teal-50/60 border border-teal-100 rounded-xl p-4">
          <p className="text-xs text-teal-600 font-medium mb-0.5">Assignment</p>
          <p className="text-sm text-gray-700">
            Assign new leads to Sales Managers
          </p>
        </div>
      </div> */}

      {/* Schedule */}
      {/* <ScheduleConfig /> */}

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 rounded-lg p-1 w-fit">
        <button
          onClick={() => setTab("history")}
          className={`px-4 py-1.5 rounded-md text-sm font-medium ${
            tab === "history"
              ? "bg-white text-gray-900 shadow-sm"
              : "text-gray-500"
          }`}
        >
          Run History
        </button>
      </div>

      {/* Tab Content */}
      {tab === "history" && (
        <div>
          <h2 className="text-sm font-semibold text-gray-700 mb-3">
            Run History
          </h2>
          <ScraperRunsTable onSelectRun={onSelectRun} />
        </div>
      )}
    </div>
  );
}
