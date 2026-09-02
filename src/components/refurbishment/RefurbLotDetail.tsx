"use client";

/**
 * E-270 / E-271 — one refurbishment lot, seen from either end.
 *
 * The NBFC console and the admin desk render the SAME component, told which
 * side it is on. Same batteries, same quote, same trucks, same money, same
 * thread — only the action panel differs, driven by `lot.status` + `side`:
 *
 *   status              nbfc panel                        admin panel
 *   requested           cancel · message                  review (decline) + quote · cancel
 *   proposed            approve quote / ask changes       cancel · message
 *   countered           cancel · message                  quote again · cancel
 *   agreed              dispatch (nbfc_ships) · cancel    cancel · message
 *   awaiting_advance    pay online / record transfer      confirm transfer (once recorded)
 *   advance_paid        dispatch (nbfc_ships)             message
 *   pickup_scheduled    message                           picked up (transport + e-way bill)
 *   in_transit_out      message                           mark arrived
 *   delivered           message                           receipt per battery
 *   received            message                           start work
 *   in_progress         message                           per-battery work · mark ready · revise quote
 *   revision_pending    approve / reject revision         message
 *   ready               message                           dispatch return (transport + e-way bill)
 *   in_transit_return   mark arrived                      message
 *   delivered_back      receipt per battery               message
 *   balance_due         pay online / record transfer      confirm transfer (once recorded)
 *   settled/cancelled   (read only)
 */
import { useMemo, useState } from "react";
import { formatINR } from "@/components/auction/AuctionPrimitives";
import { CUSTODY_LABEL, LOT_STATUS_LABEL, type Custody } from "@/lib/nbfc/recovery/refurbishment-lot-status";

// ---------------------------------------------------------------------------
// View types — the JSON shapes /api/.../lots/[id] returns
// ---------------------------------------------------------------------------
export interface AccessoryView { key: string; label: string; unit_cost: number; included: boolean }
export interface ChecklistView { key: string; label: string; done: boolean; note?: string | null }
export interface LotItemView {
  id: string;
  battery_id: string;
  battery_serial: string | null;
  model: string | null;
  capacity: string | null;
  condition_grade: string | null;
  soh_pct: number | null;
  image_urls: string[];
  status: string;
  custody: Custody;
  checklist: ChecklistView[];
  accessories: AccessoryView[];
  estimated_cost: number | null;
  actual_cost: number | null;
  total_cost: number | null;
  notes: string | null;
  assigned_workshop: string | null;
  decline_reason: string | null;
  out_received_condition: string | null;
  out_received_note: string | null;
  out_received_photo_urls: string[];
  ready_at: string | null;
  ret_received_condition: string | null;
  ret_received_note: string | null;
  ret_received_photo_urls: string[];
}
export interface LegView {
  carrier: string | null;
  vehicle_no: string | null;
  docket_no: string | null;
  eway_bill_no: string | null;
  eway_bill_url: string | null;
  dispatched_on: string | null;
  dispatch_note: string | null;
  photo_urls: string[];
  dispatched_at: string | null;
  picked_up_at: string | null;
  delivered_at: string | null;
  received_at: string | null;
  receipt_note: string | null;
  receipt_photo_urls: string[];
  has_mismatch: boolean;
}
export interface MoneyView {
  amount: number | null;
  status: string;
  provider: string | null;
  order_id: string | null;
  payment_id: string | null;
  reference: string | null;
  recorded_at: string | null;
  confirmed_at: string | null;
}
export interface LotEventView {
  id: string;
  seq: number;
  party: "nbfc" | "admin" | "system";
  kind: string;
  message: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}
export interface LotView {
  id: string;
  ref_code: string;
  tenant_id: string;
  tenant_name: string | null;
  status: string;
  awaiting: "nbfc" | "admin" | null;
  battery_count: number;
  note: string | null;
  current_round: number;
  expected_receipt_date: string | null;
  expected_return_date: string | null;
  estimated_labour_total: number | null;
  estimated_accessories_total: number | null;
  estimated_total: number | null;
  proposal_note: string | null;
  agreed_at: string | null;
  pickup_mode: "nbfc_ships" | "itarang_pickup";
  pickup_address: string | null;
  workshop_address: string | null;
  scheduled_pickup_date: string | null;
  quote_approved_total: number | null;
  quote_approved_at: string | null;
  revised_total: number | null;
  revision_note: string | null;
  revision_round: number;
  advance_pct: number;
  advance: MoneyView;
  final_total: number | null;
  balance: MoneyView;
  settled_at: string | null;
  out: LegView;
  ret: LegView;
  cancel_reason: string | null;
  cancelled_by_party: string | null;
  created_at: string;
  items?: LotItemView[];
  events?: LotEventView[];
  actual_total?: number | null;
  over_approved_quote?: boolean;
}

export type LotAction =
  | "accept" | "approve-quote" | "counter" | "cancel" | "dispatch" | "arrive" | "confirm-receipt" | "message"
  | "pay-order" | "pay-verify" | "record-payment" | "approve-revision" | "reject-revision"
  | "review" | "propose" | "confirm-payment" | "pickup" | "start-work" | "update-item" | "mark-ready" | "revise-quote";

export type PhotoTarget =
  | "out_dispatch" | "out_receipt" | "ret_dispatch" | "ret_receipt" | "out_eway_bill" | "ret_eway_bill"
  | `item:${string}:${"out" | "return"}`;

