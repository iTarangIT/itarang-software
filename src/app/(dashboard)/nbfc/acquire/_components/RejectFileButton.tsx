"use client";

// E-275 — "Reject file" on the Verification step, next to "Next: Offer". The
// NBFC walks away from the whole file with a required reason; the rejection
// waits with the iTarang admin, who relays it to the dealer. Same endpoint the
// Offer panel's Reject uses.

import { useState } from "react";
import { Loader2, XCircle } from "lucide-react";

const clean = (msg: string) => msg.replace(/^[A-Z_]+:\s*/, "");

export default function RejectFileButton({ leadId }: { leadId: string }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reject() {
    const trimmed = note.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/nbfc/acquire/${leadId}/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: trimmed }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
      // The stepper is server-rendered; reload so the Offer node reads Rejected.
      window.location.reload();
    } catch (e) {
      setError(clean(e instanceof Error ? e.message : String(e)));
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm font-semibold text-red-700 transition hover:bg-red-100"
      >
        <XCircle className="h-4 w-4" />
        Reject file
      </button>
    );
  }

  return (
    <div className="w-full rounded-lg border border-red-200 bg-red-50/60 p-3 sm:basis-full">
      <label className="block text-[11px] font-semibold text-red-800">
        Reason for rejecting this file <span className="text-red-500">*</span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="e.g. Bureau score below policy; income proof insufficient for the requested amount…"
          className="mt-1 w-full rounded-md border border-red-200 bg-white px-2 py-1.5 text-sm font-normal text-slate-800"
        />
      </label>
      <p className="mt-1 text-[11px] text-red-700">
        This reason goes to iTarang, who relays it to the dealer so the customer can choose another NBFC. It cannot be undone.
      </p>
      {error ? <p className="mt-1 text-[11px] text-rose-700">{error}</p> : null}
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setNote("");
            setError(null);
          }}
          disabled={busy}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={reject}
          disabled={busy || note.trim().length === 0}
          className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {busy ? "Rejecting…" : "Reject file"}
        </button>
      </div>
    </div>
  );
}
