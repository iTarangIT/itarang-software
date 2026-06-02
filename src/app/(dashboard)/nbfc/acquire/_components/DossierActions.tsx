"use client";

// Action bar for the Verification-step customer dossier (Addendum V0.2 §6/§7).
//  • Download — streams the full customer-profile ZIP (summary PDF + every
//    document) from the tenant-scoped route, triggered client-side as a blob.
//  • Next — advances the on-page stepper to the Offer step by dispatching the
//    `nbfc:acquire-open-step` event the stepper listens for (no navigation).

import { useState } from "react";
import { ArrowRight, Download, Loader2 } from "lucide-react";

export const OPEN_STEP_EVENT = "nbfc:acquire-open-step";

export default function DossierActions({ leadId }: { leadId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/nbfc/acquire/${leadId}/download-dossier`);
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        throw new Error(j.error?.message ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `customer_dossier_${leadId}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function goToOffer() {
    window.dispatchEvent(
      new CustomEvent(OPEN_STEP_EVENT, { detail: { key: "offer" } }),
    );
  }

  return (
    <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-end">
      {error ? (
        <span className="text-xs text-rose-600 sm:mr-auto">{error}</span>
      ) : null}
      <button
        type="button"
        onClick={download}
        disabled={busy}
        className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-[color:var(--color-brand-sky)] hover:text-[color:var(--color-brand-sky)] disabled:opacity-50"
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Download className="h-4 w-4" />
        )}
        {busy ? "Preparing ZIP…" : "Download dossier"}
      </button>
      <button
        type="button"
        onClick={goToOffer}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110"
      >
        Next: Offer
        <ArrowRight className="h-4 w-4" />
      </button>
    </div>
  );
}
