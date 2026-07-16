"use client";

/**
 * Shared evidence-upload atom (U1) — attaches a receipt/PDF to a buyback
 * request: settlement proof, e-way bill, weighbridge slip, vendor PO, dealer
 * invoice. Used on both the admin side (posting to
 * /api/admin/buyback/uploads) and the dealer side (/api/buyback/uploads) —
 * `endpoint` is the only thing that differs between the two.
 *
 * Modelled on the intake's ProofUpload (src/components/buyback/intake/
 * BuybackIntake.tsx:1662-1749) but built fresh rather than imported: that
 * component is LINE-scoped (fixed line_id, posts only to /api/buyback/uploads)
 * and shows a thumbnail preview; this one is REQUEST-scoped, endpoint-agnostic,
 * and these are receipts/PDFs, not battery photos — a preview thumbnail is not
 * worth the code. Same look: dashed empty state, green uploaded chip, "Replace".
 *
 * On failure the PREVIOUS value is kept — a rejected replace must not silently
 * clear evidence that was already attached — and the server's own sentence is
 * shown inline, small and red, under the control.
 */

import { useRef, useState } from "react";

export default function EvidenceUpload({
  endpoint,
  kind,
  requestId,
  label = "file",
  accept = "image/*,application/pdf",
  value,
  onChange,
  disabled = false,
}: {
  endpoint: string;
  kind: string;
  requestId: string;
  label?: string;
  accept?: string;
  value: { key: string; name: string } | null;
  onChange: (v: { key: string; name: string } | null) => void;
  disabled?: boolean;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const pick = async (file: File) => {
    setUploading(true);
    setError(null);

    const form = new FormData();
    form.append("file", file, file.name);
    form.append("request_id", requestId);
    form.append("kind", kind);

    try {
      let res: Response;
      try {
        res = await fetch(endpoint, { method: "POST", body: form });
      } catch {
        throw new Error(
          "The upload could not reach the server — check your internet connection and try again.",
        );
      }

      const json = await res.json().catch(() => null);
      if (!json?.success) throw new Error(json?.error?.message ?? "Upload failed.");

      onChange({ key: json.data.s3_key as string, name: file.name });
    } catch (e) {
      // Previous value stays — see file header.
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      {/* One hidden input, reused by both the empty-state button and "Replace" —
          there is never a reason for two. */}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        disabled={disabled}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void pick(file);
          // Reset, or picking the same file twice in a row fires no change event.
          e.target.value = "";
        }}
      />

      {uploading ? (
        <div className="flex items-center rounded-lg border border-dashed border-slate-300 bg-white px-3 py-2 text-sm text-slate-400">
          Uploading…
        </div>
      ) : value ? (
        <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2">
          <span
            className="min-w-0 flex-1 truncate text-xs font-medium text-green-800"
            title={value.name}
          >
            {value.name}
          </span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
            className="shrink-0 text-xs font-semibold text-green-700 hover:underline disabled:cursor-not-allowed disabled:text-green-300"
          >
            Replace
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          className="flex w-full items-center rounded-lg border border-dashed border-slate-300 bg-white px-3 py-2 text-left text-sm text-slate-400 hover:border-slate-400 hover:text-slate-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          ⇧ Upload {label}
        </button>
      )}

      {error && <p className="mt-1 text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
