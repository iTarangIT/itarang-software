"use client";

// [E-013] LenderDropdown — admin loan-sanction lender picker.
//
// BRD §6.0.8: shows only the NBFCs that this dealer is assigned to (via
// dealer_nbfc_assignments) — the sole source of truth is
// GET /api/admin/dealers/{dealerId}/assigned-nbfcs (Sync Audit G-05).
//
// Each option exposes a flat list of active loan products so a downstream
// product picker can render without a second round-trip.

import { useEffect, useState } from "react";

type LoanProduct = {
  id: number;
  productName: string;
  loanAmountMin: number;
  loanAmountMax: number;
};

export type AssignedNbfc = {
  nbfcId: number;
  shortName: string;
  legalName: string;
  activeLoanProducts: LoanProduct[];
};

type Props = {
  dealerId: number | string;
  value?: number | null;
  onChange?: (nbfcId: number | null, nbfc: AssignedNbfc | null) => void;
  disabled?: boolean;
  className?: string;
};

export default function LenderDropdown({
  dealerId,
  value,
  onChange,
  disabled,
  className,
}: Props) {
  const [items, setItems] = useState<AssignedNbfc[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!dealerId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(
      `/api/admin/dealers/${encodeURIComponent(String(dealerId))}/assigned-nbfcs?status=active`,
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        setItems(Array.isArray(data?.items) ? (data.items as AssignedNbfc[]) : []);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message ?? "Failed to load lenders");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dealerId]);

  return (
    <select
      className={className}
      disabled={disabled || loading}
      value={value ?? ""}
      onChange={(e) => {
        const raw = e.target.value;
        if (!raw) {
          onChange?.(null, null);
          return;
        }
        const id = Number(raw);
        const match = items.find((it) => it.nbfcId === id) ?? null;
        onChange?.(id, match);
      }}
    >
      <option value="">
        {loading
          ? "Loading lenders…"
          : error
            ? `Error: ${error}`
            : items.length === 0
              ? "No lenders assigned to this dealer"
              : "Select a lender"}
      </option>
      {items.map((it) => (
        <option key={it.nbfcId} value={it.nbfcId}>
          {it.shortName} — {it.legalName}
        </option>
      ))}
    </select>
  );
}
