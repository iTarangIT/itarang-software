"use client";

import { useState } from "react";

interface OcrAutofillButtonProps {
  leadId: string;
  docType: string | string[];
  cachedOcrData?: Record<string, unknown> | null;
  onOcrResult: (data: Record<string, unknown>, source: string) => void;
  disabled?: boolean;
}

export default function OcrAutofillButton({
  leadId,
  docType,
  cachedOcrData,
  onOcrResult,
  disabled,
}: OcrAutofillButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [lastSource, setLastSource] = useState("");

  const runOcr = async () => {
    setError("");

    // If cached data exists, use it immediately
    if (cachedOcrData && Object.keys(cachedOcrData).length > 0) {
      setLastSource("cached");
      onOcrResult(cachedOcrData, "cached");
      return;
    }

    // Try each doc type in order (for bank docs with multiple cheques)
    const types = Array.isArray(docType) ? docType : [docType];
    setLoading(true);
    let lastError = "";

    for (const dt of types) {
      try {
        const res = await fetch(`/api/admin/kyc/${leadId}/ocr`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ doc_type: dt }),
        });
        const data = await res.json();

        if (data.success && data.ocr_data) {
          setLastSource(data.source || "ocr");
          onOcrResult(data.ocr_data, data.source || "ocr");
          setLoading(false);
          return;
        }
        // If this doc_type had no document, try next
        if (data.error) lastError = data.error;
      } catch {
        // Try next doc type
      }
    }

    setError(lastError || "No OCR data found. Upload a document first.");
    setLoading(false);
  };

  return (
    <div className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={runOcr}
        disabled={disabled || loading}
        className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md bg-teal-50 text-teal-700 border border-teal-200 hover:bg-teal-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? (
          <>
            <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Extracting...
          </>
        ) : (
          <>
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 3.75H6A2.25 2.25 0 003.75 6v1.5M16.5 3.75H18A2.25 2.25 0 0120.25 6v1.5M20.25 16.5V18a2.25 2.25 0 01-2.25 2.25h-1.5M3.75 16.5V18A2.25 2.25 0 006 20.25h1.5M9 12h6m-3-3v6" />
            </svg>
            Autofill OCR
          </>
        )}
      </button>
      {lastSource && !error && (
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
          lastSource === "decentro" ? "bg-green-50 text-green-600" :
          lastSource === "cached" ? "bg-blue-50 text-blue-600" :
          "bg-yellow-50 text-yellow-600"
        }`}>
          {lastSource === "decentro" ? "Decentro OCR" :
           lastSource === "cached" ? "Cached" :
           "Local OCR"}
        </span>
      )}
      {error && (
        <span className="text-[10px] text-red-500">{error}</span>
      )}
    </div>
  );
}