interface Props {
  lot: LotView;
  side: "nbfc" | "admin";
  canAct: boolean;
  busy: boolean;
  /** Resolves with the updated lot (or void). `pay-order` resolves with the intent instead. */
  onAction: (action: LotAction, payload: Record<string, unknown>) => Promise<unknown>;
  /** Uploads and resolves with the stored relative paths. */
  onUpload: (target: PhotoTarget, files: FileList) => Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const dmy = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—");
const dmyt = (d: string | null | undefined) => (d ? new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

export function lotTone(status: string): "live" | "warn" | "muted" | undefined {
  if (status === "settled") return "live";
  if (status === "cancelled") return "muted";
  if (["requested", "proposed", "countered", "awaiting_advance", "pickup_scheduled", "in_transit_out", "delivered", "revision_pending", "in_transit_return", "delivered_back", "balance_due"].includes(status)) return "warn";
  return undefined;
}

export function LotStatusChip({ status }: { status: string }) {
  return (
    <span className="auc-chip" data-tone={lotTone(status)}>
      {LOT_STATUS_LABEL[status as keyof typeof LOT_STATUS_LABEL] ?? status.replace(/_/g, " ")}
    </span>
  );
}

export function CustodyChip({ custody }: { custody: Custody }) {
  const tone = custody === "back_at_nbfc" ? "live" : custody === "unknown_lost" ? "muted" : custody.startsWith("in_transit") ? "warn" : undefined;
  return <span className="auc-chip" data-tone={tone}>{CUSTODY_LABEL[custody] ?? custody}</span>;
}

const ITEM_LABEL: Record<string, string> = { requested: "awaiting", declined: "declined", in_progress: "in workshop", ready: "ready", returned: "returned", cancelled: "cancelled" };

function Photos({ urls, size = 56 }: { urls: string[]; size?: number }) {
  if (!urls?.length) return null;
  return (
    <div style={{ display: "flex", gap: ".375rem", flexWrap: "wrap", marginBlockStart: ".375rem" }}>
      {urls.map((u) => (
        <a key={u} href={u} target="_blank" rel="noreferrer">
          {u.toLowerCase().endsWith(".pdf") ? (
            <span className="auc-chip">PDF</span>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={u} alt="" style={{ width: size, height: size, objectFit: "cover", borderRadius: 6, border: "1px solid var(--auc-rule)" }} />
          )}
        </a>
      ))}
    </div>
  );
}

function FilePick({ label, accept = "image/*", onPick, disabled }: { label: string; accept?: string; onPick: (f: FileList) => void; disabled?: boolean }) {
  return (
    <label className="auc-btn" data-variant="ghost" style={{ cursor: disabled ? "not-allowed" : "pointer" }}>
      {label}
      <input type="file" accept={accept} multiple={accept === "image/*"} hidden disabled={disabled} onChange={(e) => { if (e.target.files?.length) onPick(e.target.files); e.currentTarget.value = ""; }} />
    </label>
  );
}

// Lazily inject Razorpay Checkout.js — same head-injection the NBFC wallet
// panel uses (the VPS can't bundle third-party scripts).
function loadRazorpayCheckout(): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") return resolve(false);
    const w = window as unknown as { Razorpay?: unknown };
    if (w.Razorpay) return resolve(true);
    const existing = document.querySelector<HTMLScriptElement>('script[src="https://checkout.razorpay.com/v1/checkout.js"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(true));
      existing.addEventListener("error", () => resolve(false));
      return;
    }
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.body.appendChild(s);
  });
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------
const KIND_LABEL: Record<string, string> = {
  requested: "sent the batch",
  item_declined: "declined a battery",
  proposed: "sent a quote",
  countered: "asked for changes",
  accepted: "approved the quote",
  cancelled: "cancelled the lot",
  advance_recorded: "recorded the advance (bank transfer)",
  advance_confirmed: "confirmed the advance",
  pickup_scheduled: "pickup scheduled",
  dispatched_out: "dispatched to the workshop",
  picked_up: "picked up the batteries",
  arrived_out: "truck arrived at the workshop",
  received_out: "workshop signed for the batteries",
  work_started: "started work",
  revision_proposed: "sent a revised quote",
  revision_approved: "approved the revised quote",
  revision_rejected: "rejected the revised quote",
  item_ready: "marked a battery ready",
  dispatched_return: "dispatched back to the NBFC",
  arrived_return: "truck arrived at the NBFC",
  received_return: "signed for the returned batteries",
  balance_recorded: "recorded the balance (bank transfer)",
  settled: "settled",
  message: "wrote",
};

function EventPayload({ ev }: { ev: LotEventView }) {
  const p = ev.payload ?? {};
  const n = (k: string) => (p[k] == null ? null : Number(p[k]));
  switch (ev.kind) {
    case "requested":
      return <span className="auc-subtle">{(p.serials as string[] | undefined)?.join(", ")}{p.resubmitted_from_lot ? " · resubmission" : ""}</span>;
    case "item_declined":
    case "item_ready":
      return <span className="auc-subtle">{String(p.serial ?? "")}{n("actual_cost") != null ? ` · ${formatINR(n("actual_cost"))}` : ""}</span>;
    case "proposed":
      return (
        <span className="auc-subtle">
          round {String(p.round)} · {p.pickup_mode === "itarang_pickup" ? `iTarang picks up ${dmy(p.scheduled_pickup_date as string)}` : `receive by ${dmy(p.expected_receipt_date as string)}`} · return by {dmy(p.expected_return_date as string)} · estimate {formatINR(n("estimated_total"))}{n("advance_pct") ? ` · advance ${p.advance_pct}% (${formatINR(n("advance_amount"))})` : ""}
        </span>
      );
    case "accepted":
      return <span className="auc-subtle">approved {formatINR(n("quote_approved_total"))}{n("advance_amount") ? ` · advance ${formatINR(n("advance_amount"))} due` : ""}</span>;
    case "countered":
      return p.requested_receipt_date || p.requested_return_date ? <span className="auc-subtle">asked for: receive {dmy(p.requested_receipt_date as string)} · return {dmy(p.requested_return_date as string)}</span> : null;
    case "advance_recorded":
    case "balance_recorded":
    case "advance_confirmed":
    case "settled":
      return <span className="auc-subtle">{formatINR(n("amount"))}{p.provider ? ` · ${p.provider === "razorpay" ? "online" : "bank transfer"}` : ""}{p.reference ? ` · ref ${p.reference}` : ""}{p.payment_id ? ` · ${p.payment_id}` : ""}</span>;
    case "pickup_scheduled":
      return <span className="auc-subtle">{dmy(p.scheduled_pickup_date as string)}{p.pickup_address ? ` · ${p.pickup_address}` : ""}</span>;
    case "dispatched_out":
    case "picked_up":
    case "dispatched_return":
      return <span className="auc-subtle">{[p.carrier, p.vehicle_no, p.docket_no ? `docket ${p.docket_no}` : null, p.eway_bill_no ? `e-way ${p.eway_bill_no}` : null].filter(Boolean).join(" · ")} · {dmy(p.dispatched_on as string)}</span>;
    case "received_out":
    case "received_return":
      return <span className="auc-subtle">{String(p.received ?? 0)} received{Number(p.damaged) ? `, ${p.damaged} damaged` : ""}{Number(p.missing) ? `, ${p.missing} missing` : ""}{n("final_total") != null ? ` · final ${formatINR(n("final_total"))}, balance ${formatINR(n("balance_amount"))}` : ""}</span>;
    case "revision_proposed":
      return <span className="auc-subtle">{formatINR(n("approved_total"))} → {formatINR(n("revised_total"))}</span>;
    case "revision_approved":
    case "revision_rejected":
      return <span className="auc-subtle">approved total now {formatINR(n("approved_total"))}</span>;
    default:
      return null;
  }
}

