"use client";

/**
 * The Vendor Board (M09/M10/M11 + fulfilment).
 *
 * Self-contained: it fetches its own state and reloads itself, so the admin
 * deal page needs one line to mount it.
 *
 * SECTIONS: the admin detail page splits this board across two tabs, so render
 * is gated by a `section` prop — "routing" (the vendor multi-select + quotation
 * email, mounted under the Margin & Routing tab's PDF preview) and "threads"
 * (thread cards, below-floor banner, POs, pickup — the Vendor Board tab).
 * "all" (the default) renders everything, preserving the original behaviour.
 * ONE component, one fetch, one set of handlers — the sections share every
 * POST; only the rendering is gated.
 *
 * PLACES THIS DELIBERATELY DIVERGES FROM THE DESIGN PROTOTYPE:
 *
 *  1. The prototype's vendor card shows ONE "Ask price" and ONE "Latest
 *     response" per vendor, and its record-response modal takes a single amount.
 *     Every price here is per SKU, and the response modal reuses LineInputTable —
 *     the very same component the dealer negotiation uses (invariant 7). A vendor
 *     who counters on one variant and not another is representable; in the
 *     prototype it is not.
 *
 *  2. The prototype shows a red "below floor" banner and still lets you agree.
 *     Here the Agree button is disabled below the floor and says why — and the
 *     server refuses it anyway (422). The UI is a courtesy, never the gate.
 *
 *  3. The prototype has no disabled/ghosted state anywhere. Actions the state
 *     machine would refuse are rendered disabled with the machine's own reason as
 *     the tooltip, so an admin learns WHY rather than watching a button vanish.
 *
 *  4. The prototype's single "Record response" button is three here — Record
 *     counter / Agree / Lost — because those are three different endpoint
 *     payloads (kind: counter|agree|reject) and collapsing them would bury two
 *     of the three flows inside a modal the admin has no reason to open.
 *
 * MARK COLLECTED (M05 + BWM 2022): completing a pickup asks for the ACTUAL
 * per-line count via a modal — what was physically on the truck — plus the
 * optional e-way bill number. A count below the dealer's declaration raises a
 * variance server-side and BLOCKS the dealer's payout until they acknowledge
 * it on WhatsApp. Posting no counts (the old behaviour) told the server
 * "everything was there", which made the variance flow unreachable from the UI.
 */

import { useCallback, useEffect, useState } from "react";

import BatteryLineLabel from "./BatteryLineLabel";
import LineInputTable, { type EditableLine } from "./LineInputTable";
import { EmptyState, EvidenceUpload } from "./ui";
import { inr } from "@/lib/buyback/format";

interface ThreadLine {
  line_id: string;
  quantity: number;
  condition: "WORKING" | "DEAD";
  voltage: number | string;
  ah: number | string;
  ask_price: string | null;
  counter_price: string | null;
  agreed_price: string | null;
}

interface Thread {
  id: string;
  vendor_id: string;
  vendor_name: string;
  status: "SENT" | "COUNTERED" | "AGREED" | "LOST";
  quotation_no: string | null;
  close_reason: string | null;
  lines: ThreadLine[];
  current_total: number | null;
  below_floor: boolean;
  shortfall: number;
}

interface Vendor {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  payment_terms: string | null;
}

interface Board {
  request_id: string;
  request_no: string;
  status: string;
  floor_total: number;
  allowed_actions: string[];
  threads: Thread[];
  routable_vendors: Vendor[];
  purchase_orders: Array<{ id: string; leg: string; number: string; status: string }>;
  pickup: { id: string; scheduled_at: string | null; completed_at: string | null } | null;
}

const THREAD_CHIP: Record<Thread["status"], [string, string, string]> = {
  SENT: ["Awaiting reply", "bg-blue-50", "text-blue-700"],
  COUNTERED: ["Countered", "bg-amber-50", "text-amber-700"],
  AGREED: ["Agreed", "bg-emerald-50", "text-emerald-700"],
  LOST: ["Lost", "bg-slate-100", "text-slate-500"],
};

