"use client";

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";

export function DownloadScrapedLeadsButton() {
  const [loading, setLoading] = useState(false);

  const handleDownload = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/scraper-leads/download");
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message || "Download failed");
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const filename = `iTarang_Scraped_Leads_${new Date()
        .toISOString()
        .slice(0, 10)}.xlsx`;

      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      console.error("Download error:", err);
      alert(err?.message ?? "Failed to download. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative group inline-block">
      <button
        onClick={handleDownload}
        disabled={loading}
        className="flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 text-gray-700 text-sm font-medium rounded-xl hover:border-gray-300 hover:bg-gray-50 transition-all shadow-sm disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
      >
        {loading ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Exporting…
          </>
        ) : (
          <>
            <Download className="w-4 h-4 text-emerald-600" />
            Download Leads
          </>
        )}
      </button>

      {/* Tooltip — appears on hover, hidden while exporting */}
      {!loading && (
        <div
          role="tooltip"
          className="pointer-events-none absolute right-0 top-full mt-2 w-72 px-3 py-2 rounded-lg bg-gray-900 text-white text-xs leading-snug shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-50"
        >
          Download an Excel sheet of every scraped lead — name, company, phone,
          email, address — across all scraper runs. Each row includes the
          scraper run ID so you can sort or filter by run.
          <span className="absolute -top-1 right-5 w-2 h-2 bg-gray-900 rotate-45" />
        </div>
      )}
    </div>
  );
}