export function LotTimeline({ events, tenantName }: { events: LotEventView[]; tenantName: string | null }) {
  const who = (party: LotEventView["party"]) => (party === "admin" ? "iTarang" : party === "nbfc" ? (tenantName ?? "NBFC") : "System");
  if (!events.length) return <p className="auc-subtle">Nothing yet.</p>;
  return (
    <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: ".5rem" }}>
      {[...events].reverse().map((ev) => (
        <li key={ev.id} style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: ".75rem", alignItems: "start" }}>
          <span className="auc-chip" data-tone={ev.party === "admin" ? undefined : ev.party === "nbfc" ? "warn" : "muted"} style={{ minWidth: "5.5rem", justifyContent: "center" }}>{who(ev.party)}</span>
          <div>
            <div><b>{KIND_LABEL[ev.kind] ?? ev.kind.replace(/_/g, " ")}</b><span className="auc-subtle" style={{ marginInlineStart: ".5rem" }}>{dmyt(ev.created_at)}</span></div>
            {ev.message ? <div style={{ whiteSpace: "pre-wrap" }}>{ev.message}</div> : null}
            <EventPayload ev={ev} />
          </div>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------
function TransportForm({ title, submitLabel, ewayTarget, busy, onSubmit, onUpload }: {
  title: string;
  submitLabel: string;
  ewayTarget: "out_eway_bill" | "ret_eway_bill";
  busy: boolean;
  onSubmit: (p: Record<string, unknown>) => Promise<unknown>;
  onUpload: (target: PhotoTarget, files: FileList) => Promise<string[]>;
}) {
  const [carrier, setCarrier] = useState("");
  const [vehicle, setVehicle] = useState("");
  const [docket, setDocket] = useState("");
  const [eway, setEway] = useState("");
  const [ewayUrl, setEwayUrl] = useState<string | null>(null);
  const [date, setDate] = useState(today());
  const [note, setNote] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const photoTarget: PhotoTarget = ewayTarget === "out_eway_bill" ? "out_dispatch" : "ret_dispatch";
  return (
    <>
      <header><span className="auc-panel-n">🚚</span><h3>{title}</h3></header>
      <div className="auc-panel-body">
        <div className="auc-dl" style={{ gap: ".75rem" }}>
          <div className="auc-field"><label>Carrier / transporter</label><input className="auc-text" value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="e.g. VRL Logistics / own vehicle" /></div>
          <div className="auc-field"><label>Vehicle no.</label><input className="auc-text" value={vehicle} onChange={(e) => setVehicle(e.target.value)} placeholder="MH 12 AB 1234" /></div>
          <div className="auc-field"><label>Docket / LR no.</label><input className="auc-text" value={docket} onChange={(e) => setDocket(e.target.value)} /></div>
          <div className="auc-field"><label>Date</label><input className="auc-text" type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} /></div>
          <div className="auc-field">
            <label>E-way bill no.</label>
            <input className="auc-text" value={eway} onChange={(e) => setEway(e.target.value.replace(/\D/g, "").slice(0, 12))} placeholder="12-digit EWB" inputMode="numeric" />
          </div>
          <div className="auc-field">
            <label>E-way bill document</label>
            <div className="auc-linkrow">
              <FilePick label={ewayUrl ? "Replace" : "Upload PDF / photo"} accept="application/pdf,image/*" disabled={busy} onPick={(f) => void onUpload(ewayTarget, f).then((p) => setEwayUrl(p[0] ?? null))} />
              {ewayUrl ? <a href={ewayUrl} target="_blank" rel="noreferrer" className="auc-chip">attached</a> : <span className="auc-hint">Required for inter-state moves over ₹50,000.</span>}
            </div>
          </div>
        </div>
        <div className="auc-field" style={{ marginBlockStart: ".5rem" }}>
          <label>Note</label>
          <textarea className="auc-text" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Packing, contact person at the other end, anything the receiver should know." />
        </div>
        <div className="auc-linkrow" style={{ marginBlockStart: ".5rem" }}>
          <FilePick label="Add photographs" disabled={busy} onPick={(f) => void onUpload(photoTarget, f).then((paths) => setPhotos((p) => [...p, ...paths]))} />
          <span className="auc-hint">Loaded vehicle, packing, the docket.</span>
        </div>
        <Photos urls={photos} />
        <div className="auc-linkrow" style={{ marginBlockStart: ".75rem" }}>
          <button type="button" className="auc-btn" disabled={busy || !date} onClick={() => onSubmit({ carrier: carrier || null, vehicle_no: vehicle || null, docket_no: docket || null, eway_bill_no: eway || null, eway_bill_url: ewayUrl, dispatched_on: date, message: note || undefined, photo_urls: photos })}>
            {submitLabel}
          </button>
        </div>
      </div>
    </>
  );
}

function ReceiptForm({ items, leg, busy, onSubmit, onUploadItem }: {
  items: LotItemView[];
  leg: "out" | "return";
  busy: boolean;
  onSubmit: (p: Record<string, unknown>) => Promise<unknown>;
  onUploadItem: (jobId: string, files: FileList) => Promise<string[]>;
}) {
  const [cond, setCond] = useState<Record<string, "received" | "damaged" | "missing">>(() => Object.fromEntries(items.map((i) => [i.id, "received" as const])));
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [photos, setPhotos] = useState<Record<string, string[]>>({});
  const [note, setNote] = useState("");
  const problems = Object.values(cond).filter((c) => c !== "received").length;
  return (
    <div className="auc-panel-body">
      <div style={{ overflowX: "auto" }}>
        <table className="auc-table">
          <thead><tr><th>Battery</th><th>Condition on arrival</th><th>Note / photos</th></tr></thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id}>
                <td><span className="auc-pick-serial">{it.battery_serial ?? it.battery_id.slice(0, 8)}</span><div className="auc-subtle">{it.model ?? ""}</div></td>
                <td>
                  <div style={{ display: "flex", gap: ".75rem", flexWrap: "wrap" }}>
                    {(["received", "damaged", "missing"] as const).map((c) => (
                      <label key={c} style={{ display: "flex", gap: ".3rem", alignItems: "center", cursor: "pointer" }}>
                        <input type="radio" name={`c-${it.id}`} checked={cond[it.id] === c} onChange={() => setCond((s) => ({ ...s, [it.id]: c }))} />{c}
                      </label>
                    ))}
                  </div>
                </td>
                <td>
                  <input className="auc-text" value={notes[it.id] ?? ""} onChange={(e) => setNotes((s) => ({ ...s, [it.id]: e.target.value }))} placeholder={cond[it.id] !== "received" ? "what is wrong (required)" : "optional"} />
                  <div className="auc-linkrow" style={{ marginBlockStart: ".25rem" }}>
                    <FilePick label="Photo" disabled={busy} onPick={(f) => void onUploadItem(it.id, f).then((paths) => setPhotos((s) => ({ ...s, [it.id]: [...(s[it.id] ?? []), ...paths] })))} />
                  </div>
                  <Photos urls={photos[it.id] ?? []} size={40} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="auc-field" style={{ marginBlockStart: ".5rem" }}><label>Receipt note</label><textarea className="auc-text" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></div>
      {problems ? <span className="auc-hint" style={{ color: "var(--auc-warn)" }}>{problems} {problems === 1 ? "battery" : "batteries"} flagged — the other side will be told.</span> : null}
      <div className="auc-linkrow" style={{ marginBlockStart: ".75rem" }}>
        <button type="button" className="auc-btn" disabled={busy || items.some((i) => cond[i.id] !== "received" && !(notes[i.id] ?? "").trim())}
          onClick={() => onSubmit({ items: items.map((i) => ({ job_id: i.id, condition: cond[i.id] ?? "received", note: notes[i.id] || null, photo_urls: photos[i.id] ?? [] })), message: note || undefined })}>
          {leg === "out" ? "Confirm receipt at workshop" : "Confirm receipt — batteries are back"}
        </button>
      </div>
    </div>
  );
}

