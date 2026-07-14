"use client";

/**
 * The dealer's view of one request.
 *
 * Three things the prototype got wrong and this does not:
 *
 *  · The INFO_REQUESTED banner names the EXACT units the admin asked about
 *    ("60V 120Ah · Working — Unit 2"), not the whole request (BRD M06 AC).
 *  · The final offer is itemized per SKU with ONE overall Accept/Decline (U5).
 *  · The dealer's counter is itemized per SKU too — there is no lump-sum box.
 *
 * Every number on this page arrives already redacted: the API builds the dealer
 * payload field-by-field, so margin and vendor data are not in the response at
 * all.
 */

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import BatteryLineLabel from "@/components/buyback/BatteryLineLabel";
import DealerInvoicePane from "@/components/buyback/DealerInvoicePane";
import LineInputTable from "@/components/buyback/LineInputTable";
import StatusChip, { OfferVersionChip } from "@/components/buyback/StatusChip";
import VarianceBanner from "@/components/buyback/VarianceBanner";
import { inr, perUnitShort } from "@/lib/buyback/format";

interface DealerLine {
  id: string;
  variant_type: string;
  spec_label: string;
  condition: string;
  condition_key: "WORKING" | "DEAD";
  voltage: string;
  ah: string;
  quantity: number;
  measured_voltage: string | null;
  expected_price_per_unit: string | null;
  photo_count: number;
  dealer_price: string | null;
  line_total: number | null;
}

interface OfferLine {
  line_id: string;
  label: string;
  quantity: number;
  price_per_unit: number;
  line_total: number;
}

interface Detail {
  request_id: string;
  request_no: string;
  status: string;
  offer_version: number;
  lines: DealerLine[];
  dealer_quote_total: number | null;
  info_request: {
    id: string;
    note: string | null;
    checklist: string[];
    target_units: Array<{ unit_id: string; label: string }>;
  } | null;
  final_offer: {
    id: string;
    version_no: number;
    status: string;
    lines: OfferLine[];
    total: number;
  } | null;
  /** Already redacted server-side — margin/vendor events are never sent. */
  activity: Array<{ action: string; role: string; created_at: string }>;
}

/**
 * The dealer's activity log speaks the dealer's language, not the state
 * machine's. Actions arrive pre-filtered (visibleActivityForDealer) so simply
 * rendering what is here cannot leak margin or vendor events.
 */
const ACTIVITY_LABELS: Record<string, string> = {
  submit: "Request submitted",
  start_review: "Review started by iTarang",
  accept: "Request accepted",
  reject: "Request rejected",
  negotiate: "iTarang sent a counter offer",
  dealer_counter: "You sent a counter offer",
  request_info: "iTarang asked for more information",
  resubmit: "You resubmitted with the requested information",
  send_final_offer: "Final offer sent to you",
  dealer_accept: "You accepted the final offer",
  dealer_decline: "You declined the final offer",
  reopen: "Negotiation reopened by iTarang",
  issue_dealer_po: "Purchase order issued to you",
  exchange_pos: "Purchase orders exchanged",
  schedule_pickup: "Collection scheduled",
  complete_pickup: "Batteries collected",
  variance_ack: "You confirmed the collected count",
  raise_invoice: "You raised your invoice",
  approve_invoice: "Your invoice was approved",
  return_invoice: "Your invoice was returned",
  record_settlement: "Payment recorded",
  settle: "Deal settled",
  close_deal: "Deal closed",
};

function activityLabel(action: string): string {
  return ACTIVITY_LABELS[action] ?? action.replace(/_/g, " ");
}

