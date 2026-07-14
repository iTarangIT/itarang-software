"use client";

/**
 * M06/M07/M08 — the admin's request detail.
 *
 * The four review actions are GHOSTED with a tooltip once the deal leaves the
 * review window. The prototype simply hid the whole action bar and had no
 * disabled state anywhere; the BRD asks for "ghosted+tooltip after", so the copy
 * here comes from the state machine itself — `blocked_reason` is the same string
 * the API would return in its 409. The screen literally cannot claim an action is
 * available when the server would refuse it.
 */

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import BatteryLineLabel from "@/components/buyback/BatteryLineLabel";
import LineInputTable from "@/components/buyback/LineInputTable";
import EvidenceReview from "@/components/buyback/EvidenceReview";
import MoneyBoard from "@/components/buyback/MoneyBoard";
import StatusChip, { OfferVersionChip } from "@/components/buyback/StatusChip";
import VendorBoard from "@/components/buyback/VendorBoard";
import { formatBatteryLine, inr, perUnitShort } from "@/lib/buyback/format";

type Modal = "reject" | "negotiate" | "reqinfo" | "final" | null;

interface Line {
  id: string;
  variant_type: string;
  voltage: string;
  ah: string;
  quantity: number;
  condition: "WORKING" | "DEAD";
  measured_voltage: string | null;
  expected_price_per_unit: string | null;
  photo_count: number;
  dealer_price: string | null;
  margin_value: string | null;
  vendor_ask: string | null;
  units: Array<{ id: string; unit_no: number }>;
}

interface Round {
  id: string;
  round_no: number;
  offered_by_role: string;
  note: string | null;
  created_at: string;
  lines: Array<{ line_id: string; label: string; quantity: number; price_per_unit: number }>;
  total: number;
}

interface ReviewAction {
  action: string;
  enabled: boolean;
  blocked_reason: string | null;
}

interface Detail {
  request_id: string;
  request_no: string;
  status: string;
  offer_version: number;
  dealer_name: string | null;
  dealer_city: string | null;
  floor_total: string | null;
  lines: Line[];
  negotiation: Round[];
  activity: Array<{ id: string; action: string; role: string; created_at: string }>;
  allowed_actions: string[];
  review_actions: ReviewAction[];
}

const CHECKLIST = [
  "RC / vehicle document",
  "Minimum 5 photos per battery",
  "ID proof (PAN / DL)",
  "Purchase proof",
];

