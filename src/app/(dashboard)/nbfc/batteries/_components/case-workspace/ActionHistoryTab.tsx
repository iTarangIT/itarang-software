"use client";

import { useEffect, useState } from "react";

interface ActionHistoryItem {
  source: "borrower_action" | "immobilisation_action" | "audit_log";
  id: string;
  action_type: string | null;
  status: string | null;
  created_at: string | null;
}

const ACTION_LABELS: Record<string, string> = {
  immobilisation: "Immobilisation",
  battery_immobilisation: "Battery immobilisation (IoT)",
  payment_reminder: "Payment reminder",
  field_visit: "Field visit",
  loan_restructuring: "Loan restructuring",
  flag_for_recovery: "Flag for recovery",
  unflag_for_recovery: "Recovery flag withdrawn",
  pii_data_access: "PII access",
  audit_log_export: "Audit log export",
  risk_rule_threshold_change: "Risk rule threshold change",
  bulk_immobilisation: "Bulk immobilisation",
};

function statusPill(status: string | null) {
  if (!status) return null;
  const v = status.toLowerCase();
  const tone =
    v === "approved" || v === "auto_approved" || v === "executed"
      ? "bg-emerald-50 text-emerald-700"
      : v === "pending_dual_approval" || v === "pending_approval" || v === "pending"
        ? "bg-amber-50 text-amber-800"
        : v === "rejected" || v === "expired"
          ? "bg-red-50 text-red-700"
          : "bg-slate-100 text-slate-600";
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

function sourceTag(source: ActionHistoryItem["source"]) {
  const label =
    source === "borrower_action"
      ? "Action"
      : source === "immobilisation_action"
        ? "IoT"
        : "Audit";
  return (
    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-widest text-slate-600">
      {label}
    </span>
  );
}

export function ActionHistoryTab({
  loanSanctionId,
}: {
  loanSanctionId: string;
}) {
  const [items, setItems] = useState<ActionHistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(
          `/api/nbfc/loans/${encodeURIComponent(loanSanctionId)}/action-history`,
          { cache: "no-store" },
        );
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(typeof body?.error === "string" ? body.error : `HTTP ${res.status}`);
          setItems([]);
          return;
        }
        setItems(Array.isArray(body.items) ? body.items : []);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setItems([]);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [loanSanctionId]);

  if (items === null) {
    return (
      <p className="p-4 text-sm italic text-[color:var(--color-ink-muted)]">
        Loading action history…
      </p>
    );
  }

  if (items.length === 0) {
    return (
      <div className="space-y-2">
        {error ? (
          <p className="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            {error}
          </p>
        ) : null}
        <p className="rounded border border-dashed border-[color:var(--color-border)] p-4 text-sm italic text-[color:var(--color-ink-muted)]">
          No actions recorded for this loan yet.
        </p>
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {items.map((r) => (
        <li
          key={`${r.source}:${r.id}`}
          className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-3"
        >
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {sourceTag(r.source)}
            <span className="font-semibold">
              {ACTION_LABELS[r.action_type ?? ""] ?? r.action_type ?? "—"}
            </span>
            {statusPill(r.status)}
            <span className="ml-auto text-[11px] tabular-nums text-[color:var(--color-ink-muted)]">
              {r.created_at
                ? new Date(r.created_at).toLocaleString("en-IN")
                : "—"}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

export default ActionHistoryTab;
