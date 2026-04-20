"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Plus, Loader2 } from "lucide-react";

interface QueryManagerProps {
  showInput?: boolean;
  disabled?: boolean;
  onRunStarted?: (runId: string) => void;
  onError?: (message: string) => void;
}

export function QueryManager({
  showInput = true,
  disabled = false,
  onRunStarted,
  onError,
}: QueryManagerProps) {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleRun() {
    const text = query.trim();
    if (!text) return;

    try {
      setLoading(true);

      const res = await fetch("/api/scraper/run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: text,
        }),
      });

      const json = await res.json();

      if (!json.success) {
        onError?.(json.error?.message || "Failed to start scraper");
        return;
      }

      onRunStarted?.(json.data.run_id);
      setQuery("");
    } catch (err) {
      console.error(err);
      onError?.("Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  const isDisabled = loading || disabled || !query.trim();

  return (
    <div className="space-y-4">
      {showInput && (
        <div className="flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !isDisabled && handleRun()}
            disabled={disabled || loading}
            placeholder={
              disabled
                ? "A scrape is already running…"
                : "Enter search query (e.g. 3w battery in mumbai)"
            }
            className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:bg-gray-50 disabled:cursor-not-allowed"
          />

          <Button
            onClick={handleRun}
            disabled={isDisabled}
            className="bg-teal-600 hover:bg-teal-700 text-white gap-2"
          >
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Plus className="w-4 h-4" />
            )}
            {loading ? "Starting…" : "Run"}
          </Button>
        </div>
      )}
    </div>
  );
}
