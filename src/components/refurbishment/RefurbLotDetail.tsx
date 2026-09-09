"use client";

/**
 * E-292 — one refurbishment lot, seen from any of its three ends (v3).
 *
 * The NBFC console, the admin desk and the refurbisher portal render the SAME
 * component, told which side it is on. The server already redacted the lot
 * for that side (getLot(viewer)) — the NBFC payload carries no refurbisher,
 * the refurbisher payload carries no money — so this component only decides
 * which action panel to show, driven by `lot.status` + `side`:
 *
 *   status              nbfc                          admin                                   refurbisher
 *   requested           cancel · message              review (decline) + mark reviewed        —
 *   reviewed/countered  cancel · message              estimate                                —
 *   estimated           accept / counter              cancel · message                        —
 *   agreed              cancel · message              PI form (PDF, amount, advance %, bank)  —
 *   pi_sent             accept PI                     re-send PI · cancel                     —
 *   pi_accepted         record UTR / dispatch         confirm advance / pickup                —
 *   advance_recorded    dispatch (nbfc_ships)         pickup (itarang_pickup)                 —
 *   in_transit_out      message                       mark arrived · receipt per battery      —
 *   received            message                       assign refurbisher                      —
 *   at_refurbisher      message                       re-assign · (override) start work       start work
 *   in_progress         message                       (override) cost per battery             cost per battery
 *   costed              message                       margin + final bill → mark ready        re-cost until frozen
 *   ready               message                       return dispatch                         return dispatch
 *   in_transit_return   mark arrived                  message                                 message
 *   delivered_back      receipt per battery           message                                 —
 *   balance_due         record UTR                    confirm balance                         —
 *   settled             choose redeploy / auction     message                                 —
 *   closed/cancelled    (read only)
 */
import { useMemo, useState } from "react";
import { formatINR } from "@/components/auction/AuctionPrimitives";
import { CUSTODY_LABEL, LOT_STATUS_LABEL, type Custody } from "@/lib/nbfc/recovery/refurbishment-lot-status";

// ---------------------------------------------------------------------------
// View types — the JSON shapes /api/.../lots/[id] returns
// ---------------------------------------------------------------------------
export interface AccessoryView { key: string; label: string; unit_cost: number; included: boolean }
export interface ChecklistView { key: string; label: string; done: boolean; note?: string | null }
export interface PartView { label: string; qty: number; unit_cost: number }
export interface LotItemView {
  id: string;
  battery_id: string;
  battery_serial: string | null;
  model: string | null;
  capacity: string | null;
  condition_grade: string | null;
  soh_pct: number | null;
  health_pct: number | null;
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
  refurbisher_cost: number | null;
  refurbisher_parts: PartView[];
  refurbisher_note: string | null;
  costed_at: string | null;
  final_cost: number | null;
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
  reference: string | null;
  recorded_at: string | null;
  confirmed_at: string | null;
  /** E-293: NBFC-uploaded payment slips (image / PDF proxy paths). */
  proof_urls?: string[];
}
export interface PiBankView { account_name?: string | null; account_number?: string | null; ifsc?: string | null; bank_name?: string | null; upi?: string | null }
export interface PiViewT {
  number: string | null;
  url: string | null;
  amount: number | null;
  advance_pct: number | null;
  advance_amount: number | null;
  bank_details: PiBankView | null;
  note: string | null;
  sent_at: string | null;
  accepted_at: string | null;
  acceptance_note: string | null;
}
export interface LotEventView {
  id: string;
  seq: number;
  party: "nbfc" | "admin" | "refurbisher" | "system";
  kind: string;
  message: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}
export type Side = "nbfc" | "admin" | "refurbisher";
export interface LotView {
  id: string;
  ref_code: string;
  tenant_id: string;
  tenant_name: string | null;
  status: string;
  awaiting: Side | null;
  battery_count: number;
  note: string | null;
  current_round: number;
  reviewed_at: string | null;
  expected_receipt_date: string | null;
  expected_return_date: string | null;
  estimated_labour_total: number | null;
  estimated_accessories_total: number | null;
  estimated_total: number | null;
  proposal_note: string | null;
  counter: { total: number | null; advance_pct: number | null; receipt_date: string | null; return_date: string | null; message: string | null };
  agreed_at: string | null;
  pickup_mode: "nbfc_ships" | "itarang_pickup";
  pickup_address: string | null;
  workshop_address: string | null;
  scheduled_pickup_date: string | null;
  quote_approved_total: number | null;
  quote_approved_at: string | null;
  pi: PiViewT;
  advance_pct: number;
  advance: MoneyView;
  refurbisher: { id: string; name: string; contact_name: string | null; phone: string | null; email: string | null; city: string | null } | null;
  assigned_at: string | null;
  refurbisher_note: string | null;
  refurbisher_total: number | null;
  costed_at: string | null;
  margin: { pct: number | null; amount: number | null };
  final_total: number | null;
  final_sent_at: string | null;
  balance: MoneyView;
  settled_at: string | null;
  close_outcome: "redeploy" | "auction" | null;
  closed_at: string | null;
  close_note: string | null;
  out: LegView;
  ret: LegView;
  work_started_at: string | null;
  cancel_reason: string | null;
  cancelled_by_party: string | null;
  created_at: string;
  items?: LotItemView[];
  events?: LotEventView[];
  actual_total?: number | null;
}

export type LotAction =
  // nbfc
  | "accept" | "counter" | "cancel" | "accept-pi" | "record-payment" | "dispatch" | "arrive" | "confirm-receipt" | "close" | "message"
  // admin
  | "review" | "estimate" | "send-pi" | "confirm-payment" | "pickup" | "assign" | "start-work" | "update-item" | "cost-item" | "set-final-cost" | "mark-ready";

export type PhotoTarget =
  | "out_dispatch" | "out_receipt" | "ret_dispatch" | "ret_receipt" | "out_eway_bill" | "ret_eway_bill" | "pi_document"
  | "advance_slip" | "balance_slip"
  | `item:${string}:${"out" | "return"}`;

export interface RefurbisherOption { id: string; name: string; city?: string | null; is_active?: boolean; open_lots?: number }