export default function AdminBuybackDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [d, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);

  const [prices, setPrices] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [targetUnits, setTargetUnits] = useState<string[]>([]);
  const [checklist, setChecklist] = useState<string[]>([CHECKLIST[0], CHECKLIST[1]]);

  const [marginMode, setMarginMode] = useState<"FLAT" | "PCT">("FLAT");
  const [marginValue, setMarginValue] = useState("1300");

  // Bumping this re-runs the effect. The fetch lives INSIDE the effect so every
  // setState happens after an await, never synchronously in the effect body.
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const res = await fetch(`/api/admin/buyback/requests/${id}`);
      const json = await res.json();
      if (cancelled) return;
      setDetail(json?.data ?? null);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [id, reloadKey]);

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
      // A 409 here is the state machine refusing — surface its reason verbatim.
      setError(json?.error?.message ?? "Action failed.");
      return;
    }
    setModal(null);
    setNote("");
    setReason("");
    reload();
  };

  const seedPrices = () => {
    if (!d) return;
    setPrices(
      Object.fromEntries(
        d.lines.map((l) => [
          l.id,
          String(Math.round(Number(l.dealer_price ?? l.expected_price_per_unit ?? 0))),
        ]),
      ),
    );
  };

  if (loading) return <div className="p-10 text-slate-400">Loading…</div>;
  if (!d) return <div className="p-10 text-slate-400">Request not found.</div>;

  const actionOf = (a: string) => d.review_actions.find((r) => r.action === a);
  const can = (a: string) => d.allowed_actions.includes(a);

  const marginPreview = d.lines.map((l) => {
    const dealer = Number(l.dealer_price ?? 0);
    const m =
      marginMode === "FLAT"
        ? Math.round(Number(marginValue) || 0)
        : Math.round((dealer * (Number(marginValue) || 0)) / 100);
    return { line: l, dealer, margin: m, ask: dealer + m };
  });
  const askTotal = marginPreview.reduce((s, r) => s + r.ask * r.line.quantity, 0);
  const dealerTotal = marginPreview.reduce((s, r) => s + r.dealer * r.line.quantity, 0);

  return (
    <div className="mx-auto max-w-5xl px-6 pb-24 pt-6">
      <button
        onClick={() => router.push("/admin/buyback")}
        className="mb-4 text-sm text-slate-500 hover:underline"
      >
        ← Review Queue
      </button>

      <header className="mb-5 flex items-center gap-3">
        <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">{d.request_no}</h1>
        <StatusChip status={d.status} />
        <OfferVersionChip version={d.offer_version} />
        <span className="text-sm text-slate-500">
          {d.dealer_name} · {d.dealer_city ?? "—"}
        </span>
      </header>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* ---- The four review actions, ghosted with a tooltip when refused ---- */}
      <div className="mb-6 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3.5">
        <span className="mr-1 text-xs font-bold uppercase tracking-wide text-slate-400">
          Actions
        </span>

        <ActionButton
          label="Accept"
          tone="green"
          state={actionOf("accept")}
          busy={busy}
          onClick={() => void post(`/api/admin/buyback/requests/${id}/decision`, { action: "accept" })}
        />
        <ActionButton
          label="Reject"
          tone="danger"
          state={actionOf("reject")}
          busy={busy}
          onClick={() => setModal("reject")}
        />
        <ActionButton
          label="Negotiate"
          tone="amber"
          state={actionOf("negotiate")}
          busy={busy}
          onClick={() => {
            seedPrices();
            setModal("negotiate");
          }}
        />
        <ActionButton
          label="Request Info"
          tone="ghost"
          state={actionOf("request_info")}
          busy={busy}
          onClick={() => {
            setTargetUnits([]);
            setModal("reqinfo");
          }}
        />

        <div className="flex-1" />

        {can("start_review") && (
          <button
            disabled={busy}
            onClick={() =>
              void post(`/api/admin/buyback/requests/${id}/decision`, { action: "start_review" })
            }
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold hover:bg-slate-50"
          >
            Start review
          </button>
        )}

        {can("send_final_offer") && (
          <button
            disabled={busy}
            onClick={() => {
              seedPrices();
              setModal("final");
            }}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            Send Final Offer
          </button>
        )}
      </div>

      {/* Reopen — provisional acceptance, only before the vendor agrees. */}
      {can("reopen") && (
        <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-3.5">
          <p className="text-sm text-amber-900">
            <span className="font-bold">Dealer acceptance is provisional.</span> You can reopen
            until a vendor agrees — the offer becomes v{d.offer_version + 1} and the dealer is
            notified.
          </p>
          <button
            disabled={busy}
            onClick={() => void post(`/api/admin/buyback/requests/${id}/reopen`, {})}
            className="mt-2 rounded-lg border border-amber-400 bg-white px-3 py-1.5 text-xs font-semibold text-amber-800"
          >
            Reopen negotiation
          </button>
        </div>
      )}

      {/* ---- Battery lines ---- */}
      <Card title="Battery lines">
        {d.lines.map((l) => (
          <div key={l.id} className="flex items-center justify-between border-b border-slate-50 px-4 py-3 last:border-0">
            <div>
              <BatteryLineLabel line={l} />
              <div className="mt-1 text-xs text-slate-500">
                {l.photo_count} photos · measured {l.measured_voltage ?? "—"}V · expected{" "}
                {perUnitShort(l.expected_price_per_unit)}
                {l.dealer_price && (
                  <span className="ml-1 font-bold text-emerald-700">
                    · locked {perUnitShort(l.dealer_price)}
                  </span>
                )}
              </div>
            </div>
            <div className="tabular-nums font-bold">
              {inr(Number(l.expected_price_per_unit ?? 0) * l.quantity)}
            </div>
          </div>
        ))}
      </Card>

      {/* ---- The evidence (M03/M04). Photos to zoom into, and the ID proof that
             says the battery was the previous owner's to sell.

             Directly under the battery lines, deliberately: this is what an admin
             is deciding on. If checking provenance costs an extra click, it is the
             click that gets skipped on a busy afternoon — and the one time it
             mattered will be the one time nobody looked. ---- */}
      <div className="mt-4">
        <h2 className="mb-2 text-sm font-bold text-slate-900">Photos &amp; provenance</h2>
        <EvidenceReview
          requestId={id}
          labelForLine={(lineId) => {
            const line = d.lines.find((l) => l.id === lineId);
            if (!line) return "Battery";
            // The SHARED formatter — never a per-screen string template (invariant 7).
            return formatBatteryLine(line).full;
          }}
        />
      </div>

      {/* ---- Negotiation thread — itemized per SKU ---- */}
      <Card title="Negotiation log">
        {d.negotiation.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-slate-400">No negotiation yet.</p>
        ) : (
          <div className="space-y-3 p-4">
            {d.negotiation.map((r) => {
              const isAdmin = r.offered_by_role === "admin";
              return (
                <div key={r.id} className={`flex ${isAdmin ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[72%] rounded-xl border px-3.5 py-2.5 ${
                      isAdmin
                        ? "border-slate-200 bg-slate-100"
                        : "border-slate-200 bg-blue-50"
                    }`}
                  >
                    <div className="mb-1.5 text-xs font-bold text-slate-700">
                      {isAdmin ? "iTarang" : "Dealer"} · round {r.round_no}
                    </div>

                    {/* Every round shows its per-SKU table. No lump sums exist. */}
                    <div className="rounded-lg border border-black/5 bg-white/50">
                      {r.lines.map((l) => (
                        <div
                          key={l.line_id}
                          className="flex justify-between px-2.5 py-1.5 text-xs"
                        >
                          <span className="text-slate-600">{l.label}</span>
                          <span className="font-bold tabular-nums">
                            {perUnitShort(l.price_per_unit)}
                          </span>
                        </div>
                      ))}
                      <div className="flex justify-between border-t border-slate-100 px-2.5 py-1.5 text-xs font-bold">
                        <span>Total</span>
                        <span className="tabular-nums">{inr(r.total)}</span>
                      </div>
                    </div>

                    {r.note && <p className="mt-1.5 text-xs text-slate-600">{r.note}</p>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* ---- Margin (M08) ---- */}
      {(d.status === "DEALER_ACCEPTED" || d.status === "MARGIN_SET") && (
        <Card title="Margin & routing">
          <div className="p-4">
            <div className="mb-4 rounded-lg bg-slate-900 px-4 py-2.5 text-[12.5px] text-white">
              🔒 <span className="font-bold">Dealer never sees margin or the vendor price.</span>{" "}
              These fields exist only inside iTarang admin.
            </div>

            <div className="mb-3 flex items-center gap-2">
              {(["FLAT", "PCT"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setMarginMode(mode)}
                  className={`rounded-lg px-3.5 py-1.5 text-[12.5px] font-semibold ${
                    marginMode === mode
                      ? "bg-slate-900 text-white"
                      : "border border-slate-200 bg-white text-slate-600"
                  }`}
                >
                  {mode === "FLAT" ? "Flat ₹" : "%"}
                </button>
              ))}
              <input
                type="number"
                value={marginValue}
                onChange={(e) => setMarginValue(e.target.value)}
                className="w-28 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm tabular-nums"
              />
              <span className="text-xs text-slate-500">
                {marginMode === "FLAT" ? "per unit, every SKU" : "% of the dealer price"}
              </span>
            </div>

            <div className="overflow-hidden rounded-lg border border-slate-200">
              <div className="grid grid-cols-[1.6fr_1fr_1fr_1fr] bg-slate-50 px-3 py-2 text-[10.5px] font-bold uppercase tracking-wide text-slate-400">
                <span>SKU</span>
                <span className="text-right">Dealer</span>
                <span className="text-right">+Margin</span>
                <span className="text-right">Final ask</span>
              </div>

              {marginPreview.map(({ line, dealer, margin, ask }) => (
                <div
                  key={line.id}
                  className="grid grid-cols-[1.6fr_1fr_1fr_1fr] border-t border-slate-100 px-3 py-2 text-sm"
                >
                  <span className="font-semibold">
                    <BatteryLineLabel line={line} />
                  </span>
                  <span className="text-right tabular-nums">{inr(dealer)}</span>
                  <span className="text-right font-semibold tabular-nums text-emerald-700">
                    +{inr(margin)}
                  </span>
                  <span className="text-right font-extrabold tabular-nums">{inr(ask)}</span>
                </div>
              ))}

              <div className="grid grid-cols-[1.6fr_1fr_1fr_1fr] border-t border-slate-200 bg-emerald-50 px-3 py-2 text-sm font-extrabold text-emerald-800">
                <span>Order total</span>
                <span className="text-right tabular-nums">{inr(dealerTotal)}</span>
                <span className="text-right tabular-nums">+{inr(askTotal - dealerTotal)}</span>
                <span className="text-right tabular-nums">{inr(askTotal)}</span>
              </div>
            </div>

            {can("set_margin") && (
              <button
                disabled={busy}
                onClick={() =>
                  void post(`/api/admin/buyback/requests/${id}/margin`, {
                    margin_mode: marginMode,
                    lines: d.lines.map((l) => ({
                      line_id: l.id,
                      margin: Number(marginValue) || 0,
                    })),
                  })
                }
                className="mt-4 w-full rounded-lg bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                Lock margin &amp; continue
              </button>
            )}

            {d.status === "MARGIN_SET" && (
              <p className="mt-3 text-xs text-slate-500">
                Margin is locked (floor {inr(d.floor_total)}). Quote the lot out on the vendor
                board below.
              </p>
            )}
          </div>
        </Card>
      )}

      {/* ---- Vendor leg + fulfilment (M09–M11, Sprint 2A).
             Self-contained: it fetches and reloads its own state, so this page
             does not have to know about threads, POs or pickups. Admin-only by
             construction — the endpoint it calls has no dealer-facing variant,
             and must never get one. ---- */}
      <VendorBoard requestId={id} />

      {/* ---- Money: invoice approval, settlement, close (M12/M13, Sprint 2B).
             The per-line invoice check lives in here — it is where the M12 AC
             ("one edited line blocks approval even if the total matches") is
             visible to a human. ---- */}
      <MoneyBoard requestId={id} status={d.status} allowedActions={d.allowed_actions} />

      {/* ---- Activity log (M21) — read-only, insert-only at the DB ---- */}
      <Card title="Activity log">
        <div className="divide-y divide-slate-50">
          {d.activity.map((a) => (
            <div key={a.id} className="flex justify-between px-4 py-2 text-sm">
              <span className="text-slate-700">
                <span className="font-semibold">{a.role}</span> · {a.action}
              </span>
              <span className="text-xs text-slate-400">
                {new Date(a.created_at).toLocaleString("en-IN")}
              </span>
            </div>
          ))}
        </div>
      </Card>

      {/* ---------------------------- Modals ---------------------------- */}
      {modal === "reject" && (
        <Modal title={`Reject request · ${d.request_no}`} onClose={() => setModal(null)}>
          <label className="text-xs font-bold uppercase text-slate-500">
            Reason for rejection
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. provenance mismatch, missing documents…"
            className="mt-1 min-h-20 w-full rounded-lg border border-slate-200 p-2.5 text-sm"
          />
          <ModalFooter
            onCancel={() => setModal(null)}
            confirmLabel="Reject request"
            tone="danger"
            disabled={busy || !reason.trim()}
            onConfirm={() =>
              void post(`/api/admin/buyback/requests/${id}/decision`, {
                action: "reject",
                reason,
              })
            }
          />
        </Modal>
      )}

      {(modal === "negotiate" || modal === "final") && (
        <Modal
          title={
            modal === "final"
              ? `Send final offer · ${d.request_no}`
              : `Counter offer · ${d.request_no}`
          }
          onClose={() => setModal(null)}
        >
          <p className="mb-3 text-xs text-slate-500">
            {modal === "final"
              ? "Itemized final price per SKU. The dealer accepts or declines the whole set (one binary answer). The version bumps on any reopen."
              : "Enter a counter price per SKU. A counter must price every battery line."}
          </p>

          <LineInputTable
            lines={d.lines}
            values={prices}
            onChange={(lineId, v) => setPrices((p) => ({ ...p, [lineId]: v }))}
          />

          <label className="mt-3 block text-xs font-bold uppercase text-slate-500">
            Note {modal === "final" ? "(optional)" : "to dealer"}
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="mt-1 min-h-14 w-full rounded-lg border border-slate-200 p-2.5 text-sm"
          />

          <ModalFooter
            onCancel={() => setModal(null)}
            confirmLabel={modal === "final" ? "Send final offer" : "Send counter"}
            tone={modal === "final" ? "primary" : "amber"}
            disabled={busy}
            onConfirm={() => {
              const lines = d.lines.map((l) => ({
                line_id: l.id,
                price_per_unit: Number(prices[l.id] || 0),
              }));
              if (modal === "final") {
                void post(`/api/admin/buyback/requests/${id}/final-offer`, {
                  lines,
                  note: note || null,
                });
              } else {
                void post(`/api/admin/buyback/requests/${id}/decision`, {
                  action: "negotiate",
                  lines,
                  note: note || null,
                });
              }
            }}
          />
        </Modal>
      )}

      {modal === "reqinfo" && (
        <Modal title={`Request information · ${d.request_no}`} onClose={() => setModal(null)}>
          {/* Unit-level targeting (BRD P4) — the prototype only targeted SKUs. */}
          <p className="text-[12.5px] font-bold text-slate-600">1 · Which batteries?</p>
          <div className="mb-4 mt-2 space-y-2">
            {d.lines.map((l) => (
              <div key={l.id}>
                <BatteryLineLabel line={l} showCount={false} />
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {l.units.map((u) => {
                    const on = targetUnits.includes(u.id);
                    return (
                      <button
                        key={u.id}
                        onClick={() =>
                          setTargetUnits((t) =>
                            on ? t.filter((x) => x !== u.id) : [...t, u.id],
                          )
                        }
                        className={`rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${
                          on
                            ? "bg-slate-900 text-white"
                            : "border border-slate-200 bg-white text-slate-600"
                        }`}
                      >
                        {on ? "✓ " : ""}Unit {u.unit_no}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <p className="text-[12.5px] font-bold text-slate-600">2 · What is missing?</p>
          <div className="mb-3 mt-2 space-y-1">
            {CHECKLIST.map((item) => (
              <label key={item} className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={checklist.includes(item)}
                  onChange={(e) =>
                    setChecklist((c) =>
                      e.target.checked ? [...c, item] : c.filter((x) => x !== item),
                    )
                  }
                />
                {item}
              </label>
            ))}
          </div>

          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note…"
            className="min-h-14 w-full rounded-lg border border-slate-200 p-2.5 text-sm"
          />

          <ModalFooter
            onCancel={() => setModal(null)}
            confirmLabel="Send request"
            tone="amber"
            disabled={busy || targetUnits.length === 0 || checklist.length === 0}
            onConfirm={() =>
              void post(`/api/admin/buyback/requests/${id}/decision`, {
                action: "request_info",
                target_unit_ids: targetUnits,
                checklist,
                note: note || null,
              })
            }
          />
          {targetUnits.length === 0 && (
            <p className="mt-2 text-xs text-amber-700">
              Select the exact units you need information about — the dealer&apos;s banner will name
              them.
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}

/**
 * A review action. When the state machine refuses it, the button is ghosted and
 * its tooltip is the machine's own reason — the same sentence the API returns.
 */
function ActionButton({
  label,
  tone,
  state,
  busy,
  onClick,
}: {
  label: string;
  tone: "green" | "danger" | "amber" | "ghost";
  state?: ReviewAction;
  busy: boolean;
  onClick: () => void;
}) {
  const enabled = state?.enabled ?? false;

  const tones = {
    green: "bg-emerald-600 text-white hover:bg-emerald-700",
    danger: "border border-red-300 bg-white text-red-600 hover:bg-red-50",
    amber: "border border-amber-300 bg-white text-amber-700 hover:bg-amber-50",
    ghost: "border border-slate-200 bg-white text-slate-800 hover:bg-slate-50",
  };

  if (!enabled) {
    return (
      <button
        disabled
        title={state?.blocked_reason ?? "Not available in this state."}
        className="cursor-not-allowed rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-400"
      >
        {label}
      </button>
    );
  }

  return (
    <button
      disabled={busy}
      onClick={onClick}
      className={`rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50 ${tones[tone]}`}
    >
      {label}
    </button>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6 rounded-xl border border-slate-200 bg-white">
      <h2 className="border-b border-slate-100 px-4 py-3 text-sm font-bold text-slate-900">
        {title}
      </h2>
      {children}
    </div>
  );
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[480px] rounded-2xl bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-3 text-base font-bold text-slate-900">{title}</h3>
        {children}
      </div>
    </div>
  );
}

function ModalFooter({
  onCancel,
  onConfirm,
  confirmLabel,
  tone,
  disabled,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  confirmLabel: string;
  tone: "primary" | "danger" | "amber";
  disabled: boolean;
}) {
  const tones = {
    primary: "bg-slate-900 text-white",
    danger: "border border-red-300 bg-white text-red-600",
    amber: "border border-amber-300 bg-white text-amber-700",
  };

  return (
    <div className="mt-4 flex justify-end gap-2">
      <button
        onClick={onCancel}
        className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-semibold"
      >
        Cancel
      </button>
      <button
        disabled={disabled}
        onClick={onConfirm}
        className={`rounded-lg px-3 py-1.5 text-sm font-semibold disabled:opacity-50 ${tones[tone]}`}
      >
        {confirmLabel}
      </button>
    </div>
  );
}
