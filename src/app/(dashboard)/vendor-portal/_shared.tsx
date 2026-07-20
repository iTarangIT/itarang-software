"use client";

/**
 * Shared building blocks for the scrap vendor's portal (E-195, BRD M24).
 *
 * The vendor's whole surface is driven by ONE endpoint — /api/vendor/threads,
 * scoped to this vendor and masked twice over (no dealer identity, no iTarang
 * margin, only this vendor's own ask/counter/agreed prices; see toVendorThread).
 * Every vendor page reads from the same `useVendorThreads` hook so there is one
 * fetch shape, one status vocabulary, and one privacy promise across all of
 * Dashboard / Inbox / My Bids / Orders / Payments.
 *
 * Anything added here is a new vendor-facing surface and has to survive the
 * masking rule — see toVendorThread's contract test in lib/buyback/serialize.ts.
 */

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";

import { useAuth } from "@/components/auth/AuthProvider";
import { inr } from "@/lib/buyback/format";

export interface VendorLine {
  line_id: string;
  spec_label: string;
  condition: string;
  quantity: number;
  ask_price: number | string | null;
  counter_price: number | string | null;
  agreed_price: number | string | null;
  /** Battery photo ids — rendered via GET /api/vendor/threads/:id/photo. */
  photos: { id: string }[];
}

export interface VendorThread {
  thread_id: string;
  quotation_no: string;
  status: "SENT" | "COUNTERED" | "AGREED" | "LOST";
  pickup_city: string | null;
  pickup_state: string | null;
  lines: VendorLine[];
  total_units: number;
  ask_total: number | null;
  counter_total: number | null;
  agreed_total: number | null;
  sent_at: string | null;
  responded_at: string | null;
  can_respond: boolean;
  can_raise_po: boolean;
  proforma: { number: string; total: number; pdf_available: boolean } | null;
}

export type VendorStatus = VendorThread["status"];

/** Bordered chip used in the detailed row lists (long, explanatory label). */
export const STATUS_STYLE: Record<VendorStatus, string> = {
  SENT: "bg-amber-50 text-amber-700 border-amber-200",
  COUNTERED: "bg-blue-50 text-blue-700 border-blue-200",
  AGREED: "bg-green-50 text-green-700 border-green-200",
  LOST: "bg-slate-100 text-slate-500 border-slate-200",
};

export const STATUS_LABEL: Record<VendorStatus, string> = {
  SENT: "Awaiting your response",
  COUNTERED: "Your counter is with iTarang",
  AGREED: "Agreed — yours",
  LOST: "Closed",
};

/* The short, table-cell version of the status: a rounded pill matching the
   design handoff. StatusChip from the buyback kit is keyed to the 21 dealer
   deal-states, not this vendor-only 4-state enum, so the vendor's own pill
   lives here. */
const STATUS_PILL: Record<VendorStatus, { label: string; className: string }> = {
  SENT: { label: "Sent", className: "bg-amber-100 text-amber-700" },
  COUNTERED: { label: "Countered", className: "bg-blue-100 text-blue-700" },
  AGREED: { label: "Agreed", className: "bg-emerald-100 text-emerald-700" },
  LOST: { label: "Lost", className: "bg-slate-100 text-slate-600" },
};