interface Props {
  lot: LotView;
  side: Side;
  canAct: boolean;
  busy: boolean;
  /** Resolves with the updated lot (or void). */
  onAction: (action: LotAction, payload: Record<string, unknown>) => Promise<unknown>;
  /** Uploads and resolves with the stored relative paths. */
  onUpload: (target: PhotoTarget, files: FileList) => Promise<string[]>;
  /** Admin only: the refurbisher directory for the assign dropdown. */
  refurbishers?: RefurbisherOption[];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const dmy = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—");
const dmyt = (d: string | null | undefined) => (d ? new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const money2 = (n: number) => Math.round(n * 100) / 100;

export const FINISHED = ["settled", "closed", "cancelled"];
const CANCELLABLE = ["requested", "reviewed", "estimated", "countered", "agreed", "pi_sent", "pi_accepted", "advance_recorded"];

export function lotTone(status: string): "live" | "warn" | "muted" | undefined {
  if (status === "settled" || status === "closed") return "live";
  if (status === "cancelled") return "muted";
  if (["requested", "reviewed", "estimated", "countered", "agreed", "pi_sent", "pi_accepted", "in_transit_out", "in_transit_return", "delivered_back", "balance_due", "costed"].includes(status)) return "warn";
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
  const tone = custody === "back_with_nbfc" ? "live" : custody === "unknown_lost" ? "muted" : custody.startsWith("in_transit") ? "warn" : undefined;
  return <span className="auc-chip" data-tone={tone}>{CUSTODY_LABEL[custody] ?? custody}</span>;
}

const ITEM_LABEL: Record<string, string> = { requested: "awaiting", declined: "declined", at_refurbisher: "at refurbisher", in_progress: "in workshop", ready: "ready", returned: "returned", cancelled: "cancelled" };

const accTotal = (a: AccessoryView[]) => a.filter((x) => x.included).reduce((s, x) => s + x.unit_cost, 0);
const partsTotal = (p: PartView[]) => p.reduce((s, x) => s + (Number(x.qty) || 0) * (Number(x.unit_cost) || 0), 0);

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

/** Is this stored document a PDF (vs a photo/scan)? Keys end in the real extension (see refurb-photo-upload.ts). */
function isPdfUrl(u: string | null | undefined): boolean {
  return !!u && /\.pdf(\?|#|$)/i.test(u);
}

/**
 * E-292 — inline preview of a lot document (proforma invoice, e-way bill).
 * A PDF renders in a same-origin iframe (CSP frame-src 'self'; the /api/files
 * proxy serves Content-Disposition: inline); an image scan renders as a picture.
 * Either way the reader sees the document on the page instead of a bare chip.
 */
function DocPreview({ url, title, height = "28rem" }: { url: string | null | undefined; title: string; height?: string }) {
  if (!url) return null;
  const pdf = isPdfUrl(url);
  return (
    <div style={{ marginBlockStart: ".5rem" }}>
      <div className="auc-linkrow" style={{ justifyContent: "space-between", marginBlockEnd: ".375rem" }}>
        <span className="auc-subtle">{title} · {pdf ? "PDF" : "image"}</span>
        <a href={url} target="_blank" rel="noreferrer" className="auc-chip">open in new tab ↗</a>
      </div>
      {pdf ? (
        <iframe src={url} title={title} style={{ width: "100%", height, border: "1px solid var(--auc-rule)", borderRadius: 8, background: "#fff" }} />
      ) : (
        <a href={url} target="_blank" rel="noreferrer" style={{ display: "block" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt={title} style={{ display: "block", width: "100%", maxHeight: height, objectFit: "contain", border: "1px solid var(--auc-rule)", borderRadius: 8, background: "#fff" }} />
        </a>
      )}
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

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------
const KIND_LABEL: Record<string, string> = {
  requested: "sent the batch",
  item_declined: "declined a battery",
  reviewed: "reviewed the batteries",
  estimated: "sent an estimate",
  countered: "countered",
  accepted: "accepted the estimate",
  cancelled: "cancelled the lot",
  pi_sent: "sent the proforma invoice",
  pi_accepted: "accepted the proforma invoice",
  advance_recorded: "recorded the advance (bank transfer)",
  advance_confirmed: "marked the advance received",
  dispatched_out: "dispatched to iTarang",
  picked_up: "picked up the batteries",
  arrived_out: "truck arrived at iTarang",
  received_out: "iTarang signed for the batteries",
  refurbisher_assigned: "assigned a refurbisher",
  work_started: "started work",
  item_costed: "costed a battery",
  all_costed: "every battery costed",
  final_bill_sent: "sent the final bill",
  item_ready: "marked a battery ready",
  dispatched_return: "dispatched back to the NBFC",
  arrived_return: "truck arrived at the NBFC",
  received_return: "signed for the returned batteries",
  balance_recorded: "recorded the balance (bank transfer)",
  balance_confirmed: "marked the balance received",
  settled: "settled",
  closed: "closed the lot",
  message: "wrote",
  // legacy v2 kinds still on old rows
  proposed: "sent a quote",
  pickup_scheduled: "pickup scheduled",
  revision_proposed: "sent a revised quote",
  revision_approved: "approved the revised quote",
  revision_rejected: "rejected the revised quote",
};

function EventPayload({ ev }: { ev: LotEventView }) {
  const p = ev.payload ?? {};
  const n = (k: string) => (p[k] == null ? null : Number(p[k]));
  switch (ev.kind) {
    case "requested":
      return <span className="auc-subtle">{(p.serials as string[] | undefined)?.join(", ")}{p.resubmitted_from_lot ? " · resubmission" : ""}</span>;
    case "item_declined":
    case "item_ready":
      return <span className="auc-subtle">{String(p.serial ?? "")}{n("final_cost") != null ? ` · final ${formatINR(n("final_cost"))}` : ""}</span>;
    case "reviewed":
      return <span className="auc-subtle">{Number(p.declined) ? `${p.declined} declined · ` : ""}{String(p.battery_count ?? "")} going ahead</span>;
    case "estimated":
    case "proposed":
      return (
        <span className="auc-subtle">
          round {String(p.round)} · {p.pickup_mode === "itarang_pickup" ? `iTarang picks up${p.scheduled_pickup_date ? ` ${dmy(p.scheduled_pickup_date as string)}` : ""}` : `receive by ${dmy(p.expected_receipt_date as string)}`} · return by {dmy(p.expected_return_date as string)} · estimate {formatINR(n("estimated_total"))}{n("advance_pct") ? ` · advance ${p.advance_pct}% (${formatINR(n("advance_amount"))})` : ""}
        </span>
      );
    case "accepted":
      return <span className="auc-subtle">agreed {formatINR(n("agreed_total") ?? n("quote_approved_total"))}{n("advance_pct") ? ` · advance ${p.advance_pct}%` : ""}</span>;
    case "countered":
      return <span className="auc-subtle">{[n("counter_total") != null ? `cost ${formatINR(n("counter_total"))}` : null, n("counter_advance_pct") != null ? `advance ${p.counter_advance_pct}%` : null, p.requested_receipt_date ? `receive ${dmy(p.requested_receipt_date as string)}` : null, p.requested_return_date ? `return ${dmy(p.requested_return_date as string)}` : null].filter(Boolean).join(" · ")}</span>;
    case "pi_sent":
      return <span className="auc-subtle">{String(p.pi_number ?? "")} · {formatINR(n("pi_amount"))}{n("advance_pct") ? ` · advance ${p.advance_pct}% (${formatINR(n("advance_amount"))})` : " · no advance"}{p.resent ? " · re-sent" : ""}</span>;
    case "pi_accepted":
      return <span className="auc-subtle">{formatINR(n("pi_amount"))}{p.advance_required ? ` · advance ${formatINR(n("advance_amount"))} due` : " · no advance, batteries may move"}</span>;
    case "advance_recorded":
    case "balance_recorded":
    case "advance_confirmed":
    case "balance_confirmed":
    case "settled":
      return <span className="auc-subtle">{formatINR(n("amount") ?? n("final_total"))}{p.reference ? ` · ref ${p.reference}` : ""}</span>;
    case "dispatched_out":
    case "picked_up":
    case "dispatched_return":
      return <span className="auc-subtle">{[p.carrier, p.vehicle_no, p.docket_no ? `docket ${p.docket_no}` : null, p.eway_bill_no ? `e-way ${p.eway_bill_no}` : null].filter(Boolean).join(" · ")} · {dmy(p.dispatched_on as string)}</span>;
    case "received_out":
    case "received_return":
      return <span className="auc-subtle">{String(p.received ?? 0)} received{Number(p.damaged) ? `, ${p.damaged} damaged` : ""}{Number(p.missing) ? `, ${p.missing} missing` : ""}{n("final_total") != null ? ` · final ${formatINR(n("final_total"))}, balance ${formatINR(n("balance_amount"))}` : ""}</span>;
    case "refurbisher_assigned":
      return <span className="auc-subtle">{String(p.refurbisher_name ?? "")} · {String(p.batteries ?? "")} batteries{Number(p.missing_closed) ? ` · ${p.missing_closed} missing closed out` : ""}{p.reassigned ? " · re-assigned" : ""}</span>;
    case "item_costed":
      return <span className="auc-subtle">{String(p.serial ?? "")} · {formatINR(n("base"))}</span>;
    case "all_costed":
      return <span className="auc-subtle">{formatINR(n("refurbisher_total"))} for {String(p.batteries ?? "")} batteries</span>;
    case "final_bill_sent":
      // The NBFC's copy carries only final_total (server-side redaction).
      if (p.billed_from === "pi" && n("margin_amount") != null)
        return <span className="auc-subtle">as per accepted PI <b>{formatINR(n("final_total"))}</b> · balance {formatINR(n("balance_expected"))} · internal: refurbisher {formatINR(n("refurbisher_total"))}, margin {formatINR(n("margin_amount"))}</span>;
      return n("margin_amount") != null
        ? <span className="auc-subtle">{formatINR(n("refurbisher_total"))} + margin {formatINR(n("margin_amount"))} = <b>{formatINR(n("final_total"))}</b></span>
        : <span className="auc-subtle">final bill <b>{formatINR(n("final_total"))}</b>{n("balance_expected") != null ? ` · balance ${formatINR(n("balance_expected"))}` : ""}</span>;
    case "closed":
      return <span className="auc-subtle">{p.outcome === "redeploy" ? "redeploy — iTarang helps" : "auction"}</span>;
    default:
      return null;
  }
}

export function LotTimeline({ events, tenantName, refurbisherName, side }: { events: LotEventView[]; tenantName: string | null; refurbisherName?: string | null; side: Side }) {
  const who = (party: LotEventView["party"]) =>
    party === "admin" ? "iTarang" : party === "nbfc" ? (tenantName ?? "NBFC") : party === "refurbisher" ? (side === "nbfc" ? "iTarang" : (refurbisherName ?? "Refurbisher")) : "System";
  if (!events.length) return <p className="auc-subtle">Nothing yet.</p>;
  return (
    <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: ".5rem" }}>
      {[...events].reverse().map((ev) => (
        <li key={ev.id} style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: ".75rem", alignItems: "start" }}>
          <span className="auc-chip" data-tone={ev.party === "admin" ? undefined : ev.party === "nbfc" ? "warn" : ev.party === "refurbisher" ? "live" : "muted"} style={{ minWidth: "5.5rem", justifyContent: "center" }}>{who(ev.party)}</span>
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
            <label>E-way bill no. <span className="auc-subtle">(optional)</span></label>
            <input className="auc-text" value={eway} onChange={(e) => setEway(e.target.value.replace(/\D/g, "").slice(0, 12))} placeholder="12-digit EWB" inputMode="numeric" />
          </div>
          <div className="auc-field">
            <label>E-way bill document <span className="auc-subtle">(optional)</span></label>
            <div className="auc-linkrow">
              <FilePick label={ewayUrl ? "Replace" : "Upload PDF / photo"} accept="application/pdf,image/*" disabled={busy} onPick={(f) => void onUpload(ewayTarget, f).then((p) => setEwayUrl(p[0] ?? null))} />
              {ewayUrl ? <a href={ewayUrl} target="_blank" rel="noreferrer" className="auc-chip">attached</a> : <span className="auc-hint">Attach it if the move needs one.</span>}
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
          {leg === "out" ? "Confirm receipt at iTarang" : "Confirm receipt — batteries are back"}
        </button>
      </div>
    </div>
  );
}

function EstimateForm({ lot, items, busy, onSubmit }: { lot: LotView; items: LotItemView[]; busy: boolean; onSubmit: (p: Record<string, unknown>) => Promise<unknown> }) {
  const c = lot.counter;
  const [receipt, setReceipt] = useState(c.receipt_date?.slice(0, 10) ?? lot.expected_receipt_date?.slice(0, 10) ?? plusDays(3));
  const [ret, setRet] = useState(c.return_date?.slice(0, 10) ?? lot.expected_return_date?.slice(0, 10) ?? plusDays(14));
  const [mode, setMode] = useState<"nbfc_ships" | "itarang_pickup">(lot.pickup_mode ?? "nbfc_ships");
  const [pickupDate, setPickupDate] = useState(lot.scheduled_pickup_date?.slice(0, 10) ?? "");
  const [pickupAddr, setPickupAddr] = useState(lot.pickup_address ?? "");
  const [workshopAddr, setWorkshopAddr] = useState(lot.workshop_address ?? "");
  const [advPct, setAdvPct] = useState(String(c.advance_pct ?? lot.advance_pct ?? 0));
  const [est, setEst] = useState<Record<string, string>>(() => Object.fromEntries(items.map((i) => [i.id, i.estimated_cost != null ? String(i.estimated_cost) : ""])));
  const [acc, setAcc] = useState<Record<string, AccessoryView[]>>(() => Object.fromEntries(items.map((i) => [i.id, i.accessories])));
  const [note, setNote] = useState("");
  const labour = items.reduce((s, i) => s + (Number(est[i.id]) || 0), 0);
  const accessories = items.reduce((s, i) => s + accTotal(acc[i.id] ?? []), 0);
  const total = labour + accessories;
  const pct = Math.min(100, Math.max(0, Number(advPct) || 0));
  const ready = items.every((i) => est[i.id] !== "" && Number.isFinite(Number(est[i.id]))) && receipt && ret && ret >= receipt;
  return (
    <div className="auc-panel-body">
      {lot.status === "countered" ? (
        <p className="auc-hint" style={{ color: "var(--auc-warn)" }}>
          {lot.tenant_name ?? "The NBFC"} countered: {[c.total != null ? `cost ${formatINR(c.total)}` : null, c.advance_pct != null ? `advance ${c.advance_pct}%` : null, c.receipt_date ? `receive ${dmy(c.receipt_date)}` : null, c.return_date ? `return ${dmy(c.return_date)}` : null].filter(Boolean).join(" · ") || "see message"}{c.message ? ` — "${c.message}"` : ""}
        </p>
      ) : null}
      <span className="auc-label">Logistics</span>
      <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBlockStart: ".375rem" }}>
        <label style={{ display: "flex", gap: ".35rem", alignItems: "center" }}><input type="radio" checked={mode === "nbfc_ships"} onChange={() => setMode("nbfc_ships")} /> NBFC ships to iTarang</label>
        <label style={{ display: "flex", gap: ".35rem", alignItems: "center" }}><input type="radio" checked={mode === "itarang_pickup"} onChange={() => setMode("itarang_pickup")} /> iTarang picks up</label>
      </div>
      <div className="auc-dl" style={{ gap: ".75rem", marginBlockStart: ".5rem" }}>
        {mode === "itarang_pickup" ? (
          <>
            <div className="auc-field"><label>Planned pickup date <span className="auc-subtle">(optional)</span></label><input className="auc-text" type="date" value={pickupDate} onChange={(e) => setPickupDate(e.target.value)} /></div>
            <div className="auc-field"><label>Pickup address (NBFC)</label><input className="auc-text" value={pickupAddr} onChange={(e) => setPickupAddr(e.target.value)} placeholder="warehouse / godown address" /></div>
          </>
        ) : null}
        <div className="auc-field"><label>{mode === "itarang_pickup" ? "Expect at iTarang by" : "NBFC should ship by"}</label><input className="auc-text" type="date" value={receipt} onChange={(e) => setReceipt(e.target.value)} /></div>
        <div className="auc-field"><label>Return to NBFC by</label><input className="auc-text" type="date" value={ret} min={receipt} onChange={(e) => setRet(e.target.value)} /></div>
        <div className="auc-field"><label>Receiving address (iTarang)</label><input className="auc-text" value={workshopAddr} onChange={(e) => setWorkshopAddr(e.target.value)} placeholder="where the batteries go" /></div>
      </div>

      <span className="auc-label" style={{ display: "block", marginBlockStart: "1rem" }}>Costing</span>
      <div style={{ overflowX: "auto", marginBlockStart: ".375rem" }}>
        <table className="auc-table">
          <thead><tr><th>Battery</th><th>Health</th><th>Labour estimate (₹)</th><th>New accessories</th><th>Line total</th></tr></thead>
          <tbody>
            {items.map((it) => {
              const a = acc[it.id] ?? [];
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
                  <td className="auc-num">{formatINR((Number(est[it.id]) || 0) + accTotal(a))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="auc-ledger" style={{ marginBlockStart: ".75rem", maxWidth: "30rem" }}>
        <div className="auc-ledger-row"><span>Labour</span><b>{formatINR(labour)}</b></div>
        <div className="auc-ledger-row"><span>Accessories (new — charger, harness, SOC meter)</span><b>{formatINR(accessories)}</b></div>
        <div className="auc-ledger-row" data-total="true"><span>Estimate</span><b>{formatINR(total)}</b></div>
        <div className="auc-ledger-row">
          <span style={{ display: "flex", gap: ".5rem", alignItems: "center" }}>
            Advance <input className="auc-text" data-numeric="true" inputMode="numeric" style={{ width: "4rem" }} value={advPct} onChange={(e) => setAdvPct(e.target.value.replace(/[^\d.]/g, ""))} /> %
          </span>
          <b>{formatINR(Math.round((total * pct) / 100))}</b>
        </div>
      </div>
      <span className="auc-hint">The NBFC accepts this or counters on cost, timeline or advance. Once agreed you send a proforma invoice; the advance, if any, is paid into iTarang&rsquo;s bank before the batteries move.</span>
      <div className="auc-field" style={{ marginBlockStart: ".5rem" }}><label>Note to the NBFC</label><textarea className="auc-text" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What the estimate covers, what could change it." /></div>
      <div className="auc-linkrow" style={{ marginBlockStart: ".75rem" }}>
        <button type="button" className="auc-btn" disabled={busy || !ready} onClick={() => onSubmit({
          expected_receipt_date: receipt, expected_return_date: ret,
          pickup_mode: mode, scheduled_pickup_date: mode === "itarang_pickup" && pickupDate ? pickupDate : null,
          pickup_address: pickupAddr || null, workshop_address: workshopAddr || null, advance_pct: pct,
          items: items.map((i) => ({ job_id: i.id, estimated_cost: Number(est[i.id]), accessories: acc[i.id] })),
          message: note || undefined,
        })}>
          {lot.current_round > 0 ? "Send revised estimate" : "Send estimate"}
        </button>
      </div>
    </div>
  );
}

function ReviewPanel({ lot, items, busy, onDecline, onReviewed }: { lot: LotView; items: LotItemView[]; busy: boolean; onDecline: (jobId: string, reason: string) => Promise<unknown>; onReviewed: () => Promise<unknown> }) {
  const [declining, setDeclining] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const live = items.filter((i) => i.status !== "declined" && i.status !== "cancelled");
  return (
    <div className="auc-panel-body">
      <span className="auc-hint">Check each battery&rsquo;s recovery details. Decline any you will not take (it goes back to the NBFC&rsquo;s register as inspected, with your reason); then mark the lot reviewed to move on to the estimate.</span>
      <div style={{ overflowX: "auto", marginBlockStart: ".5rem" }}>
        <table className="auc-table">
          <thead><tr><th>Battery</th><th>Model</th><th>Health</th><th>Grade</th><th>Photos</th><th /></tr></thead>
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
      {lot.status === "requested" && live.length ? (
        <div className="auc-linkrow" style={{ marginBlockStart: ".75rem" }}>
          <button type="button" className="auc-btn" disabled={busy} onClick={() => void onReviewed()}>Mark reviewed — {live.length} {live.length === 1 ? "battery" : "batteries"} go ahead</button>
        </div>
      ) : null}
    </div>
  );
}

function CounterForm({ lot, busy, onSubmit }: { lot: LotView; busy: boolean; onSubmit: (p: Record<string, unknown>) => Promise<unknown> }) {
  const [total, setTotal] = useState("");
  const [adv, setAdv] = useState("");
  const [receipt, setReceipt] = useState("");
  const [ret, setRet] = useState("");
  const [msg, setMsg] = useState("");
  const any = total || adv || receipt || ret || msg.trim();
  return (
    <div style={{ marginBlockStart: ".75rem" }}>
      <div className="auc-dl" style={{ gap: ".75rem" }}>
        <div className="auc-field"><label>Cost you would accept (₹)</label><input className="auc-text" data-numeric="true" inputMode="numeric" placeholder={String(lot.estimated_total ?? "")} value={total} onChange={(e) => setTotal(e.target.value.replace(/[^\d.]/g, ""))} /></div>
        <div className="auc-field"><label>Advance you would accept (%)</label><input className="auc-text" data-numeric="true" inputMode="numeric" placeholder={String(lot.advance_pct)} value={adv} onChange={(e) => setAdv(e.target.value.replace(/[^\d.]/g, ""))} /></div>
        <div className="auc-field"><label>Receipt / pickup date you need</label><input className="auc-text" type="date" value={receipt} onChange={(e) => setReceipt(e.target.value)} /></div>
        <div className="auc-field"><label>Return date you need</label><input className="auc-text" type="date" value={ret} onChange={(e) => setRet(e.target.value)} /></div>
      </div>
      <div className="auc-field" style={{ marginBlockStart: ".5rem" }}><label>Message</label><textarea className="auc-text" rows={2} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="What should change and why." /></div>
      <div className="auc-linkrow" style={{ marginBlockStart: ".5rem" }}>
        <button type="button" className="auc-btn" disabled={busy || !any} onClick={() => onSubmit({ message: msg || undefined, counter_total: total ? Number(total) : null, counter_advance_pct: adv ? Number(adv) : null, requested_receipt_date: receipt || null, requested_return_date: ret || null })}>Send counter to iTarang</button>
      </div>
    </div>
  );
}

function PiForm({ lot, busy, onSubmit, onUpload }: { lot: LotView; busy: boolean; onSubmit: (p: Record<string, unknown>) => Promise<unknown>; onUpload: (target: PhotoTarget, files: FileList) => Promise<string[]> }) {
  const [url, setUrl] = useState<string | null>(lot.pi.url);
  const [number, setNumber] = useState(lot.pi.number ?? "");
  const [amount, setAmount] = useState(String(lot.pi.amount ?? lot.quote_approved_total ?? lot.estimated_total ?? ""));
  const [adv, setAdv] = useState(String(lot.pi.advance_pct ?? lot.advance_pct ?? 0));
  const b = lot.pi.bank_details ?? {};
  const [accName, setAccName] = useState(b.account_name ?? "");
  const [accNo, setAccNo] = useState(b.account_number ?? "");
  const [ifsc, setIfsc] = useState(b.ifsc ?? "");
  const [bank, setBank] = useState(b.bank_name ?? "");
  const [upi, setUpi] = useState(b.upi ?? "");
  const [note, setNote] = useState("");
  const amt = Number(amount) || 0;
  const pct = Math.min(100, Math.max(0, Number(adv) || 0));
  const bankOk = (accNo.trim() && ifsc.trim()) || upi.trim();
  return (
    <div className="auc-panel-body">
      <span className="auc-hint">Upload the proforma invoice PDF and state its amount, the advance percentage and the account the NBFC pays into. The NBFC accepts it on its screen; the advance is paid straight into that account and recorded here.</span>
      <div className="auc-dl" style={{ gap: ".75rem", marginBlockStart: ".5rem" }}>
        <div className="auc-field">
          <label>Proforma invoice (PDF)</label>
          <div className="auc-linkrow">
            <FilePick label={url ? "Replace PDF" : "Upload PDF"} accept="application/pdf,image/*" disabled={busy} onPick={(f) => void onUpload("pi_document", f).then((p) => setUrl(p[0] ?? null))} />
            {url ? <a href={url} target="_blank" rel="noreferrer" className="auc-chip" data-tone="live">attached · {isPdfUrl(url) ? "PDF" : "image"}</a> : <span className="auc-hint">required</span>}
          </div>
          <DocPreview url={url} title="Proforma invoice" height="22rem" />
        </div>
        <div className="auc-field"><label>PI number</label><input className="auc-text" value={number} onChange={(e) => setNumber(e.target.value)} placeholder={`PI-${lot.ref_code}`} /></div>
        <div className="auc-field"><label>PI amount (₹)</label><input className="auc-text" data-numeric="true" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} /></div>
        <div className="auc-field"><label>Advance (%)</label><input className="auc-text" data-numeric="true" inputMode="numeric" value={adv} onChange={(e) => setAdv(e.target.value.replace(/[^\d.]/g, ""))} /></div>
      </div>
      <span className="auc-label" style={{ display: "block", marginBlockStart: ".75rem" }}>Bank details (iTarang)</span>
      <div className="auc-dl" style={{ gap: ".75rem", marginBlockStart: ".375rem" }}>
        <div className="auc-field"><label>Account name</label><input className="auc-text" value={accName} onChange={(e) => setAccName(e.target.value)} /></div>
        <div className="auc-field"><label>Account number</label><input className="auc-text" value={accNo} onChange={(e) => setAccNo(e.target.value)} /></div>
        <div className="auc-field"><label>IFSC</label><input className="auc-text" value={ifsc} onChange={(e) => setIfsc(e.target.value.toUpperCase())} /></div>
        <div className="auc-field"><label>Bank</label><input className="auc-text" value={bank} onChange={(e) => setBank(e.target.value)} /></div>
        <div className="auc-field"><label>UPI id <span className="auc-subtle">(alternative)</span></label><input className="auc-text" value={upi} onChange={(e) => setUpi(e.target.value)} /></div>
      </div>
      <div className="auc-ledger" style={{ marginBlockStart: ".75rem", maxWidth: "30rem" }}>
        <div className="auc-ledger-row"><span>Agreed estimate</span><b>{formatINR(lot.quote_approved_total ?? lot.estimated_total)}</b></div>
        <div className="auc-ledger-row" data-total="true"><span>PI amount</span><b>{formatINR(amt)}</b></div>
        <div className="auc-ledger-row"><span>Advance {pct}%</span><b>{formatINR(money2((amt * pct) / 100))}</b></div>
      </div>
      <div className="auc-field" style={{ marginBlockStart: ".5rem" }}><label>Note to the NBFC</label><textarea className="auc-text" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></div>
      <div className="auc-linkrow" style={{ marginBlockStart: ".75rem" }}>
        <button type="button" className="auc-btn" disabled={busy || !url || !(amt > 0) || !bankOk} onClick={() => onSubmit({ pi_url: url, pi_number: number || null, pi_amount: amt, pi_advance_pct: pct, bank_details: { account_name: accName || null, account_number: accNo || null, ifsc: ifsc || null, bank_name: bank || null, upi: upi || null }, message: note || undefined })}>
          {lot.pi.sent_at ? "Re-send proforma invoice" : "Send proforma invoice"}
        </button>
      </div>
    </div>
  );
}

function PiCard({ lot }: { lot: LotView }) {
  const p = lot.pi;
  const b = p.bank_details ?? {};
  if (!p.sent_at) return null;
  return (
    <div className="auc-ledger" style={{ maxWidth: "44rem" }}>
      <div className="auc-ledger-row"><span>Proforma invoice</span><b>{p.number ?? "—"} {p.url ? <a href={p.url} target="_blank" rel="noreferrer" className="auc-chip">{isPdfUrl(p.url) ? "PDF" : "image"}</a> : null}</b></div>
      {p.url ? (
        <div className="auc-ledger-row" style={{ display: "block" }}>
          <DocPreview url={p.url} title={`Proforma invoice ${p.number ?? ""}`.trim()} />
        </div>
      ) : (
        <div className="auc-ledger-row"><span>Document</span><span className="auc-chip" data-tone="warn">not attached</span></div>
      )}
      <div className="auc-ledger-row" data-total="true"><span>Amount</span><b>{formatINR(p.amount)}</b></div>
      <div className="auc-ledger-row"><span>Advance {p.advance_pct ?? 0}%</span><b>{(p.advance_pct ?? 0) > 0 ? formatINR(p.advance_amount) : "none"}</b></div>
      {b.account_number || b.upi ? (
        <div className="auc-ledger-row"><span>Pay into</span><b style={{ fontWeight: 500 }}>{b.account_number ? `${b.account_name ? `${b.account_name} · ` : ""}A/c ${b.account_number}${b.ifsc ? ` · IFSC ${b.ifsc}` : ""}${b.bank_name ? ` (${b.bank_name})` : ""}` : ""}{b.upi ? `${b.account_number ? " · " : ""}UPI ${b.upi}` : ""}</b></div>
      ) : null}
      {p.note ? <div className="auc-ledger-row"><span>Note</span><span style={{ whiteSpace: "pre-wrap" }}>{p.note}</span></div> : null}
      <div className="auc-ledger-row"><span>Sent {dmy(p.sent_at)}</span><span className="auc-chip" data-tone={p.accepted_at ? "live" : "warn"}>{p.accepted_at ? `accepted ${dmy(p.accepted_at)}` : "awaiting acceptance"}</span></div>
    </div>
  );
}

function PayPanel({ lot, leg, side, busy, onAction, onUpload }: { lot: LotView; leg: "advance" | "balance"; side: Side; busy: boolean; onAction: Props["onAction"]; onUpload?: (target: PhotoTarget, files: FileList) => Promise<string[]> }) {
  const m = leg === "advance" ? lot.advance : lot.balance;
  const [ref, setRef] = useState("");
  const [note, setNote] = useState("");
  // E-293: slips uploaded in this session land here straight away (the upload
  // route appends them server-side; the lot re-fetch catches up on the next action).
  const [slips, setSlips] = useState<string[]>(m.proof_urls ?? []);
  const label = leg === "advance" ? `Advance (${lot.advance_pct}%)` : "Balance";
  const b = lot.pi.bank_details ?? {};
  const slipTarget: PhotoTarget = leg === "advance" ? "advance_slip" : "balance_slip";
  const slipRequired = leg === "balance";
  const batteriesStillAway = leg === "balance" && ["costed", "ready", "in_transit_return"].includes(lot.status);
  return (
    <div className="auc-panel-body">
      <div className="auc-ledger" style={{ maxWidth: "30rem" }}>
        {leg === "balance" ? (
          <>
            <div className="auc-ledger-row"><span>Final bill</span><b>{formatINR(lot.final_total)}</b></div>
            <div className="auc-ledger-row"><span>Advance received</span><b>− {formatINR(lot.advance.status === "confirmed" ? lot.advance.amount : 0)}</b></div>
          </>
        ) : (
          <div className="auc-ledger-row"><span>Proforma invoice</span><b>{formatINR(lot.pi.amount)}</b></div>
        )}
        <div className="auc-ledger-row" data-total="true"><span>{label} due</span><b>{formatINR(m.amount)}</b></div>
        {b.account_number || b.upi ? <div className="auc-ledger-row"><span>Pay into</span><span>{b.account_number ? `A/c ${b.account_number}${b.ifsc ? ` · ${b.ifsc}` : ""}` : ""}{b.upi ? ` UPI ${b.upi}` : ""}</span></div> : null}
        {slips.length > 0 ? (
          <div className="auc-ledger-row" style={{ display: "block" }}>
            <span className="auc-subtle">Payment slip{slips.length > 1 ? "s" : ""}</span>
            <Photos urls={slips} size={72} />
          </div>
        ) : null}
      </div>
      {m.status === "recorded" ? (
        <p className="auc-hint">Recorded as a bank transfer, reference <b>{m.reference}</b> on {dmyt(m.recorded_at)}.{side === "admin" ? " Check the slip and mark it received once it shows in the account." : " Waiting for iTarang to mark it received."}</p>
      ) : null}
      {m.status === "confirmed" ? (
        <p className="auc-hint">Received {dmyt(m.confirmed_at)}{m.reference ? <> · ref <b>{m.reference}</b></> : null}.{batteriesStillAway ? " The batteries can ship back." : ""}</p>
      ) : null}
      {side === "nbfc" && m.status === "pending" ? (
        <>
          <p className="auc-hint" style={{ marginBlockStart: ".5rem" }}>
            Pay by NEFT / RTGS / UPI into the account above, then upload the payment slip and record the reference here. iTarang marks it received{batteriesStillAway ? " — the batteries ship back only after that" : ""}.
          </p>
          {onUpload ? (
            <div className="auc-linkrow" style={{ marginBlockStart: ".5rem" }}>
              <FilePick label={slips.length ? "Add another slip" : "Upload payment slip"} accept="application/pdf,image/*" disabled={busy} onPick={(f) => void onUpload(slipTarget, f).then((p) => { if (p.length) setSlips(p); })} />
              {slipRequired && slips.length === 0 ? <span className="auc-chip" data-tone="warn">required</span> : slips.length ? <span className="auc-chip" data-tone="live">{slips.length} on file</span> : <span className="auc-hint">optional</span>}
            </div>
          ) : null}
          <div className="auc-linkrow" style={{ marginBlockStart: ".5rem" }}>
            <input className="auc-text" placeholder="UTR / reference" value={ref} onChange={(e) => setRef(e.target.value)} style={{ maxWidth: "16rem" }} />
            <input className="auc-text" placeholder="note (optional)" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: "1 1 12rem" }} />
            <button type="button" className="auc-btn" disabled={busy || ref.trim().length < 3 || (slipRequired && slips.length === 0)} onClick={() => void onAction("record-payment", { leg, reference: ref.trim(), message: note || undefined })}>Record transfer</button>
          </div>
          {slipRequired && slips.length === 0 ? <span className="auc-hint">Upload the slip (screenshot or PDF of the transfer) to enable Record transfer.</span> : null}
        </>
      ) : null}
      {side === "admin" && (m.status === "recorded" || m.status === "pending") ? (
        <div className="auc-linkrow" style={{ marginBlockStart: ".75rem" }}>
          {m.status === "pending" ? <input className="auc-text" placeholder="bank reference (UTR) — the NBFC has not recorded one" value={ref} onChange={(e) => setRef(e.target.value)} style={{ flex: "1 1 18rem" }} /> : null}
          <button type="button" className="auc-btn" disabled={busy || (m.status === "pending" && ref.trim().length < 3)} onClick={() => void onAction("confirm-payment", { leg, reference: ref.trim() || null, message: note || undefined })}>Mark {leg} received</button>
        </div>
      ) : null}
      {side === "admin" && m.status === "pending" ? (
        <p className="auc-hint">
          Waiting for {lot.tenant_name ?? "the NBFC"} to pay, upload the slip and record the UTR{batteriesStillAway ? " — the return dispatch stays locked until then" : ""}. Or mark it received yourself once the money shows.
        </p>
      ) : null}
    </div>
  );
}

function AssignPanel({ lot, busy, refurbishers, onSubmit }: { lot: LotView; busy: boolean; refurbishers: RefurbisherOption[]; onSubmit: (p: Record<string, unknown>) => Promise<unknown> }) {
  const [id, setId] = useState(lot.refurbisher?.id ?? "");
  const [note, setNote] = useState(lot.refurbisher_note ?? "");
  const active = refurbishers.filter((r) => r.is_active !== false);
  return (
    <div className="auc-panel-body">
      {lot.out.has_mismatch ? <p className="auc-hint" style={{ color: "var(--auc-warn)" }}>Receipt had discrepancies. Batteries marked missing are closed out when the lot is assigned.</p> : null}
      <span className="auc-hint">Internal — the NBFC is not told who does the work.</span>
      <div className="auc-linkrow" style={{ marginBlockStart: ".5rem" }}>
        <select className="auc-text" value={id} onChange={(e) => setId(e.target.value)} style={{ maxWidth: "20rem" }}>
          <option value="">— pick a refurbisher —</option>
          {active.map((r) => <option key={r.id} value={r.id}>{r.name}{r.city ? ` · ${r.city}` : ""}{r.open_lots ? ` (${r.open_lots} open)` : ""}</option>)}
        </select>
        <input className="auc-text" placeholder="note to the refurbisher (optional)" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: "1 1 14rem" }} />
        <button type="button" className="auc-btn" disabled={busy || !id} onClick={() => onSubmit({ refurbisher_id: id, message: note || undefined })}>{lot.refurbisher ? "Re-assign" : "Assign"}</button>
      </div>
      {active.length === 0 ? <p className="auc-hint" style={{ color: "var(--auc-warn)" }}>No active refurbisher. Onboard one under Admin → NBFC → Refurbishers.</p> : null}
    </div>
  );
}

function WorkPanel({ lot, items, busy, frozen, onUpdate, onCost }: {
  lot: LotView;
  items: LotItemView[];
  busy: boolean;
  frozen: boolean;
  onUpdate: (jobId: string, patch: Record<string, unknown>) => Promise<unknown>;
  onCost: (jobId: string, patch: Record<string, unknown>) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<Record<string, { cost: string; parts: PartView[]; note: string }>>({});
  const d = (it: LotItemView) => draft[it.id] ?? { cost: it.refurbisher_cost != null ? String(it.refurbisher_cost) : "", parts: it.refurbisher_parts ?? [], note: it.refurbisher_note ?? "" };
  const set = (it: LotItemView, patch: Partial<{ cost: string; parts: PartView[]; note: string }>) => setDraft((s) => ({ ...s, [it.id]: { ...d(it), ...patch } }));
  const canWork = lot.status === "in_progress" || lot.status === "costed";
  return (
    <div className="auc-stack">
      {items.map((it) => {
        const x = d(it);
        const base = (Number(x.cost) || 0) + partsTotal(x.parts) + accTotal(it.accessories);
        const done = it.status === "ready" || it.status === "returned";
        const costed = !!it.costed_at;
        return (
          <article key={it.id} className="auc-mini-card">
            <header>
              <div className="auc-winner">
                <span className="auc-pick-serial">{it.battery_serial}</span>
                <span className="auc-subtle">{it.model ?? ""} · health {it.soh_pct ?? "—"}%</span>
              </div>
              <span className="auc-chip" data-tone={done ? "live" : costed ? "live" : it.status === "at_refurbisher" ? "warn" : "muted"}>{done ? ITEM_LABEL[it.status] : costed ? "costed" : ITEM_LABEL[it.status] ?? it.status}</span>
            </header>
            {it.out_received_condition && it.out_received_condition !== "received" ? <p className="auc-hint" style={{ color: "var(--auc-warn)" }}>Arrived {it.out_received_condition}{it.out_received_note ? ` — ${it.out_received_note}` : ""}</p> : null}
            <Photos urls={it.image_urls} size={40} />
            <div className="auc-ledger" style={{ marginBlockStart: ".5rem" }}>
              {it.accessories.map((a) => (
                <div key={a.key} className="auc-ledger-row">
                  <label style={{ display: "flex", gap: ".5rem", alignItems: "center", cursor: frozen || done ? "default" : "pointer" }}>
                    <input type="checkbox" checked={a.included} disabled={busy || frozen || done || !canWork} onChange={() => void onUpdate(it.id, { accessories: it.accessories.map((y) => (y.key === a.key ? { ...y, included: !y.included } : y)) })} />{a.label} <span className="auc-subtle">(new)</span>
                  </label>
                  <b>{formatINR(a.unit_cost)}</b>
                </div>
              ))}
              {x.parts.map((p, i) => (
                <div key={i} className="auc-ledger-row">
                  <span style={{ display: "flex", gap: ".375rem", alignItems: "center", flexWrap: "wrap" }}>
                    <input className="auc-text" style={{ width: "12rem" }} placeholder="part" value={p.label} disabled={frozen || done} onChange={(e) => set(it, { parts: x.parts.map((q, j) => (j === i ? { ...q, label: e.target.value } : q)) })} />
                    <input className="auc-text" data-numeric="true" style={{ width: "4rem" }} value={p.qty} disabled={frozen || done} onChange={(e) => set(it, { parts: x.parts.map((q, j) => (j === i ? { ...q, qty: Number(e.target.value) || 0 } : q)) })} /> ×
                    <input className="auc-text" data-numeric="true" style={{ width: "6rem" }} value={p.unit_cost} disabled={frozen || done} onChange={(e) => set(it, { parts: x.parts.map((q, j) => (j === i ? { ...q, unit_cost: Number(e.target.value) || 0 } : q)) })} />
                    {!frozen && !done ? <button type="button" className="auc-btn" data-variant="ghost" onClick={() => set(it, { parts: x.parts.filter((_, j) => j !== i) })}>×</button> : null}
                  </span>
                  <b>{formatINR(p.qty * p.unit_cost)}</b>
                </div>
              ))}
              {!frozen && !done && canWork ? <div className="auc-ledger-row"><button type="button" className="auc-btn" data-variant="ghost" onClick={() => set(it, { parts: [...x.parts, { label: "", qty: 1, unit_cost: 0 }] })}>+ part replaced</button><span /></div> : null}
              <div className="auc-ledger-row">
                <span>Labour</span>
                {frozen || done ? <b>{formatINR(it.refurbisher_cost)}</b> : (
                  <input className="auc-text" data-numeric="true" inputMode="numeric" style={{ width: "7rem" }} value={x.cost} disabled={busy || !canWork} onChange={(e) => set(it, { cost: e.target.value.replace(/[^\d.]/g, "") })} />
                )}
              </div>
              <div className="auc-ledger-row" data-total="true"><span>Cost for this battery</span><b>{formatINR(frozen || done ? (it.refurbisher_cost ?? 0) + partsTotal(it.refurbisher_parts) + accTotal(it.accessories) : base)}</b></div>
              {it.final_cost != null ? <div className="auc-ledger-row"><span>Final (incl. iTarang margin)</span><b>{formatINR(it.final_cost)}</b></div> : null}
            </div>
            {!frozen && !done && canWork ? (
              <div className="auc-linkrow" style={{ marginBlockStart: ".625rem" }}>
                <input className="auc-text" placeholder="work note (what was done)" value={x.note} onChange={(e) => set(it, { note: e.target.value })} style={{ flex: "1 1 14rem" }} />
                <button type="button" className="auc-btn" disabled={busy || x.cost === ""} onClick={() => void onCost(it.id, { refurbisher_cost: Number(x.cost), refurbisher_parts: x.parts.filter((p) => p.label.trim()), refurbisher_note: x.note || null, accessories: it.accessories })}>{costed ? "Update final cost" : "Submit final cost"}</button>
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function FinalCostPanel({ lot, items, busy, onSubmit, onReady }: { lot: LotView; items: LotItemView[]; busy: boolean; onSubmit: (p: Record<string, unknown>) => Promise<unknown>; onReady: (jobId: string) => Promise<unknown> }) {
  const [mode, setMode] = useState<"pct" | "amount">("pct");
  const [pct, setPct] = useState(String(lot.margin.pct ?? 15));
  const [amt, setAmt] = useState(String(lot.margin.amount ?? ""));
  const refTotal = lot.refurbisher_total ?? lot.actual_total ?? 0;
  const sent = !!lot.final_sent_at;
  const advance = lot.advance.status === "confirmed" ? (lot.advance.amount ?? 0) : 0;
  // E-292: once the NBFC has accepted a proforma invoice, that amount IS the
  // final bill. The refurbisher's cost stays internal; the margin is derived.
  const piAmount = lot.pi.accepted_at && lot.pi.amount != null && lot.pi.amount > 0 ? lot.pi.amount : null;
  const fromPi = piAmount != null;
  const margin = fromPi ? money2(piAmount - refTotal) : mode === "pct" ? money2((refTotal * (Number(pct) || 0)) / 100) : Number(amt) || 0;
  const final = fromPi ? piAmount : money2(refTotal + margin);
  const shownFinal = sent ? (lot.final_total ?? 0) : final;
  const balance = Math.max(0, shownFinal - advance);
  return (
    <div className="auc-panel-body">
      {fromPi ? (
        <>
          <div className="auc-ledger" style={{ maxWidth: "32rem" }}>
            <div className="auc-ledger-row"><span>Proforma invoice accepted {dmy(lot.pi.accepted_at)}</span><b>{formatINR(piAmount)}</b></div>
            <div className="auc-ledger-row" data-total="true"><span>Final bill to {lot.tenant_name ?? "the NBFC"}</span><b>{formatINR(shownFinal)}</b></div>
            <div className="auc-ledger-row"><span>Advance {lot.advance.status === "confirmed" ? "received" : lot.advance.status === "not_required" ? "not required" : "not yet received"}</span><b>− {formatINR(advance)}</b></div>
            <div className="auc-ledger-row" data-total="true"><span>Balance pending from {lot.tenant_name ?? "the NBFC"}</span><b>{formatINR(balance)}</b></div>
          </div>
          <span className="auc-label" style={{ display: "block", marginBlockStart: ".75rem" }}>Internal — not shared with the NBFC</span>
          <div className="auc-ledger" style={{ maxWidth: "32rem", marginBlockStart: ".375rem" }}>
            <div className="auc-ledger-row"><span>Refurbisher cost{lot.refurbisher ? ` (${lot.refurbisher.name})` : ""}</span><b>{formatINR(refTotal)}</b></div>
            <div className="auc-ledger-row"><span>iTarang margin (PI − refurbisher cost)</span><b>{(sent ? (lot.margin.amount ?? 0) : margin) < 0 ? <span className="auc-chip" data-tone="warn">{formatINR(sent ? lot.margin.amount : margin)}</span> : formatINR(sent ? lot.margin.amount : margin)}</b></div>
          </div>
        </>
      ) : (
        <div className="auc-ledger" style={{ maxWidth: "32rem" }}>
          <div className="auc-ledger-row"><span>Refurbisher total{lot.refurbisher ? ` (${lot.refurbisher.name})` : ""}</span><b>{formatINR(refTotal)}</b></div>
          <div className="auc-ledger-row">
            <span style={{ display: "flex", gap: ".5rem", alignItems: "center", flexWrap: "wrap" }}>
              iTarang margin
              <label style={{ display: "flex", gap: ".25rem", alignItems: "center" }}><input type="radio" checked={mode === "pct"} disabled={sent} onChange={() => setMode("pct")} /><input className="auc-text" data-numeric="true" style={{ width: "4rem" }} value={pct} disabled={sent || mode !== "pct"} onChange={(e) => setPct(e.target.value.replace(/[^\d.]/g, ""))} /> %</label>
              <label style={{ display: "flex", gap: ".25rem", alignItems: "center" }}><input type="radio" checked={mode === "amount"} disabled={sent} onChange={() => setMode("amount")} />₹ <input className="auc-text" data-numeric="true" style={{ width: "7rem" }} value={amt} disabled={sent || mode !== "amount"} onChange={(e) => setAmt(e.target.value.replace(/[^\d.]/g, ""))} /></label>
            </span>
            <b>{formatINR(sent ? lot.margin.amount : margin)}</b>
          </div>
          <div className="auc-ledger-row" data-total="true"><span>Final bill to {lot.tenant_name ?? "the NBFC"}</span><b>{formatINR(shownFinal)}</b></div>
          <div className="auc-ledger-row"><span>Balance once back (final − advance {formatINR(advance)})</span><b>{formatINR(balance)}</b></div>
        </div>
      )}
      {!sent ? (
        <>
          <span className="auc-hint">
            {fromPi
              ? "The NBFC is billed the proforma invoice amount it already accepted; the refurbisher's cost is not shared. Sending fixes the balance the NBFC still owes and splits the margin across the batteries so each carries its true cost into an auction."
              : "The final bill goes to the NBFC as information — no re-approval. It also freezes the refurbisher's costs and splits the margin across the batteries so each carries its true cost into an auction."}
          </span>
          <div className="auc-linkrow" style={{ marginBlockStart: ".75rem" }}>
            <button type="button" className="auc-btn" disabled={busy || (!fromPi && (mode === "pct" ? pct === "" : amt === ""))} onClick={() => onSubmit(fromPi ? {} : mode === "pct" ? { margin_pct: Number(pct) } : { margin_amount: Number(amt) })}>
              Send final bill to NBFC — {formatINR(final)}{fromPi ? ` · balance ${formatINR(balance)}` : ""}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="auc-hint">Final bill sent {dmyt(lot.final_sent_at)}. Mark each battery ready; the lot ships back once all are.</p>
          <div style={{ overflowX: "auto", marginBlockStart: ".5rem" }}>
            <table className="auc-table">
              <thead><tr><th>Battery</th><th>Refurbisher cost</th><th>Final (incl. margin)</th><th /></tr></thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id}>
                    <td><span className="auc-pick-serial">{it.battery_serial}</span></td>
                    <td className="auc-num">{formatINR((it.refurbisher_cost ?? 0) + partsTotal(it.refurbisher_parts) + accTotal(it.accessories))}</td>
                    <td className="auc-num">{formatINR(it.final_cost)}</td>
                    <td>{it.status === "ready" || it.status === "returned" ? <span className="auc-chip" data-tone="live">{ITEM_LABEL[it.status]}</span> : <button type="button" className="auc-btn" disabled={busy} onClick={() => void onReady(it.id)}>Mark ready</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function ClosePanel({ lot, busy, onSubmit }: { lot: LotView; busy: boolean; onSubmit: (p: Record<string, unknown>) => Promise<unknown> }) {
  const [note, setNote] = useState("");
  return (
    <div className="auc-panel-body">
      <p>The {lot.battery_count} refurbished {lot.battery_count === 1 ? "battery is" : "batteries are"} back and graded <b>refurbished</b>. What happens to them next is your call:</p>
      <div className="auc-field" style={{ marginBlockStart: ".5rem" }}><label>Note (optional)</label><input className="auc-text" value={note} onChange={(e) => setNote(e.target.value)} /></div>
      <div className="auc-linkrow" style={{ marginBlockStart: ".75rem" }}>
        <button type="button" className="auc-btn" disabled={busy} onClick={() => onSubmit({ outcome: "auction", message: note || undefined })}>Auction them</button>
        <button type="button" className="auc-btn" data-variant="ghost" disabled={busy} onClick={() => onSubmit({ outcome: "redeploy", message: note || undefined })}>Redeploy — iTarang helps</button>
      </div>
      <span className="auc-hint">Auction: compose a lot from the Recovery &amp; Auction page; the refurbishment cost is already in each battery&rsquo;s base price. Redeploy: iTarang is told and gets in touch.</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The detail
// ---------------------------------------------------------------------------
export default function RefurbLotDetail({ lot, side, canAct, busy, onAction, onUpload, refurbishers = [] }: Props) {
  const items = useMemo(() => lot.items ?? [], [lot.items]);
  const live = useMemo(() => items.filter((i) => i.status !== "declined" && i.status !== "cancelled"), [items]);
  const [msg, setMsg] = useState("");
  const [msgTo, setMsgTo] = useState<"nbfc" | "refurbisher">("nbfc");
  const [showCounter, setShowCounter] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [showCancel, setShowCancel] = useState(false);
  const [piNote, setPiNote] = useState("");

  const s = lot.status;
  const isNbfc = side === "nbfc";
  const isAdmin = side === "admin";
  const isRef = side === "refurbisher";
  // `settled` is finished for uploads but NOT for actions: the NBFC still owes
  // the redeploy / auction choice (FINISHED_LOT_STATUSES vs CLOSED_LOT_STATUSES).
  const finished = s === "closed" || s === "cancelled";
  const cancellable = !isRef && CANCELLABLE.includes(s);
  const nbfcName = lot.tenant_name ?? "NBFC";
  const refName = lot.refurbisher?.name ?? "the refurbisher";
  const shippable = s === "advance_recorded" || (s === "pi_accepted" && lot.advance.status === "not_required");
  const canShipOut = isNbfc && shippable && lot.pickup_mode === "nbfc_ships";
  const canPickup = isAdmin && shippable && lot.pickup_mode === "itarang_pickup";
  const frozen = !!lot.final_sent_at;
  // E-293: the balance leg opens with the final bill (pending → recorded →
  // confirmed) and must be at least RECORDED before the return truck.
  const balanceOpen = frozen && lot.balance.status !== "not_due" && ["costed", "ready", "in_transit_return", "delivered_back", "balance_due"].includes(s);
  const balanceBeforeReturn = balanceOpen && ["costed", "ready"].includes(s);
  const returnUnlocked = lot.balance.status === "not_due" || lot.balance.status === "recorded" || lot.balance.status === "confirmed";

  const custodySummary = useMemo(() => {
    const c = new Map<Custody, number>();
    for (const i of live) c.set(i.custody, (c.get(i.custody) ?? 0) + 1);
    return Array.from(c.entries());
  }, [live]);

  const waitingLabel = (p: Side | null) => (p === "admin" ? "iTarang" : p === "nbfc" ? nbfcName : p === "refurbisher" ? (isNbfc ? "iTarang" : refName) : null);
  const waitingOnMe = lot.awaiting === side || (isAdmin && lot.awaiting === "refurbisher"); // admin can override

  return (
    <section className="auc-panel">
      <header>
        <div>
          <h3 style={{ margin: 0 }}>{lot.ref_code} · {lot.battery_count} {lot.battery_count === 1 ? "battery" : "batteries"}{!isRef && !isNbfc && lot.tenant_name ? ` · ${lot.tenant_name}` : ""}{isRef && lot.tenant_name ? ` · from ${lot.tenant_name}` : ""}</h3>
          <span className="auc-subtle">{lot.awaiting ? `Waiting on ${waitingLabel(lot.awaiting)}` : "Closed"} · raised {dmy(lot.created_at)}</span>
        </div>
        <LotStatusChip status={s} />
      </header>

      <div className="auc-panel-body">
        {live.length ? (
          <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap", alignItems: "center", marginBlockEnd: ".5rem" }}>
            <span className="auc-label">Where are the batteries</span>
            {custodySummary.map(([c, n]) => (<span key={c} style={{ display: "inline-flex", gap: ".25rem", alignItems: "center" }}><CustodyChip custody={c} /><span className="auc-subtle">×{n}</span></span>))}
          </div>
        ) : null}

        {lot.note && !isRef ? <p style={{ whiteSpace: "pre-wrap" }}><span className="auc-label">NBFC note</span><br />{lot.note}</p> : null}
        {s === "cancelled" ? <p className="auc-inline-error">Cancelled by {lot.cancelled_by_party === "admin" ? "iTarang" : nbfcName}{lot.cancel_reason ? `: ${lot.cancel_reason}` : ""}.{lot.advance.status === "confirmed" ? ` Advance of ${formatINR(lot.advance.amount)} was paid and needs refunding.` : ""}</p> : null}
        {s === "closed" ? <p className="auc-hint" data-tone="ok">Closed {dmy(lot.closed_at)} — {lot.close_outcome === "redeploy" ? "the NBFC chose to redeploy these batteries; iTarang has been asked to help." : "the NBFC chose to auction these batteries."}{lot.close_note ? ` "${lot.close_note}"` : ""}</p> : null}

        {/* The commercials — hidden from the refurbisher by the server, so these are simply null there */}
        {lot.current_round > 0 && !isRef ? (
          <dl className="auc-dl" style={{ marginBlockStart: ".5rem" }}>
            <div><dt>Logistics</dt><dd>{lot.pickup_mode === "itarang_pickup" ? `iTarang picks up${lot.scheduled_pickup_date ? ` ${dmy(lot.scheduled_pickup_date)}` : ""}` : `${nbfcName} ships by ${dmy(lot.expected_receipt_date)}`}</dd></div>
            <div><dt>Return by</dt><dd>{dmy(lot.expected_return_date)}</dd></div>
            <div><dt>Estimate</dt><dd className="auc-num"><b>{formatINR(lot.estimated_total)}</b> <span className="auc-subtle">({formatINR(lot.estimated_labour_total)} labour + {formatINR(lot.estimated_accessories_total)} accessories · round {lot.current_round})</span></dd></div>
            {lot.agreed_at ? <div><dt>Agreed</dt><dd className="auc-num"><b>{formatINR(lot.pi.accepted_at ? lot.pi.amount : lot.quote_approved_total)}</b> <span className="auc-subtle">{dmy(lot.agreed_at)}</span></dd></div> : null}
            {lot.advance_pct > 0 && lot.pi.accepted_at ? <div><dt>Advance {lot.advance_pct}%</dt><dd className="auc-num">{formatINR(lot.advance.amount)} <span className="auc-chip" data-tone={lot.advance.status === "confirmed" ? "live" : lot.advance.status === "not_required" ? undefined : "warn"}>{lot.advance.status.replace(/_/g, " ")}</span></dd></div> : null}
            {isAdmin && lot.refurbisher ? <div><dt>Refurbisher</dt><dd>{lot.refurbisher.name}{lot.refurbisher.city ? ` · ${lot.refurbisher.city}` : ""}{lot.refurbisher.phone ? ` · ${lot.refurbisher.phone}` : ""} <span className="auc-subtle">assigned {dmy(lot.assigned_at)}</span></dd></div> : null}
            {isAdmin && lot.refurbisher_total != null ? <div><dt>Refurbisher total</dt><dd className="auc-num">{formatINR(lot.refurbisher_total)}</dd></div> : null}
            {isAdmin && lot.margin.amount != null ? <div><dt>iTarang margin</dt><dd className="auc-num">{formatINR(lot.margin.amount)} <span className="auc-subtle">({lot.margin.pct}%)</span></dd></div> : null}
            {lot.final_total != null && lot.final_sent_at ? <div><dt>Final bill</dt><dd className="auc-num"><b>{formatINR(lot.final_total)}</b> <span className="auc-subtle">{dmy(lot.final_sent_at)}</span></dd></div> : null}
            {lot.balance.amount != null && lot.balance.status !== "not_due" ? <div><dt>Balance</dt><dd className="auc-num">{formatINR(lot.balance.amount)} <span className="auc-chip" data-tone={lot.balance.status === "confirmed" ? "live" : "warn"}>{lot.balance.status}</span></dd></div> : null}
          </dl>
        ) : null}
        {isRef ? (
          <dl className="auc-dl" style={{ marginBlockStart: ".5rem" }}>
            <div><dt>Return by</dt><dd>{dmy(lot.expected_return_date)}</dd></div>
            {lot.refurbisher_note ? <div><dt>From iTarang</dt><dd style={{ whiteSpace: "pre-wrap" }}>{lot.refurbisher_note}</dd></div> : null}
            {lot.refurbisher_total != null ? <div><dt>Your total</dt><dd className="auc-num">{formatINR(lot.refurbisher_total)}</dd></div> : null}
            {frozen ? <div><dt>Costs</dt><dd><span className="auc-chip" data-tone="live">frozen — billed to the NBFC</span></dd></div> : null}
          </dl>
        ) : null}
        {!isRef && lot.pi.sent_at ? <div style={{ marginBlockStart: ".5rem" }}><PiCard lot={lot} /></div> : null}
        {lot.pickup_address || lot.workshop_address ? <p className="auc-subtle">{lot.pickup_address ? `Pickup: ${lot.pickup_address}. ` : ""}{lot.workshop_address ? `Receiving: ${lot.workshop_address}.` : ""}</p> : null}
        {lot.proposal_note && !isRef ? <p className="auc-subtle" style={{ whiteSpace: "pre-wrap" }}>{lot.proposal_note}</p> : null}

        {[{ k: "out" as const, g: lot.out, title: "To iTarang" }, { k: "ret" as const, g: lot.ret, title: "Back to NBFC" }].map(({ k, g, title }) =>
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
      {!finished && canAct ? (
        <>
          {/* 2 / 3. admin: review, estimate */}
          {isAdmin && s === "requested" ? (<><header><span className="auc-panel-n">1</span><h3>Review each battery</h3></header><ReviewPanel lot={lot} items={items} busy={busy} onDecline={(job_id, reason) => onAction("review", { decisions: [{ job_id, decision: "decline", reason }] })} onReviewed={() => onAction("review", { decisions: [] })} /></>) : null}
          {isAdmin && (s === "reviewed" || s === "countered") ? (
            <>
              {s === "reviewed" ? <ReviewPanel lot={lot} items={items} busy={busy} onDecline={(job_id, reason) => onAction("review", { decisions: [{ job_id, decision: "decline", reason }] })} onReviewed={() => Promise.resolve()} /> : null}
              {live.length ? (<><header><span className="auc-panel-n">₹</span><h3>{s === "countered" ? "Revised estimate" : "Estimate — timeline, costing, advance"}</h3></header><EstimateForm key={`${lot.id}-${lot.current_round}`} lot={lot} items={live} busy={busy} onSubmit={(p) => onAction("estimate", p)} /></>) : null}
            </>
          ) : null}

          {/* 4. nbfc: accept / counter */}
          {isNbfc && s === "estimated" ? (
            <div className="auc-panel-body">
              <div className="auc-linkrow">
                <button type="button" className="auc-btn" disabled={busy} onClick={() => onAction("accept", {})}>Accept estimate — {formatINR(lot.estimated_total)}</button>
                <button type="button" className="auc-btn" data-variant="ghost" disabled={busy} onClick={() => setShowCounter((v) => !v)}>Counter</button>
              </div>
              {showCounter ? <CounterForm lot={lot} busy={busy} onSubmit={(p) => onAction("counter", p)} /> : null}
            </div>
          ) : null}

          {/* 5. admin: PI */}
          {isAdmin && (s === "agreed" || s === "pi_sent") ? (<><header><span className="auc-panel-n">📄</span><h3>{s === "pi_sent" ? "Proforma invoice is with the NBFC — re-send if corrected" : "Proforma invoice"}</h3></header><PiForm key={`${lot.id}-${lot.pi.sent_at ?? "pi"}`} lot={lot} busy={busy} onSubmit={(p) => onAction("send-pi", p)} onUpload={onUpload} /></>) : null}

          {/* 6. nbfc: accept PI */}
          {isNbfc && s === "pi_sent" ? (
            <div className="auc-panel-body">
              <div className="auc-linkrow">
                <input className="auc-text" placeholder="note (optional)" value={piNote} onChange={(e) => setPiNote(e.target.value)} style={{ flex: "1 1 14rem" }} />
                <button type="button" className="auc-btn" disabled={busy || !lot.pi.url} onClick={() => onAction("accept-pi", { message: piNote || undefined })}>Accept proforma invoice — {formatINR(lot.pi.amount)}</button>
              </div>
              <span className="auc-hint">Review the proforma invoice shown above first. Accepting fixes the amount and terms{(lot.pi.advance_pct ?? 0) > 0 ? `; the ${lot.pi.advance_pct}% advance is then payable before the batteries move` : ""}.</span>
            </div>
          ) : null}

          {/* 7 / 16. money */}
          {s === "pi_accepted" && lot.advance.status !== "not_required" && !isRef ? (<><header><span className="auc-panel-n">₹</span><h3>Advance</h3></header><PayPanel lot={lot} leg="advance" side={side} busy={busy} onAction={onAction} onUpload={onUpload} /></>) : null}
          {/* E-293: the balance opens with the final bill and is paid (slip + UTR) before the batteries ship back */}
          {balanceOpen && !isRef ? (
            <>
              <header><span className="auc-panel-n">₹</span><h3>{balanceBeforeReturn ? "Balance — due before the batteries ship back" : "Balance"}</h3></header>
              <PayPanel lot={lot} leg="balance" side={side} busy={busy} onAction={onAction} onUpload={onUpload} />
            </>
          ) : null}

          {/* 8a / 8b */}
          {canShipOut ? <TransportForm title="Dispatch to iTarang" submitLabel="Record dispatch" ewayTarget="out_eway_bill" busy={busy} onSubmit={(p) => onAction("dispatch", p)} onUpload={onUpload} /> : null}
          {canPickup ? <TransportForm title={`Pickup from ${nbfcName}${lot.scheduled_pickup_date ? ` — planned ${dmy(lot.scheduled_pickup_date)}` : ""}`} submitLabel="Picked up — in transit" ewayTarget="out_eway_bill" busy={busy} onSubmit={(p) => onAction("pickup", p)} onUpload={onUpload} /> : null}

          {/* 9 */}
          {isAdmin && s === "in_transit_out" ? (
            <>
              {!lot.out.delivered_at ? <div className="auc-panel-body"><div className="auc-linkrow"><button type="button" className="auc-btn" data-variant="ghost" disabled={busy} onClick={() => onAction("arrive", {})}>Truck arrived</button><span className="auc-hint">Optional — the receipt below records arrival too.</span></div></div> : null}
              <header><span className="auc-panel-n">✓</span><h3>Receipt at iTarang — battery by battery</h3></header>
              <ReceiptForm key={`${lot.id}-out`} items={live} leg="out" busy={busy} onSubmit={(p) => onAction("confirm-receipt", p)} onUploadItem={(jobId, f) => onUpload(`item:${jobId}:out`, f)} />
            </>
          ) : null}

          {/* 10 */}
          {isAdmin && (s === "received" || (s === "at_refurbisher" && !lot.work_started_at)) ? (<><header><span className="auc-panel-n">🏭</span><h3>{s === "received" ? "Assign to a refurbisher" : `At ${refName} — re-assign?`}</h3></header><AssignPanel lot={lot} busy={busy} refurbishers={refurbishers} onSubmit={(p) => onAction("assign", p)} /></>) : null}

          {/* 11 / 12 */}
          {(isRef || isAdmin) && s === "at_refurbisher" ? (
            <div className="auc-panel-body"><div className="auc-linkrow"><button type="button" className="auc-btn" disabled={busy} onClick={() => onAction("start-work", {})}>{isAdmin ? `Start work (on behalf of ${refName})` : "Start work"}</button></div></div>
          ) : null}
          {(isRef || isAdmin) && (s === "in_progress" || (s === "costed" && !frozen)) ? (
            <>
              <header><span className="auc-panel-n">🔧</span><h3>{isAdmin ? `Work at ${refName}` : "Work per battery"}</h3></header>
              <div className="auc-panel-body">
                {s === "costed" ? <p className="auc-hint">Every battery is costed{isAdmin ? " — set the margin below to send the final bill" : " — iTarang will bill the NBFC and mark the batteries ready"}. Costs can still be edited until then.</p> : null}
                <WorkPanel lot={lot} items={live} busy={busy} frozen={frozen} onUpdate={(job_id, patch) => onAction("update-item", { job_id, ...patch })} onCost={(job_id, patch) => onAction("cost-item", { job_id, ...patch })} />
              </div>
            </>
          ) : null}

          {/* 13 */}
          {isAdmin && s === "costed" ? (<><header><span className="auc-panel-n">₹</span><h3>Final bill</h3></header><FinalCostPanel lot={lot} items={live} busy={busy} onSubmit={(p) => onAction("set-final-cost", p)} onReady={(job_id) => onAction("mark-ready", { job_id })} /></>) : null}
          {isRef && s === "costed" && frozen ? <div className="auc-panel-body"><p className="auc-hint">iTarang has billed the NBFC. Waiting for the batteries to be marked ready; then record the return dispatch.</p></div> : null}

          {/* 14 — locked until the NBFC has recorded the balance (E-293) */}
          {(isAdmin || isRef) && s === "ready" && returnUnlocked ? <TransportForm title={`Dispatch back to ${nbfcName}`} submitLabel="Record return dispatch" ewayTarget="ret_eway_bill" busy={busy} onSubmit={(p) => onAction("dispatch", p)} onUpload={onUpload} /> : null}
          {(isAdmin || isRef) && s === "ready" && !returnUnlocked ? (
            <div className="auc-panel-body">
              <div className="auc-linkrow"><span className="auc-chip" data-tone="warn">return dispatch locked</span><span className="auc-hint">{isRef ? "iTarang is waiting for the NBFC's balance payment; you will be able to record the return dispatch once it is in." : `Waiting for ${nbfcName} to upload the balance payment slip and reference (${formatINR(lot.balance.amount)}). The batteries ship back after that.`}</span></div>
            </div>
          ) : null}

          {/* 15 */}
          {isNbfc && s === "in_transit_return" ? (
            <div className="auc-panel-body"><div className="auc-linkrow"><button type="button" className="auc-btn" disabled={busy} onClick={() => onAction("arrive", {})}>Truck arrived</button><span className="auc-hint">Then sign for each battery.</span></div></div>
          ) : null}
          {isNbfc && s === "delivered_back" ? (<><header><span className="auc-panel-n">✓</span><h3>Receipt — battery by battery</h3></header><ReceiptForm key={`${lot.id}-ret`} items={live.filter((i) => i.status === "ready")} leg="return" busy={busy} onSubmit={(p) => onAction("confirm-receipt", p)} onUploadItem={(jobId, f) => onUpload(`item:${jobId}:return`, f)} /></>) : null}

          {/* 17 */}
          {isNbfc && s === "settled" ? (<><header><span className="auc-panel-n">→</span><h3>Redeploy or auction?</h3></header><ClosePanel lot={lot} busy={busy} onSubmit={(p) => onAction("close", p)} /></>) : null}

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

      {!finished && !canAct ? <p className="auc-hint" style={{ padding: "0 1rem" }}>You can view this lot but your role cannot act on it.</p> : null}
      {!finished && canAct && lot.awaiting && !waitingOnMe && !cancellable ? (
        <p className="auc-hint" style={{ padding: "0 1rem" }}>Waiting on {waitingLabel(lot.awaiting)}.</p>
      ) : null}
      {s === "settled" && isAdmin ? <p className="auc-hint" style={{ padding: "0 1rem" }}>Settled. Waiting for {nbfcName} to choose redeploy or auction.</p> : null}

      {/* ---------------- Batteries ---------------- */}
      {!((isAdmin && ["requested", "reviewed", "in_progress", "costed"].includes(s)) || (isRef && ["in_progress", "costed"].includes(s))) ? (
        <>
          <header><span className="auc-panel-n">🔋</span><h3>Batteries</h3></header>
          <div className="auc-panel-body" style={{ overflowX: "auto" }}>
            <table className="auc-table">
              <thead><tr><th>Serial</th><th>Model</th><th>Health</th><th>Status</th><th>Where</th>{!isRef ? <th>Estimate</th> : null}{!isNbfc ? <th>Refurbisher cost</th> : null}{!isRef ? <th>Final</th> : null}<th>Receipt</th></tr></thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id}>
                    <td><span className="auc-pick-serial">{it.battery_serial}</span></td>
                    <td>{it.model ?? "—"}</td>
                    <td>{it.soh_pct != null ? `${it.soh_pct}%` : "—"}</td>
                    <td><span className="auc-chip" data-tone={it.status === "returned" || it.status === "ready" ? "live" : it.status === "declined" || it.status === "cancelled" ? "muted" : undefined}>{ITEM_LABEL[it.status] ?? it.status}</span>{it.decline_reason && !isRef ? <div className="auc-subtle">{it.decline_reason}</div> : null}</td>
                    <td><CustodyChip custody={it.custody} /></td>
                    {!isRef ? <td className="auc-num">{formatINR(it.estimated_cost)}</td> : null}
                    {!isNbfc ? <td className="auc-num">{it.costed_at ? formatINR((it.refurbisher_cost ?? 0) + partsTotal(it.refurbisher_parts) + accTotal(it.accessories)) : "—"}</td> : null}
                    {!isRef ? <td className="auc-num">{formatINR(it.final_cost)}</td> : null}
                    <td className="auc-subtle">
                      {it.out_received_condition ? <div>iTarang: {it.out_received_condition}{it.out_received_note ? ` — ${it.out_received_note}` : ""}</div> : null}
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
        <LotTimeline events={lot.events ?? []} tenantName={lot.tenant_name} refurbisherName={lot.refurbisher?.name} side={side} />
        {!finished && canAct ? (
          <div className="auc-linkrow" style={{ marginBlockStart: ".75rem" }}>
            {isAdmin ? (
              <select className="auc-text" value={msgTo} onChange={(e) => setMsgTo(e.target.value as "nbfc" | "refurbisher")} style={{ maxWidth: "12rem" }}>
                <option value="nbfc">To {nbfcName}</option>
                {lot.refurbisher ? <option value="refurbisher">To {lot.refurbisher.name}</option> : null}
              </select>
            ) : null}
            <input className="auc-text" value={msg} onChange={(e) => setMsg(e.target.value)} placeholder={`Message ${isAdmin ? (msgTo === "nbfc" ? nbfcName : refName) : "iTarang"}…`} style={{ flex: "1 1 20rem" }} onKeyDown={(e) => { if (e.key === "Enter" && msg.trim()) { void onAction("message", { message: msg.trim(), ...(isAdmin ? { to: msgTo } : {}) }).then(() => setMsg("")); } }} />
            <button type="button" className="auc-btn" data-variant="ghost" disabled={busy || !msg.trim()} onClick={() => void onAction("message", { message: msg.trim(), ...(isAdmin ? { to: msgTo } : {}) }).then(() => setMsg(""))}>Send</button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
