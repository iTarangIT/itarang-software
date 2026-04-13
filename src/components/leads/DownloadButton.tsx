"use client";

import { useState } from "react";
import { Download, Loader2, Sheet } from "lucide-react";

export function DownloadConvertedLeadsButton() {
  const [loading, setLoading] = useState(false);

  const handleDownload = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/scraper-leads/converted/download");
      if (!res.ok) throw new Error("Download failed");

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const filename = `iTarang_Converted_Leads_${new Date().toISOString().slice(0, 10)}.xlsx`;

      // Trigger browser download
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Download error:", err);
      alert("Failed to download. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleDownload}
      disabled={loading}
      className="flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 text-gray-700 text-sm font-medium rounded-xl hover:border-gray-300 hover:bg-gray-50 transition-all shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {loading ? (
        <>
          <Loader2 className="w-4 h-4 animate-spin" />
          Exporting…
        </>
      ) : (
        <>
          <Download className="w-4 h-4" />
          Download Excel
        </>
      )}
    </button>
  );
}

// ─── Google Sheets link button ────────────────────────────────

export function OpenGoogleSheetButton() {
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${process.env.NEXT_PUBLIC_GOOGLE_SHEET_ID}`;

  return (
    <a
      href={sheetUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 text-gray-700 text-sm font-medium rounded-xl hover:border-gray-300 hover:bg-gray-50 transition-all shadow-sm"
    >
      <Sheet className="w-4 h-4 text-emerald-600" />
      Open in Sheets
    </a>
  );
}