export default function VendorBoard({
  requestId,
  section = "all",
  onMutated,
}: {
  requestId: string;
  section?: "routing" | "threads" | "all";
  /**
   * Fired after any action that changes the deal's status, stepper position,
   * offer version, or allowed_actions — routing, agree, PO, pickup, mark
   * collected. The board reloads its OWN state via `reload()` regardless; this
   * is for the PARENT page, whose header/stepper/actions bar otherwise sit
   * stale until the next full navigation.
   */
  onMutated?: () => void;
}) {
  const [board, setBoard] = useState<Board | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [picked, setPicked] = useState<string[]>([]);
  const [respond, setRespond] = useState<{ thread: Thread; kind: "counter" | "agree" } | null>(null);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [vendorPo, setVendorPo] = useState("");
  const [vendorPoPdf, setVendorPoPdf] = useState<{ key: string; name: string } | null>(null);
  const [schedule, setSchedule] = useState("");

  // Mark-collected modal state (M05).
  const [collectOpen, setCollectOpen] = useState(false);
  const [collectCounts, setCollectCounts] = useState<Record<string, string>>({});
  const [ewayBill, setEwayBill] = useState("");
  const [ewayBillProof, setEwayBillProof] = useState<{ key: string; name: string } | null>(null);
  const [weighbridgeProof, setWeighbridgeProof] = useState<{ key: string; name: string } | null>(
    null,
  );
  const [collectNotice, setCollectNotice] = useState<string | null>(null);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/admin/buyback/requests/${requestId}/vendor-board`);
      const json = await res.json();
      if (cancelled) return;
      setBoard(json?.data ?? null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [requestId, reloadKey]);

  const post = async (url: string, body?: unknown) => {
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
      // A 409 is the state machine refusing; a 422 is a business rule (the floor).
      // Either way the server's sentence is better than anything we could invent.
      setError(json?.error?.message ?? "Action failed.");
      return false;
    }
    setRespond(null);
    setPicked([]);
    reload();
    onMutated?.();
    return true;
  };

  if (loading) return <div className="py-6 text-sm text-slate-400">Loading vendor board…</div>;
  if (!board) return null;

  const showRouting = section === "all" || section === "routing";
  const showThreads = section === "all" || section === "threads";

  const can = (a: string) => board.allowed_actions.includes(a);
  const live = board.threads.filter((t) => t.status !== "LOST");
  const best = live.reduce<number | null>(
    (m, t) => (t.current_total === null ? m : Math.max(m ?? 0, t.current_total)),
    null,
  );

  const openRespond = (thread: Thread, kind: "counter" | "agree") => {
    setRespond({ thread, kind });
    setPrices(
      Object.fromEntries(
        thread.lines.map((l) => [
          l.line_id,
          String(Math.round(Number(l.counter_price ?? l.ask_price ?? 0))),
        ]),
      ),
    );
  };

  const toEditable = (lines: ThreadLine[]): EditableLine[] =>
    lines.map((l) => ({
      id: l.line_id,
      quantity: l.quantity,
      condition: l.condition,
      voltage: l.voltage,
      ah: l.ah,
      reference_price: l.ask_price,
    }));

  // ---- Mark collected (M05) ------------------------------------------------
  // The lines to count come from the AGREED thread — the same per-SKU rows the
  // vendor agreed to buy. Every thread on a deal carries the same lines, so any
  // thread would do; the agreed one is simply the honest source.
  const collectLines =
    (board.threads.find((t) => t.status === "AGREED") ?? board.threads[0])?.lines ?? [];

  const collectValid = collectLines.every((l) => {
    // Number("") is 0 — a cleared input must NOT silently read as "0 collected"
    // (that would record a false count variance and hold the dealer's payout).
    // The admin has to type the number, even when it is zero.
    const raw = collectCounts[l.line_id];
    if (raw == null || raw.trim() === "") return false;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 && n <= l.quantity;
  });

  const openCollect = () => {
    setCollectCounts(
      Object.fromEntries(collectLines.map((l) => [l.line_id, String(l.quantity)])),
    );
    setEwayBill("");
    setEwayBillProof(null);
    setWeighbridgeProof(null);
    setError(null);
    setCollectOpen(true);
  };

  const submitCollected = async () => {
    setBusy(true);
    setError(null);

    // The route treats a missing line as zero, so every line is always sent.
    // If (impossibly) no thread lines exist, omit actual_counts entirely — the
    // server then defaults to "everything the dealer declared was there",
    // which beats sending an empty array that would read as "nothing arrived".
    const body: {
      actual_counts?: Array<{ line_id: string; quantity: number }>;
      eway_bill_no?: string;
      eway_bill_s3?: string;
      weighbridge_slip_s3?: string;
    } = {};
    if (collectLines.length > 0) {
      body.actual_counts = collectLines.map((l) => ({
        line_id: l.line_id,
        quantity: Number(collectCounts[l.line_id]),
      }));
    }
    if (ewayBill.trim()) body.eway_bill_no = ewayBill.trim();
    if (ewayBillProof) body.eway_bill_s3 = ewayBillProof.key;
    if (weighbridgeProof) body.weighbridge_slip_s3 = weighbridgeProof.key;

    const res = await fetch(
      `/api/admin/buyback/requests/${board.request_id}/pickup/complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const json = await res.json();
    setBusy(false);

    if (!json?.success) {
      setError(json?.error?.message ?? "Action failed.");
      return;
    }

    setCollectOpen(false);
    // The route tells us the payout is now gated — the admin must know, or they
    // will wonder why the settlement button refuses them ten minutes later.
    if (json?.data?.payout_blocked_pending_dealer_ack) {
      setCollectNotice(json?.data?.variance ?? "Collected count differs from the declaration.");
    }
    reload();
    onMutated?.();
  };

  return (
    <div className={section === "routing" ? "mt-3" : "mt-6 space-y-4"}>
      {showThreads && (
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-bold text-slate-900">Vendor board</h2>
          <span className="text-xs text-slate-500">
            Floor <b className="tabular-nums text-slate-700">{inr(board.floor_total)}</b>
            <span className="ml-1 text-slate-400">· the least we can sell for</span>
          </span>
        </div>
      )}

      {error && !collectOpen && !respond && (
        <div className="my-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* ---------------------------------------------------------- ROUTING */}
      {showRouting && can("route_to_vendors") && (
        <div
          className={
            section === "routing" ? "" : "rounded-xl border border-slate-200 bg-white p-4"
          }
        >
          <div
            className={
              section === "routing"
                ? "text-[12.5px] font-bold text-slate-900"
                : "text-sm font-semibold text-slate-900"
            }
          >
            {section === "routing" ? "Select vendors" : "Route to scrap vendors"}
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Each vendor gets their own itemised quotation by email. The dealer is not named
            in it — iTarang sells as principal.
          </p>

          {board.routable_vendors.length === 0 ? (
            <p className="mt-3 text-xs text-slate-400">
              No onboarded vendors available. Add one under Vendors first.
            </p>
          ) : (
            <>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {board.routable_vendors.map((v) => {
                  const on = picked.includes(v.id);
                  return (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() =>
                        setPicked((p) => (on ? p.filter((x) => x !== v.id) : [...p, v.id]))
                      }
                      className={`rounded-lg border px-[11px] py-[9px] text-left text-xs transition ${
                        on
                          ? "border-green-600 bg-green-50"
                          : "border-gray-200 bg-white hover:border-slate-300"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <b className="text-slate-900">{v.name}</b>
                        {on && <span className="text-green-600">✓</span>}
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-500">
                        {[v.city, v.payment_terms].filter(Boolean).join(" · ") || "—"}
                      </div>
                    </button>
                  );
                })}
              </div>

              <button
                disabled={busy || picked.length === 0}
                onClick={() =>
                  post(`/api/admin/buyback/requests/${board.request_id}/routing`, {
                    vendor_ids: picked,
                  })
                }
                className="mt-3 w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
              >
                {busy
                  ? "Sending…"
                  : picked.length === 0
                    ? "Select vendors to email"
                    : `Send via Email → create threads (${picked.length})`}
              </button>
            </>
          )}
        </div>
      )}

      {/* ---------------------------------------------------------- THREADS */}
      {showThreads &&
        (board.threads.length === 0 ? (
          section === "threads" ? (
            <div className="mt-3">
              <EmptyState
                icon="📧"
                title="No vendor threads yet"
                body="Route the deal from Margin & Routing to email vendors."
              />
            </div>
          ) : (
            !can("route_to_vendors") && (
              <div className="rounded-xl border border-dashed border-slate-200 py-10 text-center text-sm text-slate-400">
                No vendor threads yet.
              </div>
            )
          )
        ) : (
          <div className="mt-3 grid gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
            {board.threads.map((t) => {
              const [label, bg, fg] = THREAD_CHIP[t.status];
              const open = t.status === "SENT" || t.status === "COUNTERED";

              return (
                <div
                  key={t.id}
                  className={`rounded-[10px] border bg-white p-[15px] shadow-[0_1px_2px_rgba(15,23,42,.04)] ${
                    t.status === "AGREED" ? "border-emerald-300" : "border-gray-200"
                  } ${t.status === "LOST" ? "opacity-60" : ""}`}
                >
                  <div className="flex items-center justify-between">
                    <div className="text-[13.5px] font-bold text-slate-900">{t.vendor_name}</div>
                    <span
                      className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase ${bg} ${fg}`}
                    >
                      {label}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-400">{t.quotation_no}</div>

                  {/* Per SKU, always. The prototype collapses this to one number. */}
                  <div className="mt-3 space-y-1.5">
                    {t.lines.map((l) => (
                      <div key={l.line_id} className="flex items-center justify-between text-xs">
                        <BatteryLineLabel
                          line={{
                            id: l.line_id,
                            quantity: l.quantity,
                            condition: l.condition,
                            voltage: l.voltage,
                            ah: l.ah,
                          }}
                        />
                        <span className="tabular-nums text-slate-700">
                          {l.agreed_price ? (
                            <b className="text-emerald-700">{inr(l.agreed_price)}</b>
                          ) : l.counter_price ? (
                            <>
                              <span className="text-slate-300 line-through">
                                {inr(l.ask_price)}
                              </span>{" "}
                              <b>{inr(l.counter_price)}</b>
                            </>
                          ) : (
                            <span className="text-slate-400">{inr(l.ask_price)}</span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>

                  <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-2 text-xs">
                    {/* Before they reply, the number on the card is OUR ask —
                        calling it "their total" claims a response that never
                        arrived. */}
                    <span className="text-slate-500">
                      {t.status === "SENT" ? "Our ask" : "Their total"}
                    </span>
                    <b className="tabular-nums text-slate-900">{inr(t.current_total)}</b>
                  </div>

                  {t.below_floor && open && (
                    <div className="mt-2 rounded-lg bg-red-50 px-2.5 py-2 text-[11px] text-red-700">
                      {inr(t.shortfall)} below the floor. Agreeing would sell the lot for less
                      than we owe the dealer plus margin.
                    </div>
                  )}

                  {t.status === "LOST" && t.close_reason && (
                    <div className="mt-2 text-[11px] text-slate-400">{t.close_reason}</div>
                  )}

                  {open && can("record_vendor_counter") && (
                    <div className="mt-3 flex gap-2">
                      <button
                        onClick={() => openRespond(t, "counter")}
                        disabled={busy}
                        className="flex-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                      >
                        Record counter
                      </button>
                      <button
                        onClick={() => openRespond(t, "agree")}
                        disabled={busy || t.below_floor}
                        title={
                          t.below_floor
                            ? `Blocked: ${inr(t.shortfall)} below the floor. Push the vendor, or reopen the dealer leg.`
                            : undefined
                        }
                        className="flex-1 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
                      >
                        Agree
                      </button>
                      <button
                        onClick={() =>
                          post(`/api/admin/buyback/threads/${t.id}/record`, { kind: "reject" })
                        }
                        disabled={busy}
                        className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-400 hover:bg-slate-50"
                      >
                        Lost
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}

      {/* Best bid below the floor → the only way out is to reopen the dealer leg
          (proto 944). */}
      {showThreads &&
        live.length > 0 &&
        best !== null &&
        best < board.floor_total &&
        can("reopen") && (
          <div className="mt-3.5 flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-red-200 bg-red-50 px-3.5 py-3">
            <div className="text-[12.5px] text-red-700">
              Best vendor bid {inr(best)} is below floor {inr(board.floor_total)}. No vendor
              can be agreed to at this price.
            </div>
            <button
              onClick={() =>
                post(`/api/admin/buyback/requests/${board.request_id}/reopen`, {
                  reason: "best vendor bid below floor",
                })
              }
              disabled={busy}
              className="shrink-0 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700"
            >
              Reopen dealer leg
            </button>
          </div>
        )}

      {/* -------------------------------------------------------------- POs */}
      {showThreads && (can("exchange_pos") || board.purchase_orders.length > 0) && (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-sm font-semibold text-slate-900">Purchase orders</div>
          <p className="mt-1 text-xs text-slate-500">
            Each buyer raises their own: iTarang issues one to the dealer, the vendor issues
            one to iTarang. The deal moves on once both exist.
          </p>

          <div className="mt-3 space-y-2">
            {(["DEALER", "VENDOR"] as const).map((leg) => {
              const po = board.purchase_orders.find((p) => p.leg === leg);
              const title =
                leg === "DEALER" ? "iTarang → dealer (we buy)" : "Vendor → iTarang (they buy)";

              return (
                <div
                  key={leg}
                  className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2"
                >
                  <div>
                    <div className="text-xs font-semibold text-slate-800">{title}</div>
                    <div className="text-[11px] text-slate-400">
                      {po ? `${po.number} · ${po.status}` : "Not raised"}
                    </div>
                  </div>

                  {!po && can("exchange_pos") && leg === "DEALER" && (
                    <button
                      onClick={() =>
                        post(`/api/admin/buyback/requests/${board.request_id}/po/dealer`)
                      }
                      disabled={busy}
                      className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
                    >
                      Generate
                    </button>
                  )}

                  {!po && can("exchange_pos") && leg === "VENDOR" && (
                    <div className="flex flex-col items-end gap-1.5">
                      <div className="flex gap-1.5">
                        <input
                          value={vendorPo}
                          onChange={(e) => setVendorPo(e.target.value)}
                          placeholder="Their PO no."
                          className="w-28 rounded-lg border border-slate-200 px-2 py-1 text-xs"
                        />
                        <button
                          onClick={() =>
                            post(`/api/admin/buyback/requests/${board.request_id}/po/vendor`, {
                              number: vendorPo,
                              ...(vendorPoPdf ? { pdf_s3: vendorPoPdf.key } : {}),
                            })
                          }
                          disabled={busy || !vendorPo.trim()}
                          className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400"
                        >
                          Record
                        </button>
                      </div>
                      <div className="w-44">
                        <EvidenceUpload
                          endpoint="/api/admin/buyback/uploads"
                          kind="vendor_po"
                          requestId={board.request_id}
                          label="their PO PDF"
                          value={vendorPoPdf}
                          onChange={setVendorPoPdf}
                          disabled={busy}
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------- PICKUP */}
      {showThreads && (can("schedule_pickup") || can("complete_pickup") || board.pickup) && (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-sm font-semibold text-slate-900">Collection</div>

          {can("schedule_pickup") && (
            <div className="mt-3 flex gap-2">
              <input
                type="datetime-local"
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
                className="flex-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs"
              />
              <button
                onClick={() =>
                  post(`/api/admin/buyback/requests/${board.request_id}/pickup`, {
                    scheduled_at: new Date(schedule).toISOString(),
                  })
                }
                disabled={busy || !schedule}
                className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400"
              >
                Schedule
              </button>
            </div>
          )}

          {board.pickup && (
            <div className="mt-3 flex items-center justify-between text-xs">
              <span className="text-slate-500">
                {board.pickup.completed_at
                  ? `Collected ${new Date(board.pickup.completed_at).toLocaleString("en-IN")}`
                  : board.pickup.scheduled_at
                    ? `Scheduled ${new Date(board.pickup.scheduled_at).toLocaleString("en-IN")}`
                    : "Scheduled"}
              </span>

              {can("complete_pickup") && (
                <button
                  onClick={openCollect}
                  disabled={busy}
                  className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-700"
                >
                  Mark collected
                </button>
              )}
            </div>
          )}

          {collectNotice && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800">
              <b>Count variance recorded — the dealer&apos;s payout is on hold.</b>{" "}
              {collectNotice} The dealer has been notified on WhatsApp and must acknowledge
              the collected count before their settlement can be recorded.
            </div>
          )}

          {board.status === "PICKED_UP" && (
            <p className="mt-2 text-[11px] text-slate-400">
              The batteries are ours. The dealer can now raise their invoice — approval and
              settlement continue in the Money section of the Overview tab.
            </p>
          )}
        </div>
      )}

      {/* --------------------------------------------------- RESPONSE MODAL */}
      {respond && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl">
            <div className="text-sm font-bold text-slate-900">
              {respond.kind === "agree" ? "Agree with" : "Record counter from"}{" "}
              {respond.thread.vendor_name}
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Per battery variant. A single figure for the whole lot cannot be recorded —
              each variant settles separately.
            </p>

            <div className="mt-4">
              <LineInputTable
                lines={toEditable(respond.thread.lines)}
                values={prices}
                onChange={(id, v) => setPrices((p) => ({ ...p, [id]: v }))}
                referenceLabel="our ask"
                disabled={busy}
              />
            </div>

            {error && <div className="mt-3 text-xs text-red-600">{error}</div>}

            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => {
                  setRespond(null);
                  setError(null);
                }}
                className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600"
              >
                Cancel
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  post(`/api/admin/buyback/threads/${respond.thread.id}/record`, {
                    kind: respond.kind,
                    lines: respond.thread.lines.map((l) => ({
                      line_id: l.line_id,
                      price: Number(prices[l.line_id]),
                    })),
                  })
                }
                className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:bg-slate-200"
              >
                {busy
                  ? "Saving…"
                  : respond.kind === "agree"
                    ? "Agree — closes other vendors"
                    : "Record counter"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --------------------------------------------- MARK-COLLECTED MODAL */}
      {collectOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4"
          onClick={() => {
            setCollectOpen(false);
            setError(null);
          }}
        >
          <div
            className="w-full max-w-[480px] rounded-2xl bg-white p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold text-slate-900">
              Mark collected · {board.request_no}
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              Count what is actually on the truck, per battery line. A count below the
              dealer&apos;s declaration records a variance and holds their payout until they
              acknowledge it.
            </p>

            <div className="mt-4 space-y-2.5">
              {collectLines.map((l) => (
                <div key={l.line_id} className="flex items-center justify-between gap-3">
                  <div>
                    <BatteryLineLabel
                      line={{
                        id: l.line_id,
                        quantity: l.quantity,
                        condition: l.condition,
                        voltage: l.voltage,
                        ah: l.ah,
                      }}
                      showCount={false}
                    />
                    <div className="mt-0.5 text-[11px] text-slate-400">
                      declared {l.quantity}
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-[11px] text-slate-500">
                    actually collected
                    <input
                      type="number"
                      min={0}
                      max={l.quantity}
                      value={collectCounts[l.line_id] ?? ""}
                      onChange={(e) =>
                        setCollectCounts((c) => ({ ...c, [l.line_id]: e.target.value }))
                      }
                      className="w-20 rounded-lg border border-slate-200 px-2.5 py-1.5 text-right text-sm tabular-nums"
                    />
                  </label>
                </div>
              ))}

              {collectLines.length === 0 && (
                <p className="text-xs text-slate-400">
                  No per-line counts available on this deal — completing will record the full
                  declared count as collected.
                </p>
              )}
            </div>

            {!collectValid && (
              <p className="mt-2 text-xs text-amber-700">
                Each count must be a whole number between 0 and the declared quantity —
                collecting more than the dealer declared is not a thing this flow records.
              </p>
            )}

            <label className="mt-4 block text-xs font-bold uppercase text-slate-500">
              E-way bill no. (optional)
            </label>
            <input
              value={ewayBill}
              onChange={(e) => setEwayBill(e.target.value)}
              placeholder="BWM 2022 chain of custody"
              className="mt-1 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
            />

            {/* Also optional — BWM 2022 evidence, not a submit gate. Neither field
                blocks "Mark collected"; either can be attached later from the
                Documents tab if it isn't in hand at pickup. */}
            <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-bold uppercase text-slate-500">
                  E-way bill scan (optional)
                </label>
                <div className="mt-1">
                  <EvidenceUpload
                    endpoint="/api/admin/buyback/uploads"
                    kind="eway_bill"
                    requestId={board.request_id}
                    label="e-way bill scan"
                    value={ewayBillProof}
                    onChange={setEwayBillProof}
                    disabled={busy}
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-bold uppercase text-slate-500">
                  Weighbridge slip (optional)
                </label>
                <div className="mt-1">
                  <EvidenceUpload
                    endpoint="/api/admin/buyback/uploads"
                    kind="weighbridge_slip"
                    requestId={board.request_id}
                    label="weighbridge slip"
                    value={weighbridgeProof}
                    onChange={setWeighbridgeProof}
                    disabled={busy}
                  />
                </div>
              </div>
            </div>

            {error && <div className="mt-3 text-xs text-red-600">{error}</div>}

            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => {
                  setCollectOpen(false);
                  setError(null);
                }}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-semibold"
              >
                Cancel
              </button>
              <button
                disabled={busy || !collectValid}
                onClick={() => void submitCollected()}
                className="rounded-lg bg-green-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
              >
                {busy ? "Recording…" : "Mark collected"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
