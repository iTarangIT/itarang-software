"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Plus, Loader2 } from "lucide-react";

export function QueryManager() {
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
        alert(json.error?.message || "Failed to start scraper");
        return;
      }

      alert("Scraper started successfully");

      setQuery("");
    } catch (err) {
      console.error(err);
      alert("Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleRun()}
          placeholder="Enter search query (e.g. 3w battery in mumbai)"
          className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
        />

        <Button
          onClick={handleRun}
          disabled={loading || !query.trim()}
          className="bg-teal-600 hover:bg-teal-700 text-white gap-2"
        >
          {loading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Plus className="w-4 h-4" />
          )}
          Run
        </Button>
      </div>
    </div>
  );
}
