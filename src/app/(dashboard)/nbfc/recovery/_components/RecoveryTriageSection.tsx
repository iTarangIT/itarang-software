"use client";

/**
 * E-292 — the triage queue on the Recovery & Auction page (refurbish flow v3
 * R2/R3): every recovered battery that has not yet been sent down a branch,
 * with the voltage / health / suggestion panel inline. The register page
 * offers the same panel per row; this is the "what still needs triaging"
 * view an operator scans first.
 */
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { nbfcFetch } from "@/lib/auction/client";
import RecoveryTriagePanel, { type TriageBattery } from "@/components/nbfc-portal/RecoveryTriagePanel";

export default function RecoveryTriageSection() {
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["auction", "nbfc", "batteries", "triage"],
    queryFn: () => nbfcFetch<{ items: TriageBattery[] }>("/api/nbfc/recovery/batteries?state=all"),
    refetchOnWindowFocus: true,
  });
  // Untriaged first, then triaged-but-unchosen; anything already sent down a branch is done.
  const items = (data?.items ?? []).filter((b) => ["draft", "intaken", "inspected"].includes(b.state_code) && !b.triage_choice);

  const onChange = () => {
    qc.invalidateQueries({ queryKey: ["auction", "nbfc", "batteries"] });
    router.refresh();
  };

  return (
    <div className="card-iTarang p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="section-label-muted">Recovery triage</p>
          <p className="mt-1 text-sm font-semibold text-[color:var(--color-brand-navy)]">Voltage → health % → auction / redeploy / refurbish / scrap</p>
          <p className="mt-0.5 text-xs text-[color:var(--color-ink-muted)]">Record rated and measured voltage; the system suggests a branch, you click it. Refurbish is optional.</p>
        </div>
        <Link href="/nbfc/recovery/batteries" className="text-xs font-semibold text-[color:var(--color-brand-sky)] hover:underline">Battery register →</Link>
      </div>
      {isError ? <p className="text-sm text-red-700">{(error as Error).message}</p> : isLoading ? (
        <p className="text-sm text-[color:var(--color-ink-muted)]">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-center text-sm text-[color:var(--color-ink-muted)] py-4">Nothing awaiting triage.</p>
      ) : (
        <ul className="divide-y divide-[color:var(--color-border)]">
          {items.map((b) => (
            <li key={b.id} className="py-2">
              <button type="button" className="flex w-full items-center justify-between gap-2 text-left" onClick={() => setOpen((o) => (o === b.id ? null : b.id))}>
                <span className="font-mono text-[12px]">{b.serial}<span className="ml-2 text-[11px] text-[color:var(--color-ink-muted)]">{b.model ?? ""}</span></span>
                <span className="text-[11px] font-semibold tabular-nums">{b.health_pct != null ? `${b.health_pct}% · ${b.triage_suggestion?.replace(/_/g, " ") ?? ""}` : "no reading"}</span>
              </button>
              {open === b.id ? <div className="auction-sheet"><RecoveryTriagePanel key={`${b.id}-${b.triaged_at ?? ""}`} battery={b} onChange={onChange} /></div> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