export function VendorStatusPill({ status }: { status: VendorStatus }) {
  const s = STATUS_PILL[status];
  return (
    <span
      className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-[3px] text-[11px] font-bold tracking-wide ${s.className}`}
    >
      {s.label}
    </span>
  );
}

/** The representative ₹/unit for a column — the highest across the lot's SKUs
 * (so "Top Ask" reads as the top ask). Prices arrive as numeric strings; nulls
 * and non-numbers are dropped. Returns null when the vendor has not priced yet
 * (e.g. no counter on a SENT lot), which renders as "—". */
export function topPerUnit(values: Array<number | string | null>): number | null {
  const nums = values
    .filter((v) => v !== null && v !== "")
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n));
  return nums.length ? Math.max(...nums) : null;
}

export function perUnitLabel(value: number | null): string {
  return value === null ? "—" : `${inr(value)}/u`;
}

/** "18 Jul 2026" — or "—" for a null/invalid timestamp. */
export function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

/**
 * The single data source for every vendor page. One fetch of the masked thread
 * list, plus a `reload` the PO flow calls after it changes server state.
 */
export function useVendorThreads() {
  const [threads, setThreads] = useState<VendorThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/vendor/threads")
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j?.success === false) {
          setError(j?.error?.message ?? "Could not load your quotations.");
          return;
        }
        setError(null);
        setThreads(j?.data?.threads ?? []);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load your quotations.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return { threads, loading, error, reload };
}

/**
 * The chrome every vendor page shares: the buyback page shell (centered,
 * `bg-bb-bg`), a title with an optional release/count badge, a subtitle, and
 * the masking promise the whole portal is built on, said out loud.
 */
export function VendorPageShell({
  title,
  badge,
  subtitle,
  children,
}: {
  title: string;
  badge?: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const { user } = useAuth();
  const vendorName = user?.name?.trim() || "Your account";

  return (
    <div className="bg-bb-bg px-6 py-6">
      <div className="mx-auto max-w-[1180px]">
        <div className="mb-5">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-[22px] font-extrabold tracking-[-.3px] text-slate-900">{title}</h1>
            {badge && (
              <span className="rounded-md bg-teal-600 px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide text-white">
                {badge}
              </span>
            )}
          </div>
          <div className="mt-[3px] text-[13px] text-slate-500">
            {subtitle ?? `${vendorName} — your quotation activity with iTarang`}
          </div>
        </div>

        <div className="mb-[18px] flex items-center gap-2 rounded-lg border border-teal-200 bg-teal-50 px-3.5 py-2.5 text-[12.5px] text-teal-800">
          <span aria-hidden>🔒</span>
          <span>
            Vendors never see dealer identity or the iTarang margin — only the ask price.
          </span>
        </div>

        {children}
      </div>
    </div>
  );
}

/** Loading / error one-liner shared by the pages. Returns null when neither. */
export function VendorStateNote({
  loading,
  error,
}: {
  loading: boolean;
  error: string | null;
}) {
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (loading) return <p className="py-16 text-center text-sm text-slate-400">Loading…</p>;
  return null;
}

/**
 * The vendor's controls on a won lot: raise your PO, then see (and download)
 * the proforma iTarang issues against it. Lives here so both the Orders &
 * Documents page and any future surface reuse the exact same gated flow.
 *
 * Every gate is server-derived — can_raise_po and proforma come off the deal's
 * own state — so this only renders what is actually available. The vendor never
 * sees a "raise PO" button for a lot they have not won, or a proforma that does
 * not exist yet.
 */
export function VendorPoPanel({
  thread,
  onRaised,
}: {
  thread: VendorThread;
  onRaised: () => void;
}) {
  const [poNumber, setPoNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const raise = async () => {
    if (!poNumber.trim()) {
      setErr("Enter your purchase order number.");
      return;
    }
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/vendor/threads/${thread.thread_id}/po`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ number: poNumber.trim() }),
    }).catch(() => null);
    const json = await res?.json().catch(() => null);
    setBusy(false);
    if (!json?.success) {
      setErr(json?.error?.message ?? "Could not submit your purchase order.");
      return;
    }
    onRaised();
  };

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
      {/* Step 2 — the vendor is the buyer, so the vendor raises the PO. */}
      {thread.can_raise_po && (
        <div>
          <div className="text-[12px] font-semibold text-slate-700">
            Raise your purchase order
          </div>
          <p className="mt-0.5 text-[11.5px] text-slate-500">
            You&apos;ve won this lot. Send us your PO number and we&apos;ll issue a proforma
            invoice against it.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              value={poNumber}
              onChange={(e) => setPoNumber(e.target.value)}
              placeholder="Your PO number"
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-[12.5px]"
            />
            <button
              onClick={() => void raise()}
              disabled={busy}
              className="rounded-lg bg-bb-navy px-3 py-1.5 text-[12.5px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Submitting…" : "Submit PO"}
            </button>
          </div>
          {err && <p className="mt-1.5 text-[11.5px] text-red-600">{err}</p>}
        </div>
      )}

      {/* Steps 3 + 4 — the proforma is issued; the vendor pays against it. */}
      {thread.proforma && (
        <div className={thread.can_raise_po ? "mt-3 border-t border-slate-200 pt-3" : ""}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] font-semibold text-slate-700">
              Proforma invoice {thread.proforma.number}
            </span>
            <span className="text-[13px] font-bold tabular-nums text-slate-900">
              {inr(thread.proforma.total)}
            </span>
            {thread.proforma.pdf_available && (
              <a
                href={`/api/vendor/threads/${thread.thread_id}/proforma`}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto rounded-md border border-slate-300 px-2.5 py-1 text-[11.5px] font-semibold text-slate-600 hover:bg-white"
              >
                Download
              </a>
            )}
          </div>
          <p className="mt-1 text-[11px] text-slate-400">
            A proforma is our statement of what you&apos;ll pay — not a demand for payment. A tax
            invoice follows.
          </p>
        </div>
      )}
    </div>
  );
}
