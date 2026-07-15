"use client";

/**
 * The dealer's view of one request — laid out to the design prototype
 * (iTarang Portal.dc.html scrDealerDetail, lines 613-645): header, stepper,
 * INFO_REQUESTED banner, then five ?tab=-persisted tabs (Overview / Negotiation
 * / Documents / Payments / Activity Log), with the final offer parked in a fixed
 * bottom-right card AND echoed inline at the top of the Negotiation tab.
 *
 * Three things the prototype got wrong and this does not:
 *
 *  · The INFO_REQUESTED banner names the EXACT units the admin asked about
 *    ("60V 120Ah · Working — Unit 2"), not the whole request (BRD M06 AC).
 *  · The final offer is itemized per SKU with ONE overall Accept/Decline (U5).
 *  · The dealer's counter is itemized per SKU too — there is no lump-sum box.
 *
 * Every number on this page arrives already redacted: the API builds the dealer
 * payload field-by-field (serialize.ts), so margin and vendor data — including
 * on the new negotiation and PO fields — are not in the response at all. This
 * file moved pixels, not wires: every dealer action posts to the same endpoint
 * with the same payload as before the re-layout.
 */

import { Suspense, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import DealerInvoicePane from "@/components/buyback/DealerInvoicePane";
import LineInputTable from "@/components/buyback/LineInputTable";
import Lightbox, { type LightboxItem } from "@/components/buyback/Lightbox";
import StatusChip, { OfferVersionChip } from "@/components/buyback/StatusChip";
import VarianceBanner from "@/components/buyback/VarianceBanner";
import {
  ActivityTimeline,
  Card,
  DocPreviewCard,
  EmptyState,
  LinesCard,
  NegotiationThread,
  Stepper,
  Tabs,
  useActiveTab,
} from "@/components/buyback/ui";
import type { ActivityEntry, BuybackLineView, NegRound, TabItem } from "@/components/buyback/ui";
import { formatBatteryLine, inr, perUnitShort, specSummary } from "@/lib/buyback/format";
import type { SpecSummarySource } from "@/lib/buyback/format";

// The E-191 dealer-declared spec fields ride along on the payload's lines and
// are typed by SpecSummarySource (all optional/nullable) — one declaration,
// shared with the formatter that renders them.
interface DealerLine extends SpecSummarySource {
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

interface NegRoundPayload {
  round_no: number;
  offered_by: "dealer" | "admin";
  actor_label: string;
  note: string | null;
  created_at: string;
  lines: Array<{ line_id: string; label: string; price_per_unit: number }>;
  is_final: boolean;
  is_accept: boolean;
  /** U5 — present only on is_final rounds: the offer_version THIS final
   * offer belongs to, so a reopened deal's earlier finals keep their own
   * "FINAL vN" label rather than all showing the deal's current version. */
  version?: number;
}

interface DealerPo {
  number: string;
  status: string;
  issued_at: string | null;
  pdf_available: boolean;
}

interface Detail {
  request_id: string;
  request_no: string;
  dealer_firm: string | null;
  status: string;
  offer_version: number;
  created_at: string;
  submitted_at: string | null;
  lines: DealerLine[];
  dealer_quote_total: number | null;
  info_request: {
    id: string;
    note: string | null;
    checklist: string[];
    target_line_ids: string[];
    target_units: Array<{ unit_id: string; line_id: string; label: string }>;
  } | null;
  final_offer: {
    id: string;
    version_no: number;
    status: string;
    lines: OfferLine[];
    total: number;
  } | null;
  negotiation: NegRoundPayload[];
  dealer_po: DealerPo | null;
  /** Already redacted server-side — margin/vendor events are never sent. */
  activity: Array<{ action: string; role: string; created_at: string }>;
}

/** One line's evidence, from GET …/photos — dealer-scoped, so it is their own. */
interface EvidenceLine {
  line_id: string;
  photos: Array<{ id: string; unit_id: string | null; has_thumb: boolean }>;
  provenance: {
    id: string;
    source_type: string;
    prev_owner_name: string | null;
    prev_owner_phone: string | null;
    vehicle_no: string | null;
    id_proof_type: string | null;
    has_id_proof: boolean;
    has_purchase_proof: boolean;
  } | null;
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
  acknowledge_variance: "You confirmed the collected count",
  raise_invoice: "You raised your invoice",
  approve_invoice: "Your invoice was approved",
  return_invoice: "Your invoice was returned",
  record_settlement: "Payment recorded",
  settle: "Deal settled",
  close_deal: "Deal closed",
};

const TABS: TabItem[] = [
  { key: "overview", label: "Overview" },
  { key: "neg", label: "Negotiation" },
  { key: "docs", label: "Documents" },
  { key: "pay", label: "Payments" },
  { key: "log", label: "Activity Log" },
];

export default function DealerRequestDetailPage() {
  // useActiveTab reads useSearchParams(), which requires a Suspense boundary
  // above it for the build-time prerender pass.
  return (
    <Suspense fallback={<div className="p-10 text-slate-400">Loading…</div>}>
      <DealerRequestDetail />
    </Suspense>
  );
}

/** Per-checklist-item upload state for the INFO_REQUESTED banner. */
interface InfoUpload {
  count: number;
  busy: boolean;
  error: string | null;
}

function DealerRequestDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const tab = useActiveTab(TABS);

  const [detail, setDetail] = useState<Detail | null>(null);
  const [evidence, setEvidence] = useState<EvidenceLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [counter, setCounter] = useState<Record<string, string>>({});
  const [showCounter, setShowCounter] = useState(false);
  const [lightbox, setLightbox] = useState<{ items: LightboxItem[]; index: number } | null>(null);
  const [infoUploads, setInfoUploads] = useState<Record<string, InfoUpload>>({});

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

      const json = await res.json().catch(() => null);
      if (cancelled) return;

      if (!res.ok || !json?.success) {
        // Non-404 failure — show the API's reason rather than a blank page.
        setLoadError(json?.error?.message ?? "Could not load this request.");
        setLoading(false);
        return;
      }

      setDetail(json.data ?? null);
      setLoading(false);

      // Evidence (photos + provenance) for the Overview — best-effort, its own
      // dealer-scoped endpoint. A failure here just means no thumbnails.
      const evRes = await fetch(`/api/buyback/requests/${id}/photos`);
      if (cancelled) return;
      const evJson = await evRes.json().catch(() => null);
      if (cancelled) return;
      if (evJson?.success) setEvidence(evJson.data?.lines ?? []);
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

  /**
   * Upload one photo for an INFO_REQUESTED checklist item, through the SAME
   * two-step flow the intake uses: same-origin /api/buyback/uploads → record on
   * …/photos. Photos attach to a battery line; we target the line the admin
   * asked about.
   */
  const uploadInfoPhoto = async (item: string, file: File, lineId: string) => {
    setInfoUploads((u) => ({
      ...u,
      [item]: { count: u[item]?.count ?? 0, busy: true, error: null },
    }));
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      form.append("line_id", lineId);
      form.append("kind", "photo");
      const upRes = await fetch("/api/buyback/uploads", { method: "POST", body: form });
      const upJson = await upRes.json().catch(() => null);
      if (!upJson?.success) throw new Error(upJson?.error?.message ?? "Upload failed.");

      const recRes = await fetch(`/api/buyback/requests/${id}/photos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ line_id: lineId, s3_key_original: upJson.data.s3_key }),
      });
      const recJson = await recRes.json().catch(() => null);
      if (!recJson?.success) throw new Error(recJson?.error?.message ?? "Could not record the photo.");

      setInfoUploads((u) => ({
        ...u,
        [item]: { count: (u[item]?.count ?? 0) + 1, busy: false, error: null },
      }));
    } catch (e) {
      setInfoUploads((u) => ({
        ...u,
        [item]: {
          count: u[item]?.count ?? 0,
          busy: false,
          error: e instanceof Error ? e.message : "Upload failed.",
        },
      }));
    }
  };

  if (loading) return <div className="p-10 text-slate-400">Loading…</div>;

  if (loadError) {
    return (
      <div className="mx-auto max-w-4xl px-6 pb-24 pt-6">
        <button
          onClick={() => router.push("/dealer-portal/buyback")}
          className="mb-4 text-[12.5px] text-slate-500 hover:underline"
        >
          ← My Requests
        </button>
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {loadError}
        </div>
      </div>
    );
  }

  if (!detail) return null;

  const offer = detail.final_offer;
  const canRespond = detail.status === "FINAL_OFFER_SENT" && offer?.status === "SENT";
  const canCounter = detail.status === "NEGOTIATING";

  const totalUnits = detail.lines.reduce((s, l) => s + l.quantity, 0);
  const dateLabel = new Date(detail.submitted_at ?? detail.created_at).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  // The line an INFO_REQUESTED upload attaches to: the exact line the admin
  // targeted, else the first targeted line, else the first line on the request.
  const infoUploadLineId =
    detail.info_request?.target_units[0]?.line_id ??
    detail.info_request?.target_line_ids?.[0] ??
    detail.lines[0]?.id ??
    null;

  const evidenceByLine = new Map(evidence.map((e) => [e.line_id, e]));

  // ---- Overview tab: lines mapped onto the LinesCard atom ------------------
  const lineViews: BuybackLineView[] = detail.lines.map((l) => {
    const ev = evidenceByLine.get(l.id);
    const prov = ev?.provenance;
    return {
      id: l.id,
      label: l.variant_type,
      qty: l.quantity,
      condition: l.condition_key,
      spec: l.spec_label,
      details: specSummary(l),
      measured: l.measured_voltage ? `${l.measured_voltage}V` : undefined,
      expectedPerUnit:
        l.expected_price_per_unit != null ? Number(l.expected_price_per_unit) : undefined,
      lockedPerUnit: l.dealer_price != null ? Number(l.dealer_price) : undefined,
      lineTotal: l.line_total ?? undefined,
      photos: (ev?.photos ?? []).map((p) => ({
        thumbUrl: `/api/buyback/media?photo=${p.id}&size=thumb`,
      })),
      provenance: prov
        ? prov.source_type === "DEALER_STOCK"
          ? { kind: "stock" as const }
          : {
              kind: "owner" as const,
              ownerName: prov.prev_owner_name ?? undefined,
              phone: prov.prev_owner_phone ?? undefined,
              vehicle: prov.vehicle_no ?? undefined,
              idProof: prov.id_proof_type ?? undefined,
              purchaseProof: prov.has_purchase_proof ? "on file" : undefined,
            }
        : undefined,
    };
  });

  const openLinePhotos = (lineIdx: number, photoIdx: number) => {
    const line = detail.lines[lineIdx];
    const photos = evidenceByLine.get(line?.id ?? "")?.photos ?? [];
    if (photos.length === 0) return;
    const full = formatBatteryLine({
      id: line.id,
      quantity: line.quantity,
      condition: line.condition_key,
      voltage: line.voltage,
      ah: line.ah,
    }).full;
    setLightbox({
      items: photos.map((p, i) => ({
        photoId: p.id,
        caption: `${full} — photo ${i + 1} of ${photos.length}`,
      })),
      index: photoIdx,
    });
  };

  // ---- Negotiation tab: payload → the NegotiationThread atom's shape -------
  const negRounds: NegRound[] = detail.negotiation.map((r) => ({
    actor: r.actor_label,
    side: r.offered_by,
    note: r.note ?? undefined,
    at: new Date(r.created_at).toLocaleString("en-IN"),
    isFinal: r.is_final,
    isAccept: r.is_accept,
    lines: r.lines.map((l) => ({ label: l.label, amount: l.price_per_unit })),
    // U5 — per-round version, when the API sent one (final-offer rounds).
    // NegotiationThread falls back to the offerVersion prop when absent.
    version: r.version,
  }));

  // ---- Activity tab: payload → the ActivityTimeline atom's shape -----------
  const activityEntries: ActivityEntry[] = detail.activity.map((a) => ({
    at: new Date(a.created_at).toLocaleString("en-IN"),
    actor: a.role === "dealer" ? "You" : a.role === "admin" ? "iTarang" : "system",
    role: a.role,
    action: a.action,
  }));

  return (
    <div className="mx-auto max-w-4xl px-6 pb-24 pt-6">
      <button
        onClick={() => router.push("/dealer-portal/buyback")}
        className="mb-2 text-[12.5px] text-slate-500 hover:underline"
      >
        ← My Requests
      </button>

      <div className="mb-1 flex flex-wrap items-center gap-3">
        <h1 className="text-[22px] font-extrabold tracking-tight text-slate-900">
          {detail.request_no}
        </h1>
        <StatusChip status={detail.status} />
        <OfferVersionChip version={detail.offer_version} />
      </div>
      <div className="mb-4 text-[13px] text-slate-500">
        {dateLabel} · {totalUnits} units · Est. {inr(detail.dealer_quote_total)}
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <Stepper status={detail.status} />

      {/* INFO REQUESTED — names the exact batteries, not "your request", and
          gives a dashed upload box per requested item wired to the dealer photo
          upload flow. */}
      {detail.info_request && (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <div className="flex items-start gap-3">
            <span className="text-lg">⚠</span>
            <div className="flex-1">
              <p className="text-[13.5px] font-bold text-amber-900">
                Information requested by iTarang
              </p>

              {detail.info_request.target_units.length > 0 && (
                <p className="mt-1 text-[12.5px] text-amber-900">
                  <span className="font-bold">For these batteries: </span>
                  {detail.info_request.target_units.map((u) => u.label).join(" · ")}
                </p>
              )}

              <p className="mt-2 text-[12.5px] font-semibold text-amber-900">Please provide:</p>
              <ul className="mt-1 list-inside list-disc text-[12.5px] leading-6 text-amber-900">
                {detail.info_request.checklist.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>

              {detail.info_request.note && (
                <p className="mt-2 text-[12.5px] italic text-amber-800">
                  &ldquo;{detail.info_request.note}&rdquo;
                </p>
              )}

              {/* Per-checklist-item dashed upload boxes. */}
              <div className="mt-3 flex flex-wrap gap-2">
                {detail.info_request.checklist.map((c) => {
                  const u = infoUploads[c];
                  return (
                    <label
                      key={c}
                      className={`flex min-w-[180px] flex-1 items-center gap-2 rounded-lg border border-dashed border-amber-300 bg-white px-3 py-2 text-[12px] text-amber-800 ${
                        infoUploadLineId && !u?.busy
                          ? "cursor-pointer hover:bg-amber-100/50"
                          : "cursor-not-allowed opacity-70"
                      }`}
                    >
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        disabled={!infoUploadLineId || u?.busy}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f && infoUploadLineId) void uploadInfoPhoto(c, f, infoUploadLineId);
                          e.target.value = "";
                        }}
                      />
                      <span>⤒</span>
                      <span className="flex-1">
                        {u?.busy ? "Uploading…" : `Upload · ${c}`}
                        {u && u.count > 0 ? ` — ${u.count} added` : ""}
                      </span>
                      {u?.error && (
                        <span className="text-[11px] font-semibold text-red-600">{u.error}</span>
                      )}
                    </label>
                  );
                })}
              </div>

              <button
                disabled={busy}
                onClick={() => void act(`/api/buyback/requests/${id}/resubmit`)}
                className="mt-3 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-700 disabled:opacity-50"
              >
                Resubmit
              </button>
            </div>
          </div>
        </div>
      )}

      <Tabs items={TABS} />

      {/* ================================ OVERVIEW ================================ */}
      {tab === "overview" && (
        <div className="mt-4">
          {/* The count variance (M05). ABOVE the lines, deliberately: if we
              collected fewer batteries than the dealer declared, their payment is
              held, and they must be told WHY. This is the only control that
              releases that hold. Self-hides when there is no variance. */}
          <VarianceBanner requestId={detail.request_id} />

          <LinesCard
            lines={lineViews}
            totalLabel="Total"
            totalValue={inr(detail.dealer_quote_total)}
            onPhotoClick={openLinePhotos}
          />
        </div>
      )}

      {/* ============================== NEGOTIATION ============================== */}
      {tab === "neg" && (
        <div className="mt-4">
          {/* The final offer, echoed inline at the top of the thread as a
              fallback affordance (the primary is the fixed card). */}
          {canRespond && offer && (
            <div className="mb-4">
              <FinalOfferPanel offer={offer} busy={busy} onRespond={respondToOffer(act)} />
            </div>
          )}

          <NegotiationThread
            rounds={negRounds}
            viewer="dealer"
            offerVersion={detail.offer_version}
          />

          {/* Dealer counter — itemized per SKU, never a lump sum. */}
          {canCounter && (
            <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
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
                      reference_price: l.expected_price_per_unit,
                    }))}
                    values={counter}
                    onChange={(lineId, v) => setCounter((c) => ({ ...c, [lineId]: v }))}
                    referenceLabel="expected"
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
                      className="rounded-lg bg-green-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
                    >
                      Send counter
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* =============================== DOCUMENTS =============================== */}
      {tab === "docs" && (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {detail.dealer_po ? (
            <DocPreviewCard
              title="Purchase Order from iTarang"
              docNumber={detail.dealer_po.number}
              badge="Received"
              rows={[
                ["To", detail.dealer_firm ?? "Your firm"],
                ...detail.lines.map(
                  (l) =>
                    [
                      `${l.spec_label} · ${l.condition} ×${l.quantity}`,
                      perUnitShort(l.dealer_price ?? l.expected_price_per_unit),
                    ] as [string, string],
                ),
                ["Total", inr(detail.dealer_quote_total)],
              ]}
              action={
                detail.dealer_po.pdf_available ? (
                  <a
                    href={`/api/buyback/requests/${detail.request_id}/po`}
                    className="block w-full rounded-lg border border-slate-200 py-2 text-center text-xs font-semibold text-slate-600 hover:bg-slate-50"
                  >
                    Download PO (PDF)
                  </a>
                ) : undefined
              }
            />
          ) : (
            <Card className="p-4">
              <div className="text-[13.5px] font-bold text-slate-900">
                Purchase Order from iTarang
              </div>
              <div className="mt-2.5 rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-[12.5px] text-slate-400">
                PO not issued yet — appears after the deal is finalised.
              </div>
            </Card>
          )}

          {/* The dealer's invoice (M12). Keeps all its own logic — locked-price
              prefill, invoice number input, attach, status pill, returned reason.
              className="" drops its standalone top margin so it sits in the grid. */}
          <DealerInvoicePane requestId={detail.request_id} className="" />
        </div>
      )}

      {/* =============================== PAYMENTS =============================== */}
      {tab === "pay" && <PaymentsPane requestId={detail.request_id} requestNo={detail.request_no} />}

      {/* ============================== ACTIVITY LOG ============================== */}
      {tab === "log" && (
        <ActivityTimeline
          entries={activityEntries}
          labelFor={(action) => ACTIVITY_LABELS[action] ?? action.replace(/_/g, " ")}
          note="Read-only audit trail — margin & vendor events are hidden from dealers."
        />
      )}

      {/* ---- FINAL OFFER — itemized, ONE binary answer for the whole set (U5).
             The primary decision affordance: a fixed bottom-right card. Rendered
             below any modal z (there are none on this page) and below the
             lightbox (z-100). Also echoed inline at the top of the Negotiation
             tab above. ---- */}
      {canRespond && offer && (
        <div className="fixed right-6 bottom-6 z-40 w-[360px]">
          <FinalOfferPanel offer={offer} busy={busy} onRespond={respondToOffer(act)} floating />
        </div>
      )}

      {/* ---------------------------- Lightbox (Overview) ---------------------------- */}
      {lightbox && (
        <Lightbox
          items={lightbox.items}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
          onIndex={(i) => setLightbox((l) => (l ? { ...l, index: i } : l))}
        />
      )}
    </div>
  );
}

/** Curried respond handler so both the inline and fixed offer cards share it.
 *  The respond endpoint is keyed by the OFFER id, not the request id. */
function respondToOffer(act: (url: string, body?: unknown) => Promise<void>) {
  return (offerId: string, response: "ACCEPT" | "DECLINE") =>
    void act(`/api/buyback/final-offers/${offerId}/respond`, { response });
}

/**
 * The final offer, itemized per SKU with ONE Accept/Decline for the whole set.
 * Rendered both inline (top of the Negotiation tab) and as the fixed
 * bottom-right card — `floating` only changes the surface, not the content.
 */
function FinalOfferPanel({
  offer,
  busy,
  onRespond,
  floating = false,
}: {
  offer: NonNullable<Detail["final_offer"]>;
  busy: boolean;
  onRespond: (offerId: string, response: "ACCEPT" | "DECLINE") => void;
  floating?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border-2 border-amber-300 bg-white p-4 ${
        floating ? "shadow-[0_12px_40px_rgba(15,23,42,.18)]" : "shadow-sm"
      }`}
    >
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
          onClick={() => onRespond(offer.id, "ACCEPT")}
          className="flex-1 rounded-lg bg-green-600 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
        >
          Accept (YES)
        </button>
        <button
          disabled={busy}
          onClick={() => onRespond(offer.id, "DECLINE")}
          className="flex-1 rounded-lg border border-red-300 py-2 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
        >
          Decline (NO)
        </button>
      </div>
    </div>
  );
}

interface InvoiceData {
  status: string;
  invoice_total: number | null;
  lines: unknown[];
  payment: { amount: number; txn_ref: string | null; txn_date: string } | null;
}

/**
 * Payments tab (proto dealerPay, 745-750). Reads the DEALER-leg payout from the
 * invoice GET — which never selects the vendor's receipt — and shows a single
 * row: the dealer's own money, in or pending. No vendor anything.
 */
function PaymentsPane({ requestId, requestNo }: { requestId: string; requestNo: string }) {
  const [data, setData] = useState<InvoiceData | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/buyback/requests/${requestId}/invoice`);
      const json = await res.json().catch(() => null);
      if (cancelled) return;
      if (json?.success) setData(json.data ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [requestId]);

  if (!data) return null;

  const settled = data.payment != null || ["SETTLED", "CLOSED"].includes(data.status);
  const amount = data.payment?.amount ?? (data.invoice_total ?? 0);
  const hasPayout = data.payment != null || Number(data.invoice_total) > 0;

  if (!hasPayout) {
    return (
      <div className="mt-4">
        <EmptyState
          icon="💸"
          title="No payout yet"
          body="Your payout appears here once iTarang finalises the deal."
        />
      </div>
    );
  }

  const txnNo = `TXN-${requestNo.replace(/^BB-/, "")}-D`;

  return (
    <div className="mt-4">
      <Card>
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-[11px] font-bold uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-4 py-3 text-left">Transaction</th>
              <th className="px-4 py-3 text-left">Direction</th>
              <th className="px-4 py-3 text-right">Amount</th>
              <th className="px-4 py-3 text-right">Status</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-slate-100">
              <td className="px-4 py-3 font-bold text-slate-900">{txnNo}</td>
              <td className="px-4 py-3 font-semibold text-emerald-600">Payout to you (IN)</td>
              <td className="px-4 py-3 text-right tabular-nums">{inr(amount)}</td>
              <td className="px-4 py-3 text-right">
                {settled ? (
                  <StatusChip status="SETTLED" />
                ) : (
                  <span className="inline-flex rounded-full bg-amber-100 px-2.5 py-[3px] text-[11px] font-bold text-amber-700">
                    Pending
                  </span>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </Card>
      <p className="mt-2.5 text-xs text-slate-400">
        You only see your payout. Margin and vendor pricing are never shown to dealers.
      </p>
    </div>
  );
}
