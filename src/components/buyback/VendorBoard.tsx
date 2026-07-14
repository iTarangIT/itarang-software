"use client";

/**
 * The Vendor Board (M09/M10/M11 + fulfilment).
 *
 * Self-contained: it fetches its own state and reloads itself, so the 750-line
 * admin deal page needs one line to mount it.
 *
 * THREE PLACES THIS DELIBERATELY DIVERGES FROM THE DESIGN PROTOTYPE:
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
 */

import { useCallback, useEffect, useState } from "react";

import BatteryLineLabel from "./BatteryLineLabel";
import LineInputTable, { type EditableLine } from "./LineInputTable";
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

export default function VendorBoard({ requestId }: { requestId: string }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [picked, setPicked] = useState<string[]>([]);
  const [respond, setRespond] = useState<{ thread: Thread; kind: "counter" | "agree" } | null>(null);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [vendorPo, setVendorPo] = useState("");
  const [schedule, setSchedule] = useState("");

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
    return true;
  };

  if (loading) return <div className="py-8 text-sm text-slate-400">Loading vendor board…</div>;
  if (!board) return null;

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

  return (
    <div className="mt-6 space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-bold text-slate-900">Vendor board</h2>
        <span className="text-xs text-slate-500">
          Floor <b className="tabular-nums text-slate-700">{inr(board.floor_total)}</b>
          <span className="ml-1 text-slate-400">· the least we can sell for</span>
        </span>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* ---------------------------------------------------------- ROUTING */}
      {can("route_to_vendors") && (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-sm font-semibold text-slate-900">Route to scrap vendors</div>
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
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {board.routable_vendors.map((v) => {
                  const on = picked.includes(v.id);
                  return (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() =>
                        setPicked((p) => (on ? p.filter((x) => x !== v.id) : [...p, v.id]))
                      }
                      className={`rounded-lg border px-3 py-2 text-left transition ${
                        on
                          ? "border-slate-900 bg-slate-900 text-white"
                          : "border-slate-200 bg-white hover:border-slate-300"
                      }`}
                    >
                      <div className="text-sm font-semibold">{v.name}</div>
                      <div
                        className={`text-xs ${on ? "text-slate-300" : "text-slate-500"}`}
                      >
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
                    : `Email quotation to ${picked.length} vendor${picked.length === 1 ? "" : "s"}`}
              </button>
            </>
          )}
        </div>
      )}

      {/* ---------------------------------------------------------- THREADS */}
      {board.threads.length === 0 ? (
        !can("route_to_vendors") && (
          <div className="rounded-xl border border-dashed border-slate-200 py-10 text-center text-sm text-slate-400">
            No vendor threads yet.
          </div>
        )
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {board.threads.map((t) => {
            const [label, bg, fg] = THREAD_CHIP[t.status];
            const open = t.status === "SENT" || t.status === "COUNTERED";

            return (
              <div
                key={t.id}
                className={`rounded-xl border bg-white p-4 ${
                  t.status === "AGREED" ? "border-emerald-300" : "border-slate-200"
                } ${t.status === "LOST" ? "opacity-60" : ""}`}
              >
                <div className="flex items-center justify-between">
                  <div className="text-sm font-bold text-slate-900">{t.vendor_name}</div>
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
                      className="flex-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
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
      )}

      {/* Best bid below the floor → the only way out is to reopen the dealer leg. */}
      {live.length > 0 && best !== null && best < board.floor_total && can("reopen") && (
        <div className="flex items-center justify-between rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <div className="text-xs text-red-700">
            The best bid, {inr(best)}, is below the floor of {inr(board.floor_total)}. No
            vendor can be agreed to at this price.
          </div>
          <button
            onClick={() =>
              post(`/api/admin/buyback/requests/${board.request_id}/reopen`, {
                reason: "best vendor bid below floor",
              })
            }
            disabled={busy}
            className="ml-4 shrink-0 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700"
          >
            Reopen dealer leg
          </button>
        </div>
      )}

      {/* -------------------------------------------------------------- POs */}
      {(can("exchange_pos") || board.purchase_orders.length > 0) && (
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
                          })
                        }
                        disabled={busy || !vendorPo.trim()}
                        className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400"
                      >
                        Record
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------- PICKUP */}
      {(can("schedule_pickup") || can("complete_pickup") || board.pickup) && (
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
                  onClick={() =>
                    post(`/api/admin/buyback/requests/${board.request_id}/pickup/complete`)
                  }
                  disabled={busy}
                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                >
                  Mark collected
                </button>
              )}
            </div>
          )}

          {board.status === "PICKED_UP" && (
            <p className="mt-2 text-[11px] text-slate-400">
              The batteries are ours. The dealer can now raise their invoice — approval and
              settlement continue in the Money section below.
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
    </div>
  );
}