export default function DealerRequestDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [counter, setCounter] = useState<Record<string, string>>({});
  const [showCounter, setShowCounter] = useState(false);

  // Bumping this re-runs the effect. The fetch lives INSIDE the effect so every
  // setState happens after an await, never synchronously in the effect body.
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const res = await fetch(`/api/buyback/requests/${id}`);
      if (cancelled) return;

      if (res.status === 404) {
        // Another dealer's request is indistinguishable from one that does not
        // exist — the API refuses to confirm it is even there.
        router.replace("/dealer-portal/buyback");
        return;
      }

      const json = await res.json();
      if (cancelled) return;
      setDetail(json?.data ?? null);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [id, router, reloadKey]);

  const act = async (url: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    setBusy(false);

    if (!json?.success) {
      setError(json?.error?.message ?? "Something went wrong.");
      return;
    }
    setShowCounter(false);
    reload();
  };

  if (loading) return <div className="p-10 text-slate-400">Loading…</div>;
  if (!detail) return null;

  const offer = detail.final_offer;
  const canRespond = detail.status === "FINAL_OFFER_SENT" && offer?.status === "SENT";
  const canCounter = detail.status === "NEGOTIATING";

  return (
    <div className="mx-auto max-w-4xl px-6 pb-24 pt-6">
      <button
        onClick={() => router.push("/dealer-portal/buyback")}
        className="mb-4 text-sm text-slate-500 hover:underline"
      >
        ← Back to requests
      </button>

      <header className="mb-6 flex items-center gap-3">
        <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">
          {detail.request_no}
        </h1>
        <StatusChip status={detail.status} />
        <OfferVersionChip version={detail.offer_version} />
      </header>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* INFO REQUESTED — names the exact batteries, not "your request". */}
      {detail.info_request && (
        <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-[13.5px] font-bold text-amber-900">
            ⚠ Information requested by iTarang
          </p>

          {detail.info_request.target_units.length > 0 && (
            <p className="mt-2 text-sm text-amber-900">
              <span className="font-bold">For these batteries: </span>
              {detail.info_request.target_units.map((u) => u.label).join(" · ")}
            </p>
          )}

          <p className="mt-2 text-sm font-semibold text-amber-900">Please provide:</p>
          <ul className="mt-1 list-inside list-disc text-sm text-amber-900">
            {detail.info_request.checklist.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>

          {detail.info_request.note && (
            <p className="mt-2 text-sm italic text-amber-800">&ldquo;{detail.info_request.note}&rdquo;</p>
          )}

          <button
            disabled={busy}
            onClick={() => void act(`/api/buyback/requests/${id}/resubmit`)}
            className="mt-3 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            Resubmit
          </button>
        </div>
      )}

      {/* Battery lines */}
      <div className="mb-6 rounded-xl border border-slate-200 bg-white">
        <h2 className="border-b border-slate-100 px-4 py-3 text-sm font-bold text-slate-900">
          Battery lines
        </h2>

        {detail.lines.map((line) => (
          <div key={line.id} className="flex items-center justify-between border-b border-slate-50 px-4 py-3 last:border-0">
            <div>
              <BatteryLineLabel
                line={{
                  id: line.id,
                  quantity: line.quantity,
                  condition: line.condition_key,
                  voltage: line.voltage,
                  ah: line.ah,
                }}
              />
              <div className="mt-1 text-xs text-slate-500">
                {line.photo_count} photos · expected {perUnitShort(line.expected_price_per_unit)}
                {line.dealer_price && (
                  <span className="ml-1 font-bold text-emerald-700">
                    · agreed {perUnitShort(line.dealer_price)}
                  </span>
                )}
              </div>
            </div>
            <div className="tabular-nums font-bold text-slate-900">{inr(line.line_total)}</div>
          </div>
        ))}

        <div className="flex items-center justify-between bg-slate-50 px-4 py-3 text-sm font-bold">
          <span>Total</span>
          <span className="tabular-nums">{inr(detail.dealer_quote_total)}</span>
        </div>
      </div>

      {/* Dealer counter — itemized per SKU, never a lump sum. */}
      {canCounter && (
        <div className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
          {!showCounter ? (
            <button
              onClick={() => {
                setCounter(
                  Object.fromEntries(
                    detail.lines.map((l) => [
                      l.id,
                      String(Math.round(Number(l.expected_price_per_unit ?? 0))),
                    ]),
                  ),
                );
                setShowCounter(true);
              }}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-semibold hover:bg-slate-50"
            >
              Send a counter offer
            </button>
          ) : (
            <>
              <h3 className="mb-2 text-sm font-bold text-slate-900">
                Your counter — price each battery type
              </h3>
              <LineInputTable
                lines={detail.lines.map((l) => ({
                  id: l.id,
                  quantity: l.quantity,
                  condition: l.condition_key,
                  voltage: l.voltage,
                  ah: l.ah,
                }))}
                values={counter}
                onChange={(lineId, v) => setCounter((c) => ({ ...c, [lineId]: v }))}
              />
              <div className="mt-3 flex justify-end gap-2">
                <button
                  onClick={() => setShowCounter(false)}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-semibold"
                >
                  Cancel
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(`/api/buyback/requests/${id}/counter`, {
                      lines: detail.lines.map((l) => ({
                        line_id: l.id,
                        price_per_unit: Number(counter[l.id] || 0),
                      })),
                    })
                  }
                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
                >
                  Send counter
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* FINAL OFFER — itemized, ONE binary answer for the whole set (U5).
          In the page flow, not a fixed overlay: the floating version parked
          itself bottom-right under the WhatsApp button, which covered the
          Decline button. This is the primary decision on the page — it gets
          the page, not a corner. */}
      {canRespond && offer && (
        <div className="mb-6 rounded-xl border-2 border-amber-300 bg-white p-4 shadow-sm">
          <p className="text-[11px] font-bold uppercase tracking-wide text-amber-700">
            Final offer · v{offer.version_no} · Itemized
          </p>

          <div className="my-3 space-y-1.5">
            {offer.lines.map((l) => (
              <div key={l.line_id} className="flex justify-between text-sm">
                <span className="text-slate-600">{l.label}</span>
                <span className="font-bold tabular-nums">{perUnitShort(l.price_per_unit)}</span>
              </div>
            ))}
            <div className="flex justify-between border-t border-slate-100 pt-1.5 text-sm font-bold">
              <span>Total</span>
              <span className="tabular-nums">{inr(offer.total)}</span>
            </div>
          </div>

          <p className="mb-3 text-xs text-slate-500">
            Accept the full set to proceed, or decline to reopen negotiation.
          </p>

          <div className="flex gap-2">
            <button
              disabled={busy}
              onClick={() =>
                void act(`/api/buyback/final-offers/${offer.id}/respond`, { response: "ACCEPT" })
              }
              className="flex-1 rounded-lg bg-emerald-600 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              Accept (YES)
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void act(`/api/buyback/final-offers/${offer.id}/respond`, { response: "DECLINE" })
              }
              className="flex-1 rounded-lg border border-red-300 py-2 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              Decline (NO)
            </button>
          </div>
        </div>
      )}

      {/* ---- The count variance (M05). ABOVE the invoice, deliberately: if we
             collected fewer batteries than the dealer declared, their payment is
             held, and they must be told WHY before they are asked to invoice us.
             This is the only control that releases that hold. ---- */}
      <VarianceBanner requestId={detail.request_id} />

      {/* ---- The dealer's invoice (M12, Sprint 2B). Renders itself only once the
             batteries have been collected. Prefilled at the prices they accepted;
             they supply their own invoice number, on their own GST series. ---- */}
      <DealerInvoicePane requestId={detail.request_id} />

      {/* ---- Activity — the dealer's own trail (TESTING_GUIDE Test 3): what
             they submitted, what was accepted, invoiced, collected, paid.
             The API drops margin/vendor events before they leave the server. */}
      {detail.activity?.length > 0 && (
        <div className="mt-6 rounded-xl border border-slate-200 bg-white">
          <h2 className="border-b border-slate-100 px-4 py-3 text-sm font-bold text-slate-900">
            Activity
          </h2>
          <ul className="divide-y divide-slate-50">
            {detail.activity.map((a, i) => (
              <li key={i} className="flex items-center justify-between px-4 py-2.5 text-sm">
                <span className="text-slate-700">{activityLabel(a.action)}</span>
                <span className="text-xs tabular-nums text-slate-400">
                  {new Date(a.created_at).toLocaleString("en-IN", {
                    day: "2-digit",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
