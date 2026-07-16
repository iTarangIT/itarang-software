"use client";

/**
 * The dealer's invoice (M12) — their side of the money.
 *
 * Self-contained: fetches and reloads its own state, so the dealer detail page
 * mounts it with one line.
 *
 * WHAT THE DEALER SUPPLIES: their own invoice number (their GST series, their
 * document) and optionally their PDF. WHAT THEY DO NOT SUPPLY: any price. The
 * lines are shown prefilled from the locked per-SKU prices they already accepted,
 * and the server takes the figures from the locks regardless of what arrives in
 * the request body. There is nothing here for them to get wrong.
 *
 * If we returned their last invoice, the reason is shown verbatim, at the top,
 * before anything else — a dealer who has to guess what was wrong will guess
 * wrong and be returned twice.
 */

import { useCallback, useEffect, useState } from "react";

import { EvidenceUpload } from "./ui";
import { inr } from "@/lib/buyback/format";

interface Line {
  line_id: string;
  label: string;
  quantity: number;
  price_per_unit: number;
  line_total: number;
}

interface Data {
  request_id: string;
  status: string;
  can_raise: boolean;
  lines: Line[];
  invoice_total: number;
  invoice: { id: string; number: string; status: string; raised_at: string } | null;
  returned: { number: string; reason: string | null } | null;
  /** The dealer's own payout, once recorded. Never the vendor's receipt. */
  payment: { amount: number; txn_ref: string | null; txn_date: string } | null;
}

export default function DealerInvoicePane({
  requestId,
  // Standalone (below the page) it wants a top margin; inside the Documents grid
  // the caller passes "" so it aligns with the PO card. Logic is untouched.
  className = "mt-6",
}: {
  requestId: string;
  className?: string;
}) {
  const [d, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [number, setNumber] = useState("");
  const [pdf, setPdf] = useState<{ key: string; name: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/buyback/requests/${requestId}/invoice`);
      const json = await res.json();
      if (cancelled) return;
      setData(json?.data ?? null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [requestId, reloadKey]);

  const submit = async () => {
    setBusy(true);
    setError(null);

    const res = await fetch(`/api/buyback/requests/${requestId}/invoice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        number: number.trim(),
        ...(pdf ? { pdf_s3: pdf.key } : {}),
      }),
    });
    const json = await res.json();
    setBusy(false);

    if (!json?.success) {
      setError(json?.error?.message ?? "Could not raise the invoice.");
      return;
    }
    setNumber("");
    setPdf(null);
    reload();
  };

  if (loading || !d) return null;

  // Nothing to show until the batteries have actually been collected.
  const relevant =
    d.can_raise || d.invoice || d.returned || ["SETTLED", "CLOSED"].includes(d.status);
  if (!relevant) return null;

  return (
    <div className={`rounded-xl border border-slate-200 bg-white p-5 ${className}`}>
      <div className="text-sm font-bold text-slate-900">Your invoice</div>

      {/* The returned reason goes FIRST. A dealer who has to hunt for why their
          invoice came back will guess, and be returned a second time. */}
      {d.returned && d.can_raise && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
          <div className="text-xs font-bold uppercase tracking-wide text-red-700">
            Invoice {d.returned.number} was returned
          </div>
          <p className="mt-1 text-sm text-red-700">{d.returned.reason}</p>
          <p className="mt-1.5 text-xs text-red-600">
            Raise a fresh invoice at the rates below. They are the prices you accepted — we
            check every line against them.
          </p>
        </div>
      )}

      <p className="mt-2 text-xs text-slate-500">
        Pre-filled at the per-battery prices you accepted. You supply your own invoice
        number; we do not issue one on your series.
      </p>

      <div className="mt-3 overflow-hidden rounded-lg border border-slate-200">
        {d.lines.map((l, i) => (
          <div
            key={l.line_id}
            className={`flex items-center justify-between px-3 py-2 text-sm ${
              i ? "border-t border-slate-100" : ""
            }`}
          >
            <span className="font-medium text-slate-700">{l.label}</span>
            <span className="tabular-nums text-slate-600">
              {inr(l.price_per_unit)}/unit
              <b className="ml-3 text-slate-900">{inr(l.line_total)}</b>
            </span>
          </div>
        ))}

        <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-extrabold">
          <span>Invoice total</span>
          <span className="tabular-nums">{inr(d.invoice_total)}</span>
        </div>
      </div>

      <p className="mt-2 text-[11px] text-slate-400">
        Exclusive of GST — the tax treatment is being confirmed and will be reflected before
        payment.
      </p>

      {error && <div className="mt-3 text-xs text-red-600">{error}</div>}

      {d.can_raise ? (
        <div className="mt-4">
          <label className="block text-xs font-semibold text-slate-600">
            Attach invoice PDF (optional)
          </label>
          <div className="mt-1 max-w-xs">
            <EvidenceUpload
              endpoint="/api/buyback/uploads"
              kind="invoice_pdf"
              requestId={requestId}
              label="invoice PDF"
              value={pdf}
              onChange={setPdf}
              disabled={busy}
            />
          </div>

          <div className="mt-3 flex gap-2">
            <input
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder="Your invoice no. (e.g. SHK/2026/41)"
              className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
            <button
              onClick={submit}
              disabled={busy || !number.trim()}
              className="rounded-lg bg-green-600 px-5 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
            >
              {busy ? "Raising…" : "Raise invoice"}
            </button>
          </div>
        </div>
      ) : d.invoice ? (
        <div className="mt-4 flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2.5">
          <span className="text-sm text-slate-600">
            Invoice <b className="text-slate-900">{d.invoice.number}</b>
          </span>
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
              d.invoice.status === "APPROVED"
                ? "bg-emerald-50 text-emerald-700"
                : "bg-blue-50 text-blue-700"
            }`}
          >
            {d.invoice.status === "APPROVED" ? "Approved" : "With iTarang"}
          </span>
        </div>
      ) : null}

      {/* The payment itself, not just "Paid." — the dealer's record of what
          arrived, when, under which bank reference (guide Test 3). */}
      {d.payment && (
        <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm">
          <span className="font-bold text-emerald-800">Paid {inr(d.payment.amount)}</span>
          <span className="ml-2 text-xs text-emerald-700">
            on{" "}
            {new Date(d.payment.txn_date).toLocaleDateString("en-IN", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            })}
            {d.payment.txn_ref ? ` · ref ${d.payment.txn_ref}` : ""}
          </span>
        </div>
      )}
      {d.status === "CLOSED" && (
        <p className="mt-3 text-xs text-slate-500">This deal is closed.</p>
      )}
    </div>
  );
}