function ProposeForm({ lot, items, busy, onSubmit }: { lot: LotView; items: LotItemView[]; busy: boolean; onSubmit: (p: Record<string, unknown>) => Promise<unknown> }) {
  const [receipt, setReceipt] = useState(lot.expected_receipt_date?.slice(0, 10) ?? plusDays(3));
  const [ret, setRet] = useState(lot.expected_return_date?.slice(0, 10) ?? plusDays(14));
  const [mode, setMode] = useState<"nbfc_ships" | "itarang_pickup">(lot.pickup_mode ?? "nbfc_ships");
  const [pickupDate, setPickupDate] = useState(lot.scheduled_pickup_date?.slice(0, 10) ?? plusDays(2));
  const [pickupAddr, setPickupAddr] = useState(lot.pickup_address ?? "");
  const [workshopAddr, setWorkshopAddr] = useState(lot.workshop_address ?? "");
  const [advPct, setAdvPct] = useState(String(lot.advance_pct ?? 0));
  const [est, setEst] = useState<Record<string, string>>(() => Object.fromEntries(items.map((i) => [i.id, i.estimated_cost != null ? String(i.estimated_cost) : ""])));
  const [acc, setAcc] = useState<Record<string, AccessoryView[]>>(() => Object.fromEntries(items.map((i) => [i.id, i.accessories])));
  const [note, setNote] = useState("");
  const labour = items.reduce((s, i) => s + (Number(est[i.id]) || 0), 0);
  const accTotal = items.reduce((s, i) => s + (acc[i.id] ?? []).filter((a) => a.included).reduce((x, a) => x + a.unit_cost, 0), 0);
  const total = labour + accTotal;
  const pct = Math.min(100, Math.max(0, Number(advPct) || 0));
  const ready = items.every((i) => est[i.id] !== "" && Number.isFinite(Number(est[i.id]))) && receipt && ret && ret >= receipt && (mode !== "itarang_pickup" || (pickupDate && pickupAddr.trim()));
  return (
    <div className="auc-panel-body">
      <span className="auc-label">Logistics</span>
      <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBlockStart: ".375rem" }}>
        <label style={{ display: "flex", gap: ".35rem", alignItems: "center" }}><input type="radio" checked={mode === "nbfc_ships"} onChange={() => setMode("nbfc_ships")} /> NBFC ships to the workshop</label>
        <label style={{ display: "flex", gap: ".35rem", alignItems: "center" }}><input type="radio" checked={mode === "itarang_pickup"} onChange={() => setMode("itarang_pickup")} /> iTarang picks up</label>
      </div>
      <div className="auc-dl" style={{ gap: ".75rem", marginBlockStart: ".5rem" }}>
        {mode === "itarang_pickup" ? (
          <>
            <div className="auc-field"><label>Scheduled pickup date</label><input className="auc-text" type="date" value={pickupDate} onChange={(e) => { setPickupDate(e.target.value); if (e.target.value > receipt) setReceipt(e.target.value); }} /></div>
            <div className="auc-field"><label>Pickup address (NBFC)</label><input className="auc-text" value={pickupAddr} onChange={(e) => setPickupAddr(e.target.value)} placeholder="warehouse / godown address" /></div>
          </>
        ) : null}
        <div className="auc-field"><label>{mode === "itarang_pickup" ? "Expect at workshop by" : "NBFC should ship by"}</label><input className="auc-text" type="date" value={receipt} onChange={(e) => setReceipt(e.target.value)} /></div>
        <div className="auc-field"><label>Return to NBFC by</label><input className="auc-text" type="date" value={ret} min={receipt} onChange={(e) => setRet(e.target.value)} /></div>
        <div className="auc-field"><label>Workshop address</label><input className="auc-text" value={workshopAddr} onChange={(e) => setWorkshopAddr(e.target.value)} placeholder="where the batteries go" /></div>
      </div>

      <span className="auc-label" style={{ display: "block", marginBlockStart: "1rem" }}>Estimate</span>
      <div style={{ overflowX: "auto", marginBlockStart: ".375rem" }}>
        <table className="auc-table">
          <thead><tr><th>Battery</th><th>SOH</th><th>Labour estimate (₹)</th><th>New accessories</th><th>Line total</th></tr></thead>
          <tbody>
            {items.map((it) => {
              const a = acc[it.id] ?? [];
              const aTotal = a.filter((x) => x.included).reduce((s, x) => s + x.unit_cost, 0);
              return (
                <tr key={it.id}>
                  <td><span className="auc-pick-serial">{it.battery_serial}</span></td>
                  <td>{it.soh_pct != null ? `${it.soh_pct}%` : "—"}</td>
                  <td><input className="auc-text" data-numeric="true" inputMode="numeric" style={{ width: "7rem" }} value={est[it.id] ?? ""} onChange={(e) => setEst((s) => ({ ...s, [it.id]: e.target.value.replace(/[^\d.]/g, "") }))} /></td>
                  <td>
                    {a.map((x) => (
                      <label key={x.key} style={{ display: "flex", gap: ".35rem", alignItems: "center" }}>
                        <input type="checkbox" checked={x.included} onChange={() => setAcc((s) => ({ ...s, [it.id]: (s[it.id] ?? []).map((y) => (y.key === x.key ? { ...y, included: !y.included } : y)) }))} />
                        {x.label} <span className="auc-subtle">{formatINR(x.unit_cost)}</span>
                      </label>
                    ))}
                  </td>
                  <td className="auc-num">{formatINR((Number(est[it.id]) || 0) + aTotal)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="auc-ledger" style={{ marginBlockStart: ".75rem", maxWidth: "30rem" }}>
        <div className="auc-ledger-row"><span>Labour</span><b>{formatINR(labour)}</b></div>
        <div className="auc-ledger-row"><span>Accessories (new — charger, harness, SOC meter)</span><b>{formatINR(accTotal)}</b></div>
        <div className="auc-ledger-row" data-total="true"><span>Quote</span><b>{formatINR(total)}</b></div>
        <div className="auc-ledger-row">
          <span style={{ display: "flex", gap: ".5rem", alignItems: "center" }}>
            Advance <input className="auc-text" data-numeric="true" inputMode="numeric" style={{ width: "4rem" }} value={advPct} onChange={(e) => setAdvPct(e.target.value.replace(/[^\d.]/g, ""))} /> %
          </span>
          <b>{formatINR(Math.round((total * pct) / 100))}</b>
        </div>
      </div>
      <span className="auc-hint">The NBFC approves this quote as a whole. Work that exceeds it later needs a revised quote they approve again. An advance, if any, is due before the batteries move; the balance after they are back.</span>
      <div className="auc-field" style={{ marginBlockStart: ".5rem" }}><label>Note to the NBFC</label><textarea className="auc-text" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What the estimate covers, what could change it." /></div>
      <div className="auc-linkrow" style={{ marginBlockStart: ".75rem" }}>
        <button type="button" className="auc-btn" disabled={busy || !ready} onClick={() => onSubmit({
          expected_receipt_date: receipt, expected_return_date: ret,
          pickup_mode: mode, scheduled_pickup_date: mode === "itarang_pickup" ? pickupDate : null,
          pickup_address: pickupAddr || null, workshop_address: workshopAddr || null, advance_pct: pct,
          items: items.map((i) => ({ job_id: i.id, estimated_cost: Number(est[i.id]), accessories: acc[i.id] })),
          message: note || undefined,
        })}>
          {lot.current_round > 0 ? "Send revised quote" : "Send quote"}
        </button>
      </div>
    </div>
  );
}

function ReviewPanel({ items, busy, onDecline }: { items: LotItemView[]; busy: boolean; onDecline: (jobId: string, reason: string) => Promise<unknown> }) {
  const [declining, setDeclining] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  return (
    <div className="auc-panel-body">
      <span className="auc-hint">Decline any battery you will not take; the rest go into the quote below. A declined battery goes back to the NBFC&rsquo;s register as inspected — they can fix the issue and resubmit it.</span>
      <div style={{ overflowX: "auto", marginBlockStart: ".5rem" }}>
        <table className="auc-table">
          <thead><tr><th>Battery</th><th>Model</th><th>SOH</th><th>Grade</th><th>Photos</th><th /></tr></thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id}>
                <td><span className="auc-pick-serial">{it.battery_serial}</span></td>
                <td>{it.model ?? "—"}{it.capacity ? ` · ${it.capacity}` : ""}</td>
                <td>{it.soh_pct != null ? `${it.soh_pct}%` : "—"}</td>
                <td>{it.condition_grade ?? "—"}</td>
                <td><Photos urls={it.image_urls} size={36} /></td>
                <td>
                  {it.status === "declined" ? <span className="auc-chip" data-tone="muted">declined</span> : declining === it.id ? (
                    <div style={{ display: "flex", gap: ".375rem" }}>
                      <input className="auc-text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="reason (required)" />
                      <button type="button" className="auc-btn" disabled={busy || !reason.trim()} onClick={async () => { await onDecline(it.id, reason.trim()); setDeclining(null); setReason(""); }}>Decline</button>
                      <button type="button" className="auc-btn" data-variant="ghost" onClick={() => setDeclining(null)}>Keep</button>
                    </div>
                  ) : <button type="button" className="auc-btn" data-variant="ghost" disabled={busy} onClick={() => setDeclining(it.id)}>Decline…</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function WorkPanel({ lot, items, busy, onUpdate, onReady, onRevise }: {
  lot: LotView;
  items: LotItemView[];
  busy: boolean;
  onUpdate: (jobId: string, patch: Record<string, unknown>) => Promise<unknown>;
  onReady: (jobId: string) => Promise<unknown>;
  onRevise: (total: number, note: string) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [revTotal, setRevTotal] = useState("");
  const [revNote, setRevNote] = useState("");
  const shown = (it: LotItemView) => draft[it.id] ?? (it.actual_cost != null ? String(it.actual_cost) : "");
  const approved = lot.quote_approved_total ?? 0;
  const actual = lot.actual_total ?? 0;
  const over = lot.over_approved_quote === true;
  return (
    <div className="auc-stack">
      <div className="auc-ledger" style={{ maxWidth: "30rem" }}>
        <div className="auc-ledger-row"><span>Approved by NBFC</span><b>{formatINR(approved)}</b></div>
        <div className="auc-ledger-row" data-total="true"><span>Actual so far</span><b style={over ? { color: "var(--auc-warn)" } : undefined}>{formatINR(actual)}</b></div>
      </div>
      {over && lot.status === "in_progress" ? (
        <div className="auc-inline-error">
          Actual work exceeds the approved quote by {formatINR(actual - approved)}. The last battery cannot be marked ready until the NBFC approves a revised quote.
          <div className="auc-linkrow" style={{ marginBlockStart: ".5rem" }}>
            <input className="auc-text" data-numeric="true" inputMode="numeric" style={{ width: "8rem" }} placeholder={String(Math.ceil(actual))} value={revTotal} onChange={(e) => setRevTotal(e.target.value.replace(/[^\d.]/g, ""))} />
            <input className="auc-text" placeholder="why (cells replaced, BMS…)" value={revNote} onChange={(e) => setRevNote(e.target.value)} style={{ flex: "1 1 14rem" }} />
            <button type="button" className="auc-btn" disabled={busy || !(Number(revTotal || actual) > approved)} onClick={() => onRevise(Number(revTotal || Math.ceil(actual)), revNote)}>Send revised quote</button>
          </div>
        </div>
      ) : null}
      {items.map((it) => {
        const accTotal = it.accessories.filter((a) => a.included).reduce((s, a) => s + a.unit_cost, 0);
        const done = it.status === "ready" || it.status === "returned";
        return (
          <article key={it.id} className="auc-mini-card">
            <header>
              <div className="auc-winner">
                <span className="auc-pick-serial">{it.battery_serial}</span>
                <span className="auc-subtle">{it.model ?? ""} · SOH {it.soh_pct ?? "—"}% · est. {formatINR(it.estimated_cost)}</span>
              </div>
              <span className="auc-chip" data-tone={done ? "live" : it.status === "in_progress" ? "warn" : "muted"}>{ITEM_LABEL[it.status] ?? it.status}</span>
            </header>
            {it.out_received_condition && it.out_received_condition !== "received" ? <p className="auc-hint" style={{ color: "var(--auc-warn)" }}>Arrived {it.out_received_condition}{it.out_received_note ? ` — ${it.out_received_note}` : ""}</p> : null}
            <div className="auc-ledger" style={{ marginBlockStart: ".5rem" }}>
              {it.accessories.map((a) => (
                <div key={a.key} className="auc-ledger-row">
                  <label style={{ display: "flex", gap: ".5rem", alignItems: "center", cursor: done ? "default" : "pointer" }}>
                    <input type="checkbox" checked={a.included} disabled={busy || done} onChange={() => void onUpdate(it.id, { accessories: it.accessories.map((x) => (x.key === a.key ? { ...x, included: !x.included } : x)) })} />{a.label}
                  </label>
                  <b>{formatINR(a.unit_cost)}</b>
                </div>
              ))}
              <div className="auc-ledger-row">
                <span>Actual labour</span>
                {done ? <b>{formatINR(it.actual_cost)}</b> : (
                  <input className="auc-text" data-numeric="true" inputMode="numeric" style={{ width: "7rem" }} value={shown(it)} disabled={busy}
                    onChange={(e) => setDraft((s) => ({ ...s, [it.id]: e.target.value.replace(/[^\d.]/g, "") }))}
                    onBlur={() => { const v = shown(it); const n = v === "" ? null : Number(v); if (n !== (it.actual_cost ?? null)) void onUpdate(it.id, { actual_cost: n }); }} />
                )}
              </div>
              <div className="auc-ledger-row" data-total="true"><span>Rolls into base price</span><b>{formatINR((Number(shown(it)) || it.actual_cost || it.estimated_cost || 0) + accTotal)}</b></div>
            </div>
            {!done && it.status === "in_progress" && lot.status === "in_progress" ? (
              <div className="auc-linkrow" style={{ marginBlockStart: ".625rem" }}>
                <button type="button" className="auc-btn" disabled={busy} onClick={() => void onReady(it.id)}>Mark ready</button>
                {shown(it) === "" ? <span className="auc-hint">Enter the actual cost first — the estimate is used if you don&rsquo;t.</span> : null}
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function PayPanel({ lot, leg, side, busy, onAction }: { lot: LotView; leg: "advance" | "balance"; side: "nbfc" | "admin"; busy: boolean; onAction: Props["onAction"] }) {
  const m = leg === "advance" ? lot.advance : lot.balance;
  const [ref, setRef] = useState("");
  const [note, setNote] = useState("");
  const [paying, setPaying] = useState(false);
  const label = leg === "advance" ? `Advance (${lot.advance_pct}%)` : "Balance";

  async function payOnline() {
    setPaying(true);
    try {
      const r = (await onAction("pay-order", { leg })) as { intent?: { order_id: string | null; key_id: string | null; amount: number; gateway_unavailable: boolean } } | undefined;
      const intent = r?.intent;
      if (!intent || intent.gateway_unavailable || !intent.order_id || !intent.key_id) {
        alert("Online payment is not available right now — pay by bank transfer and record the UTR below.");
        return;
      }
      if (!(await loadRazorpayCheckout())) {
        alert("The payment window could not load. Check your connection and try again.");
        return;
      }
      const Rzp = (window as unknown as { Razorpay: new (o: Record<string, unknown>) => { open: () => void } }).Razorpay;
      const rzp = new Rzp({
        key: intent.key_id,
        order_id: intent.order_id,
        amount: Math.round(intent.amount * 100),
        currency: "INR",
        name: "iTarang",
        description: `Refurbishment ${lot.ref_code} — ${label.toLowerCase()}`,
        handler: (resp: Record<string, string>) => {
          void onAction("pay-verify", { leg, razorpay_order_id: resp.razorpay_order_id, razorpay_payment_id: resp.razorpay_payment_id, razorpay_signature: resp.razorpay_signature });
        },
      });
      rzp.open();
    } finally {
      setPaying(false);
    }
  }

  return (
    <div className="auc-panel-body">
      <div className="auc-ledger" style={{ maxWidth: "30rem" }}>
        {leg === "balance" ? (
          <>
            <div className="auc-ledger-row"><span>Final bill</span><b>{formatINR(lot.final_total)}</b></div>
            <div className="auc-ledger-row"><span>Advance paid</span><b>− {formatINR(lot.advance.status === "confirmed" ? lot.advance.amount : 0)}</b></div>
          </>
        ) : (
          <div className="auc-ledger-row"><span>Approved quote</span><b>{formatINR(lot.quote_approved_total)}</b></div>
        )}
        <div className="auc-ledger-row" data-total="true"><span>{label} due</span><b>{formatINR(m.amount)}</b></div>
      </div>
      {m.status === "recorded" ? (
        <p className="auc-hint">Recorded as a bank transfer, reference <b>{m.reference}</b> on {dmyt(m.recorded_at)}.{side === "admin" ? " Confirm once it shows in the account." : " Waiting for iTarang to confirm."}</p>
      ) : null}
      {side === "nbfc" && m.status !== "recorded" ? (
        <>
          <div className="auc-linkrow" style={{ marginBlockStart: ".75rem" }}>
            <button type="button" className="auc-btn" disabled={busy || paying} onClick={() => void payOnline()}>{paying ? "Opening…" : "Pay online"}</button>
            <span className="auc-subtle">or record a bank transfer:</span>
          </div>
          <div className="auc-linkrow" style={{ marginBlockStart: ".5rem" }}>
            <input className="auc-text" placeholder="UTR / reference" value={ref} onChange={(e) => setRef(e.target.value)} style={{ maxWidth: "16rem" }} />
            <input className="auc-text" placeholder="note (optional)" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: "1 1 12rem" }} />
            <button type="button" className="auc-btn" data-variant="ghost" disabled={busy || ref.trim().length < 3} onClick={() => void onAction("record-payment", { leg, reference: ref.trim(), message: note || undefined })}>Record transfer</button>
          </div>
        </>
      ) : null}
      {side === "admin" && m.status === "recorded" ? (
        <div className="auc-linkrow" style={{ marginBlockStart: ".75rem" }}>
          <button type="button" className="auc-btn" disabled={busy} onClick={() => void onAction("confirm-payment", { leg })}>Confirm {leg} received</button>
        </div>
      ) : null}
      {side === "admin" && m.status === "pending" ? <p className="auc-hint">Waiting for {lot.tenant_name ?? "the NBFC"} to pay.</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The detail
// ---------------------------------------------------------------------------
export default function RefurbLotDetail({ lot, side, canAct, busy, onAction, onUpload }: Props) {
  const items = useMemo(() => lot.items ?? [], [lot.items]);
  const live = useMemo(() => items.filter((i) => i.status !== "declined" && i.status !== "cancelled"), [items]);
  const [msg, setMsg] = useState("");
  const [counterMsg, setCounterMsg] = useState("");
  const [counterReceipt, setCounterReceipt] = useState("");
  const [counterReturn, setCounterReturn] = useState("");
  const [showCounter, setShowCounter] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [showCancel, setShowCancel] = useState(false);
  const [revMsg, setRevMsg] = useState("");

  const s = lot.status;
  const isNbfc = side === "nbfc";
  const closed = s === "settled" || s === "cancelled";
  const cancellable = ["requested", "proposed", "countered", "agreed", "awaiting_advance", "advance_paid", "pickup_scheduled"].includes(s);
  const nbfcName = lot.tenant_name ?? "NBFC";
  const canShipOut = isNbfc && (s === "agreed" || s === "advance_paid") && lot.pickup_mode === "nbfc_ships";

  // "Where are the batteries" — one line, counts per custody.
  const custodySummary = useMemo(() => {
    const c = new Map<Custody, number>();
    for (const i of live) c.set(i.custody, (c.get(i.custody) ?? 0) + 1);
    return Array.from(c.entries());
  }, [live]);

  return (
    <section className="auc-panel">
      <header>
        <div>
          <h3 style={{ margin: 0 }}>{lot.ref_code} · {lot.battery_count} {lot.battery_count === 1 ? "battery" : "batteries"}{!isNbfc && lot.tenant_name ? ` · ${lot.tenant_name}` : ""}</h3>
          <span className="auc-subtle">{lot.awaiting ? `Waiting on ${lot.awaiting === "admin" ? "iTarang" : nbfcName}` : "Closed"} · raised {dmy(lot.created_at)}</span>
        </div>
        <LotStatusChip status={s} />
      </header>

      <div className="auc-panel-body">
        {/* Where are the batteries */}
        {live.length ? (
          <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap", alignItems: "center", marginBlockEnd: ".5rem" }}>
            <span className="auc-label">Where are the batteries</span>
            {custodySummary.map(([c, n]) => (<span key={c} style={{ display: "inline-flex", gap: ".25rem", alignItems: "center" }}><CustodyChip custody={c} /><span className="auc-subtle">×{n}</span></span>))}
          </div>
        ) : null}

        {lot.note ? <p style={{ whiteSpace: "pre-wrap" }}><span className="auc-label">NBFC note</span><br />{lot.note}</p> : null}
        {s === "cancelled" ? <p className="auc-inline-error">Cancelled by {lot.cancelled_by_party === "admin" ? "iTarang" : nbfcName}{lot.cancel_reason ? `: ${lot.cancel_reason}` : ""}.{lot.advance.status === "confirmed" ? ` Advance of ${formatINR(lot.advance.amount)} was paid and needs refunding.` : ""}</p> : null}

        {/* The quote */}
        {lot.current_round > 0 ? (
          <dl className="auc-dl" style={{ marginBlockStart: ".5rem" }}>
            <div><dt>Logistics</dt><dd>{lot.pickup_mode === "itarang_pickup" ? `iTarang picks up ${dmy(lot.scheduled_pickup_date)}` : `${nbfcName} ships by ${dmy(lot.expected_receipt_date)}`}</dd></div>
            <div><dt>Return by</dt><dd>{dmy(lot.expected_return_date)}</dd></div>
            <div><dt>Quote</dt><dd className="auc-num"><b>{formatINR(lot.estimated_total)}</b> <span className="auc-subtle">({formatINR(lot.estimated_labour_total)} labour + {formatINR(lot.estimated_accessories_total)} accessories)</span></dd></div>
            {lot.quote_approved_total != null ? <div><dt>Approved</dt><dd className="auc-num"><b>{formatINR(lot.quote_approved_total)}</b> <span className="auc-subtle">{dmy(lot.quote_approved_at)}</span></dd></div> : null}
            {lot.advance_pct > 0 ? <div><dt>Advance {lot.advance_pct}%</dt><dd className="auc-num">{formatINR(lot.advance.amount)} <span className="auc-chip" data-tone={lot.advance.status === "confirmed" ? "live" : lot.advance.status === "not_required" ? undefined : "warn"}>{lot.advance.status.replace(/_/g, " ")}</span></dd></div> : null}
            {lot.actual_total != null && ["in_progress", "revision_pending", "ready", "in_transit_return", "delivered_back", "balance_due", "settled"].includes(s) ? <div><dt>Actual</dt><dd className="auc-num"><b style={lot.over_approved_quote ? { color: "var(--auc-warn)" } : undefined}>{formatINR(lot.actual_total)}</b></dd></div> : null}
            {lot.final_total != null ? <div><dt>Final bill</dt><dd className="auc-num"><b>{formatINR(lot.final_total)}</b></dd></div> : null}
            {lot.balance.amount != null && lot.balance.status !== "not_due" ? <div><dt>Balance</dt><dd className="auc-num">{formatINR(lot.balance.amount)} <span className="auc-chip" data-tone={lot.balance.status === "confirmed" ? "live" : "warn"}>{lot.balance.status}</span></dd></div> : null}
          </dl>
        ) : null}
        {lot.pickup_address || lot.workshop_address ? <p className="auc-subtle">{lot.pickup_address ? `Pickup: ${lot.pickup_address}. ` : ""}{lot.workshop_address ? `Workshop: ${lot.workshop_address}.` : ""}</p> : null}
        {lot.proposal_note ? <p className="auc-subtle" style={{ whiteSpace: "pre-wrap" }}>{lot.proposal_note}</p> : null}

        {/* Legs */}
        {[{ k: "out" as const, g: lot.out, title: "To workshop" }, { k: "ret" as const, g: lot.ret, title: "Back to NBFC" }].map(({ k, g, title }) =>
          g.dispatched_at ? (
            <div key={k} style={{ marginBlockStart: ".75rem" }}>
              <span className="auc-label">{title}</span>
              <div className="auc-subtle">
                {g.picked_up_at ? "Picked up" : "Dispatched"} {dmy(g.dispatched_on)} · {[g.carrier, g.vehicle_no, g.docket_no ? `docket ${g.docket_no}` : null, g.eway_bill_no ? `e-way bill ${g.eway_bill_no}` : null].filter(Boolean).join(" · ") || "no transport details"}
                {g.delivered_at ? ` · arrived ${dmyt(g.delivered_at)}` : ""}
                {g.received_at ? ` · received ${dmyt(g.received_at)}${g.has_mismatch ? " ⚠ with discrepancies" : ""}` : ""}
                {g.eway_bill_url ? <> · <a href={g.eway_bill_url} target="_blank" rel="noreferrer">e-way bill</a></> : null}
              </div>
              <Photos urls={[...g.photo_urls, ...g.receipt_photo_urls]} size={40} />
            </div>
          ) : null,
        )}
      </div>

      {/* ---------------- Action panel ---------------- */}
      {!closed && canAct ? (
        <>
          {!isNbfc && (s === "requested" || s === "countered") ? (
            <>
              {s === "requested" ? <ReviewPanel items={items} busy={busy} onDecline={(job_id, reason) => onAction("review", { decisions: [{ job_id, decision: "decline", reason }] })} /> : null}
              {live.length ? (<><header><span className="auc-panel-n">₹</span><h3>{s === "countered" ? "Revised quote" : "Quote — logistics, timeline, estimate, advance"}</h3></header><ProposeForm key={`${lot.id}-${lot.current_round}`} lot={lot} items={live} busy={busy} onSubmit={(p) => onAction("propose", p)} /></>) : null}
            </>
          ) : null}

          {isNbfc && s === "proposed" ? (
            <div className="auc-panel-body">
              <div className="auc-linkrow">
                <button type="button" className="auc-btn" disabled={busy} onClick={() => onAction("approve-quote", {})}>Approve quote — {formatINR(lot.estimated_total)}</button>
                <button type="button" className="auc-btn" data-variant="ghost" disabled={busy} onClick={() => setShowCounter((v) => !v)}>Ask for changes</button>
              </div>
              {showCounter ? (
                <div style={{ marginBlockStart: ".75rem" }}>
                  <div className="auc-dl" style={{ gap: ".75rem" }}>
                    <div className="auc-field"><label>Receipt / pickup date you need</label><input className="auc-text" type="date" value={counterReceipt} onChange={(e) => setCounterReceipt(e.target.value)} /></div>
                    <div className="auc-field"><label>Return date you need</label><input className="auc-text" type="date" value={counterReturn} onChange={(e) => setCounterReturn(e.target.value)} /></div>
                  </div>
                  <div className="auc-field" style={{ marginBlockStart: ".5rem" }}><label>What should change (price, advance, pickup…)</label><textarea className="auc-text" rows={2} value={counterMsg} onChange={(e) => setCounterMsg(e.target.value)} /></div>
                  <div className="auc-linkrow" style={{ marginBlockStart: ".5rem" }}>
                    <button type="button" className="auc-btn" disabled={busy || (!counterMsg.trim() && !counterReceipt && !counterReturn)} onClick={() => onAction("counter", { message: counterMsg || undefined, requested_receipt_date: counterReceipt || null, requested_return_date: counterReturn || null })}>Send to iTarang</button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {s === "awaiting_advance" ? (<><header><span className="auc-panel-n">₹</span><h3>Advance</h3></header><PayPanel lot={lot} leg="advance" side={side} busy={busy} onAction={onAction} /></>) : null}
          {s === "balance_due" ? (<><header><span className="auc-panel-n">₹</span><h3>Balance</h3></header><PayPanel lot={lot} leg="balance" side={side} busy={busy} onAction={onAction} /></>) : null}

          {canShipOut ? <TransportForm title="Dispatch to the iTarang workshop" submitLabel="Record dispatch" ewayTarget="out_eway_bill" busy={busy} onSubmit={(p) => onAction("dispatch", p)} onUpload={onUpload} /> : null}
          {!isNbfc && s === "pickup_scheduled" ? <TransportForm title={`Pickup from ${nbfcName} — scheduled ${dmy(lot.scheduled_pickup_date)}`} submitLabel="Picked up — in transit" ewayTarget="out_eway_bill" busy={busy} onSubmit={(p) => onAction("pickup", p)} onUpload={onUpload} /> : null}

          {!isNbfc && s === "in_transit_out" ? (
            <div className="auc-panel-body"><div className="auc-linkrow"><button type="button" className="auc-btn" disabled={busy} onClick={() => onAction("arrive", {})}>Truck arrived at workshop</button><span className="auc-hint">Then sign for each battery.</span></div></div>
          ) : null}
          {!isNbfc && s === "delivered" ? (<><header><span className="auc-panel-n">✓</span><h3>Receipt at workshop — battery by battery</h3></header><ReceiptForm key={`${lot.id}-out`} items={live} leg="out" busy={busy} onSubmit={(p) => onAction("confirm-receipt", p)} onUploadItem={(jobId, f) => onUpload(`item:${jobId}:out`, f)} /></>) : null}

          {!isNbfc && s === "received" ? (
            <div className="auc-panel-body">
              {lot.out.has_mismatch ? <p className="auc-hint" style={{ color: "var(--auc-warn)" }}>Receipt had discrepancies. Batteries marked missing will be closed out when work starts.</p> : null}
              <div className="auc-linkrow"><button type="button" className="auc-btn" disabled={busy} onClick={() => onAction("start-work", {})}>Start work</button></div>
            </div>
          ) : null}

          {!isNbfc && (s === "in_progress" || s === "ready" || s === "revision_pending") ? (
            <>
              <header><span className="auc-panel-n">🔧</span><h3>Workshop</h3></header>
              <div className="auc-panel-body">
                {s === "revision_pending" ? <p className="auc-hint" style={{ color: "var(--auc-warn)" }}>Revised quote of {formatINR(lot.revised_total)} is with {nbfcName}.</p> : null}
                <WorkPanel lot={lot} items={live} busy={busy} onUpdate={(job_id, patch) => onAction("update-item", { job_id, ...patch })} onReady={(job_id) => onAction("mark-ready", { job_id })} onRevise={(total, note) => onAction("revise-quote", { revised_total: total, message: note || undefined })} />
              </div>
            </>
          ) : null}

          {isNbfc && s === "revision_pending" ? (
            <div className="auc-panel-body">
              <p>iTarang asks to raise the approved quote from <b>{formatINR(lot.quote_approved_total)}</b> to <b>{formatINR(lot.revised_total)}</b>.{lot.revision_note ? ` "${lot.revision_note}"` : ""}</p>
              <div className="auc-linkrow" style={{ marginBlockStart: ".5rem" }}>
                <input className="auc-text" placeholder="message (optional)" value={revMsg} onChange={(e) => setRevMsg(e.target.value)} style={{ flex: "1 1 14rem" }} />
                <button type="button" className="auc-btn" disabled={busy} onClick={() => onAction("approve-revision", { message: revMsg || undefined })}>Approve {formatINR(lot.revised_total)}</button>
                <button type="button" className="auc-btn" data-variant="ghost" disabled={busy} onClick={() => onAction("reject-revision", { message: revMsg || undefined })}>Reject — keep {formatINR(lot.quote_approved_total)}</button>
              </div>
            </div>
          ) : null}

          {!isNbfc && s === "ready" ? <TransportForm title={`Dispatch back to ${nbfcName}`} submitLabel="Record return dispatch" ewayTarget="ret_eway_bill" busy={busy} onSubmit={(p) => onAction("dispatch", p)} onUpload={onUpload} /> : null}

          {isNbfc && s === "in_transit_return" ? (
            <div className="auc-panel-body"><div className="auc-linkrow"><button type="button" className="auc-btn" disabled={busy} onClick={() => onAction("arrive", {})}>Truck arrived</button><span className="auc-hint">Then sign for each battery.</span></div></div>
          ) : null}
          {isNbfc && s === "delivered_back" ? (<><header><span className="auc-panel-n">✓</span><h3>Receipt — battery by battery</h3></header><ReceiptForm key={`${lot.id}-ret`} items={live.filter((i) => i.status === "ready")} leg="return" busy={busy} onSubmit={(p) => onAction("confirm-receipt", p)} onUploadItem={(jobId, f) => onUpload(`item:${jobId}:return`, f)} /></>) : null}

          {cancellable ? (
            <div className="auc-panel-body">
              {showCancel ? (
                <div className="auc-linkrow">
                  <input className="auc-text" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="reason" style={{ maxWidth: "24rem" }} />
                  <button type="button" className="auc-btn" data-variant="danger" disabled={busy} onClick={() => onAction("cancel", { message: cancelReason || undefined })}>Cancel lot</button>
                  <button type="button" className="auc-btn" data-variant="ghost" onClick={() => setShowCancel(false)}>Keep</button>
                </div>
              ) : <button type="button" className="auc-btn" data-variant="ghost" disabled={busy} onClick={() => setShowCancel(true)}>Cancel this lot…</button>}
            </div>
          ) : null}
        </>
      ) : null}

      {!closed && !canAct ? <p className="auc-hint" style={{ padding: "0 1rem" }}>You can view this lot but your role cannot act on it.</p> : null}
      {!closed && canAct && lot.awaiting && lot.awaiting !== side && !cancellable && !(!isNbfc && ["in_progress", "ready", "revision_pending"].includes(s)) ? (
        <p className="auc-hint" style={{ padding: "0 1rem" }}>Waiting on {lot.awaiting === "admin" ? "iTarang" : nbfcName}.</p>
      ) : null}

      {/* ---------------- Batteries ---------------- */}
      {!(!isNbfc && ["requested", "in_progress", "ready", "revision_pending"].includes(s)) ? (
        <>
          <header><span className="auc-panel-n">🔋</span><h3>Batteries</h3></header>
          <div className="auc-panel-body" style={{ overflowX: "auto" }}>
            <table className="auc-table">
              <thead><tr><th>Serial</th><th>Model</th><th>SOH</th><th>Status</th><th>Where</th><th>Estimate</th><th>Actual</th><th>Receipt</th></tr></thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id}>
                    <td><span className="auc-pick-serial">{it.battery_serial}</span></td>
                    <td>{it.model ?? "—"}</td>
                    <td>{it.soh_pct != null ? `${it.soh_pct}%` : "—"}</td>
                    <td><span className="auc-chip" data-tone={it.status === "returned" || it.status === "ready" ? "live" : it.status === "declined" || it.status === "cancelled" ? "muted" : undefined}>{ITEM_LABEL[it.status] ?? it.status}</span>{it.decline_reason ? <div className="auc-subtle">{it.decline_reason}</div> : null}</td>
                    <td><CustodyChip custody={it.custody} /></td>
                    <td className="auc-num">{formatINR(it.estimated_cost)}</td>
                    <td className="auc-num">{formatINR(it.actual_cost)}</td>
                    <td className="auc-subtle">
                      {it.out_received_condition ? <div>workshop: {it.out_received_condition}{it.out_received_note ? ` — ${it.out_received_note}` : ""}</div> : null}
                      {it.ret_received_condition ? <div>NBFC: {it.ret_received_condition}{it.ret_received_note ? ` — ${it.ret_received_note}` : ""}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {/* ---------------- Thread ---------------- */}
      <header><span className="auc-panel-n">💬</span><h3>Timeline</h3></header>
      <div className="auc-panel-body">
        <LotTimeline events={lot.events ?? []} tenantName={lot.tenant_name} />
        {!closed && canAct ? (
          <div className="auc-linkrow" style={{ marginBlockStart: ".75rem" }}>
            <input className="auc-text" value={msg} onChange={(e) => setMsg(e.target.value)} placeholder={`Message ${isNbfc ? "iTarang" : nbfcName}…`} style={{ flex: "1 1 20rem" }} onKeyDown={(e) => { if (e.key === "Enter" && msg.trim()) { void onAction("message", { message: msg.trim() }).then(() => setMsg("")); } }} />
            <button type="button" className="auc-btn" data-variant="ghost" disabled={busy || !msg.trim()} onClick={() => void onAction("message", { message: msg.trim() }).then(() => setMsg(""))}>Send</button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
