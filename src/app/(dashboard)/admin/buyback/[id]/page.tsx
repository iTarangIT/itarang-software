"use client";

/**
 * M06/M07/M08 — the admin's request detail, laid out to the design prototype
 * (iTarang Portal.dc.html scrAdminDetail, lines 843-873): header, stepper,
 * actions bar, reopen banner, then five ?tab=-persisted tabs (Overview /
 * Negotiation log / Margin & Routing / Vendor Board / Activity Log).
 *
 * The four review actions are GHOSTED with a tooltip while the deal is inside
 * the review window but the state machine refuses that specific action. The
 * prototype simply hid buttons and had no disabled state anywhere; the BRD asks
 * for "ghosted+tooltip", so the copy here comes from the state machine itself —
 * `blocked_reason` is the same string the API would return in its 409. The
 * screen literally cannot claim an action is available when the server would
 * refuse it. Outside the review window the whole bar disappears (proto 854).
 *
 * Every action on this screen still posts to the same endpoint with the same
 * payload as before the re-layout — this file moved pixels, not wires.
 */

import { Suspense, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import BatteryLineLabel, { ConditionChip } from "@/components/buyback/BatteryLineLabel";
import LineInputTable from "@/components/buyback/LineInputTable";
import EvidenceReview from "@/components/buyback/EvidenceReview";
import Lightbox, { type LightboxItem } from "@/components/buyback/Lightbox";
import MoneyBoard from "@/components/buyback/MoneyBoard";
import StatusChip, { OfferVersionChip } from "@/components/buyback/StatusChip";
import VendorBoard from "@/components/buyback/VendorBoard";
import {
  ActivityTimeline,
  Card,
  LinesCard,
  NegotiationThread,
  SourceBadge,
  Stepper,
  Tabs,
  useActiveTab,
} from "@/components/buyback/ui";
import type {
  ActivityEntry,
  BuybackLineView,
  NegRound,
  TabItem,
} from "@/components/buyback/ui";
import { formatBatteryLine, inr } from "@/lib/buyback/format";

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
  has_provenance?: boolean;
  photos?: Array<{ id: string }>;
  provenance?: Array<{
    source_type: string;
    prev_owner_name: string | null;
    prev_owner_phone: string | null;
    vehicle_no: string | null;
    id_proof_type: string | null;
    payment_proof_ref: string | null;
  }>;
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

interface FinalOffer {
  id: string;
  version_no: number;
  status: string;
  note: string | null;
  sent_at: string | null;
  responded_at: string | null;
  lines: Array<{ line_id: string; price_per_unit: number; quantity: number }>;
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
  source_channel: string;
  created_at: string;
  submitted_at: string | null;
  dealer_name: string | null;
  dealer_city: string | null;
  floor_total: string | null;
  lines: Line[];
  negotiation: Round[];
  final_offers?: FinalOffer[];
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

/** Proto 854 — the whole actions bar only exists inside the review window. */
const ACTION_BAR_STATES = [
  "SUBMITTED",
  "UNDER_REVIEW",
  "INFO_REQUESTED",
  "NEGOTIATING",
  "FINAL_OFFER_SENT",
];

const TABS: TabItem[] = [
  { key: "overview", label: "Overview" },
  { key: "neg", label: "Negotiation log" },
  { key: "margin", label: "Margin & Routing" },
  { key: "vendors", label: "Vendor Board" },
  { key: "log", label: "Activity Log" },
];

export default function AdminBuybackDetailPage() {
  // useActiveTab reads useSearchParams(), which requires a Suspense boundary
  // above it for the build-time prerender pass.
  return (
    <Suspense fallback={<div className="p-10 text-slate-400">Loading…</div>}>
      <AdminBuybackDetail />
    </Suspense>
  );
}

function AdminBuybackDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const tab = useActiveTab(TABS);

  const [d, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [lightbox, setLightbox] = useState<{ items: LightboxItem[]; index: number } | null>(
    null,
  );

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

  // ---- Derived, display-only numbers --------------------------------------
  const dealerQuote = d.lines.reduce(
    (s, l) => s + Number(l.expected_price_per_unit ?? 0) * l.quantity,
    0,
  );
  const totalUnits = d.lines.reduce((s, l) => s + l.quantity, 0);
  const provPct =
    d.lines.length === 0
      ? 0
      : Math.round((100 * d.lines.filter((l) => l.has_provenance).length) / d.lines.length);

  const dateLabel = new Date(d.submitted_at ?? d.created_at).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

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

  // The vendor-facing quotation preview shows the LOCKED ask once margin is
  // set (that is what the vendor was actually quoted), else the live preview.
  const quotePreview = marginPreview.map((r) => ({
    ...r,
    ask: r.line.vendor_ask != null ? Number(r.line.vendor_ask) : r.ask,
  }));
  const quoteTotal = quotePreview.reduce((s, r) => s + r.ask * r.line.quantity, 0);

  const marginEditable = can("set_margin");

  // ---- Overview tab: lines mapped onto the LinesCard atom ------------------
  const lineViews: BuybackLineView[] = d.lines.map((l) => {
    const f = formatBatteryLine(l);
    const prov = l.provenance?.[0];
    return {
      id: l.id,
      label: l.variant_type,
      qty: l.quantity,
      condition: l.condition,
      spec: f.specLabel,
      measured: l.measured_voltage ? `${l.measured_voltage}V` : undefined,
      expectedPerUnit:
        l.expected_price_per_unit != null ? Number(l.expected_price_per_unit) : undefined,
      lockedPerUnit: l.dealer_price != null ? Number(l.dealer_price) : undefined,
      lineTotal: Number(l.expected_price_per_unit ?? 0) * l.quantity,
      photos: (l.photos ?? []).map((p) => ({
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
              purchaseProof: prov.payment_proof_ref ?? undefined,
            }
        : undefined,
    };
  });

  const openLinePhotos = (lineIdx: number, photoIdx: number) => {
    const line = d.lines[lineIdx];
    const photos = line?.photos ?? [];
    if (photos.length === 0) return;
    setLightbox({
      items: photos.map((p, i) => ({
        photoId: p.id,
        caption: `${formatBatteryLine(line).full} — photo ${i + 1} of ${photos.length}`,
      })),
      index: photoIdx,
    });
  };

  // ---- Negotiation tab: payload → the NegotiationThread atom's shape -------
  const labelFor = (lineId: string, qty: number): string => {
    const line = d.lines.find((l) => l.id === lineId);
    if (!line) return `×${qty}`;
    const f = formatBatteryLine(line);
    return `${f.specLabel} · ${f.condition} ×${qty}`;
  };

  const fmtWhen = (at: string | null): string | undefined =>
    at ? new Date(at).toLocaleString("en-IN") : undefined;

  const negRounds: NegRound[] = [
    ...d.negotiation.map((r) => ({
      at: new Date(r.created_at).getTime(),
      round: {
        actor: r.offered_by_role === "admin" ? "iTarang" : (d.dealer_name ?? "Dealer"),
        side: (r.offered_by_role === "admin" ? "admin" : "dealer") as "admin" | "dealer",
        note: r.note ?? undefined,
        at: fmtWhen(r.created_at),
        lines: r.lines.map((l) => ({
          label: `${l.label} ×${l.quantity}`,
          amount: l.price_per_unit,
        })),
      } satisfies NegRound,
    })),
    // Final offers live in their own table, not in negotiation_rounds — weave
    // them into the thread so the FINAL (and, once accepted, ACCEPTED) chips
    // appear where the prototype put them.
    ...(d.final_offers ?? []).map((o) => ({
      at: new Date(o.sent_at ?? 0).getTime(),
      round: {
        actor: "iTarang",
        side: "admin" as const,
        note: o.note ?? undefined,
        at: fmtWhen(o.sent_at),
        isFinal: true,
        isAccept: o.status === "ACCEPTED",
        lines: o.lines.map((fl) => ({
          label: labelFor(fl.line_id, fl.quantity),
          amount: Number(fl.price_per_unit),
        })),
      } satisfies NegRound,
    })),
  ]
    .sort((a, b) => a.at - b.at)
    .map((x) => x.round);

  // ---- Activity tab: payload → the ActivityTimeline atom's shape -----------
  const activityEntries: ActivityEntry[] = d.activity.map((a) => ({
    at: new Date(a.created_at).toLocaleString("en-IN"),
    actor:
      a.role === "dealer"
        ? (d.dealer_name ?? "Dealer")
        : a.role === "admin"
          ? "iTarang"
          : "system",
    role: a.role,
    action: a.action.replace(/_/g, " "),
  }));

  return (
    <div className="mx-auto max-w-5xl px-6 pb-24 pt-6">
      <button
        onClick={() => router.push("/admin/buyback")}
        className="mb-2 text-[12.5px] text-slate-500 hover:underline"
      >
        ← Review Queue
      </button>

      <div className="mb-1 flex flex-wrap items-center gap-3">
        <h1 className="text-[22px] font-extrabold tracking-tight text-slate-900">
          {d.request_no}
        </h1>
        <StatusChip status={d.status} />
        <OfferVersionChip version={d.offer_version} />
        <SourceBadge source={d.source_channel} />
      </div>
      <div className="mb-4 text-[13px] text-slate-500">
        {d.dealer_name ?? "—"} · {d.dealer_city ?? "—"} · {dateLabel} · Dealer quote{" "}
        {inr(dealerQuote)}
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <Stepper status={d.status} />

      {/* ---- The review actions bar (proto 854). Individual buttons the state
             machine refuses are ghosted with its reason as the tooltip. ---- */}
      {ACTION_BAR_STATES.includes(d.status) && (
        <Card className="mt-2">
          <div className="flex flex-wrap items-center gap-2 p-3.5">
            <span className="mr-1 text-xs font-bold uppercase tracking-wide text-slate-400">
              Actions
            </span>

            <ActionButton
              label="Accept"
              tone="green"
              state={actionOf("accept")}
              busy={busy}
              onClick={() =>
                void post(`/api/admin/buyback/requests/${id}/decision`, { action: "accept" })
              }
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
                  void post(`/api/admin/buyback/requests/${id}/decision`, {
                    action: "start_review",
                  })
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
                className="rounded-lg bg-bb-navy px-4 py-2 text-sm font-semibold text-white hover:bg-bb-navy/90"
              >
                Send Final Offer
              </button>
            )}
          </div>
        </Card>
      )}

      {/* Reopen — provisional acceptance, any time before the vendor agrees
          (proto 863-866). `can` comes from the state machine, whose reopenable
          set is exactly the pre-vendor-agreement states. */}
      {can("reopen") && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-amber-200 bg-amber-50 px-3.5 py-3">
          <p className="text-[12.5px] text-amber-800">
            <span className="font-bold">Dealer acceptance is provisional.</span> Reopen until
            vendor agreement — offer becomes v{d.offer_version + 1}, dealer notified.
          </p>
          <button
            disabled={busy}
            onClick={() => void post(`/api/admin/buyback/requests/${id}/reopen`, {})}
            className="rounded-lg border border-amber-300 bg-white px-3.5 py-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-100"
          >
            Reopen negotiation
          </button>
        </div>
      )}

      <Tabs items={TABS} />

      {/* ================================ OVERVIEW ================================ */}
      {tab === "overview" && (
        <>
          <div className="mt-4 grid gap-4 lg:grid-cols-[1.6fr_1fr]">
            <LinesCard
              lines={lineViews}
              totalLabel="Dealer quote"
              totalValue={inr(dealerQuote)}
              onPhotoClick={openLinePhotos}
            />

            <Card>
              <div className="p-4">
                <div className="mb-2.5 text-[13px] font-bold">Dealer &amp; quote</div>
                {(
                  [
                    ["Firm", d.dealer_name ?? "—"],
                    ["City", d.dealer_city ?? "—"],
                    ["Source", <SourceBadge key="src" source={d.source_channel} />],
                    ["Units", String(totalUnits)],
                    ["Dealer quote", inr(dealerQuote)],
                    ["Provenance", `${provPct}% complete`],
                  ] as Array<[string, React.ReactNode]>
                ).map(([label, value]) => (
                  <div
                    key={label}
                    className="flex items-center justify-between border-b border-[#F4F6F9] py-1.5 text-[12.5px] last:border-0"
                  >
                    <span className="text-slate-500">{label}</span>
                    <span className="font-semibold">{value}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          {/* ---- The evidence (M03/M04). Photos to zoom into, and the ID proof
                 that says the battery was the previous owner's to sell. Kept on
                 the DEFAULT tab, directly under the lines: if checking provenance
                 costs an extra click, it is the click that gets skipped on a busy
                 afternoon — and the one time it mattered will be the one time
                 nobody looked. ---- */}
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

          {/* ---- Money: invoice approval, settlement, close (M12/M13). It
                 self-hides outside money states, and its full-page reload comes
                 back to this same tab via ?tab=. ---- */}
          <MoneyBoard requestId={id} status={d.status} allowedActions={d.allowed_actions} />
        </>
      )}

      {/* ============================ NEGOTIATION LOG ============================ */}
      {tab === "neg" && (
        <div className="mt-4">
          <NegotiationThread rounds={negRounds} viewer="admin" offerVersion={d.offer_version} />
          <p className="mt-2.5 text-xs text-slate-400">
            Counters and final offers are composed from the Actions bar — every offer prices
            each battery line.
          </p>
        </div>
      )}

      {/* ============================ MARGIN & ROUTING ============================ */}
      {tab === "margin" && (
        <div className="mt-4">
          <div className="mb-4 flex items-center gap-2 rounded-[10px] bg-bb-navy px-[15px] py-[11px] text-[12.5px] text-white">
            <span>🔒</span>
            <span>
              <b>Dealer never sees margin or the final/vendor price.</b> These fields exist
              only inside iTarang admin.
            </span>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* ---- Margin setup (M08) ---- */}
            <Card>
              <div className="p-[18px]">
                <div className="text-[13px] font-bold">Margin setup — per SKU</div>
                <p className="mb-3 mt-1 text-xs text-slate-500">
                  Margin applies to each line; final ask is computed per SKU.
                </p>

                <div className="mb-3 flex items-center gap-2">
                  {(["FLAT", "PCT"] as const).map((mode) => (
                    <button
                      key={mode}
                      disabled={!marginEditable}
                      title={
                        marginEditable
                          ? undefined
                          : "Margin can be set once the dealer has accepted the final offer."
                      }
                      onClick={() => setMarginMode(mode)}
                      className={`rounded-lg px-3.5 py-1.5 text-[12.5px] font-semibold ${
                        marginMode === mode
                          ? "bg-bb-navy text-white"
                          : "border border-gray-200 bg-white text-slate-500"
                      } ${marginEditable ? "" : "cursor-not-allowed opacity-50"}`}
                    >
                      {mode === "FLAT" ? "Flat ₹" : "%"}
                    </button>
                  ))}
                  <input
                    type="number"
                    value={marginValue}
                    disabled={!marginEditable}
                    title={
                      marginEditable
                        ? undefined
                        : "Margin can be set once the dealer has accepted the final offer."
                    }
                    onChange={(e) => setMarginValue(e.target.value)}
                    className="w-28 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm tabular-nums disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
                  />
                  <span className="text-xs text-slate-500">
                    {marginMode === "FLAT" ? "per unit, every SKU" : "% of the dealer price"}
                  </span>
                </div>

                <div className="overflow-hidden rounded-lg border border-gray-200">
                  <div className="grid grid-cols-[1.6fr_1fr_1fr_1fr] bg-[#FAFBFC] px-3 py-2 text-[10.5px] font-bold uppercase tracking-wide text-slate-400">
                    <span>SKU</span>
                    <span className="text-right">Dealer</span>
                    <span className="text-right">+Margin</span>
                    <span className="text-right">Final ask</span>
                  </div>

                  {marginPreview.map(({ line, dealer, margin, ask }) => (
                    <div
                      key={line.id}
                      className="grid grid-cols-[1.6fr_1fr_1fr_1fr] items-center border-t border-slate-100 px-3 py-2 text-[12.5px] tabular-nums"
                    >
                      <span className="font-semibold">
                        <BatteryLineLabel line={line} />
                      </span>
                      <span className="text-right">{inr(dealer)}</span>
                      <span className="text-right font-semibold text-green-700">
                        +{inr(margin)}
                      </span>
                      <span className="text-right font-extrabold">{inr(ask)}</span>
                    </div>
                  ))}

                  <div className="grid grid-cols-[1.6fr_1fr_1fr_1fr] border-t border-gray-200 bg-green-50 px-3 py-2 text-[12.5px] font-extrabold tabular-nums text-green-800">
                    <span>Order total</span>
                    <span className="text-right">{inr(dealerTotal)}</span>
                    <span className="text-right">+{inr(askTotal - dealerTotal)}</span>
                    <span className="text-right">{inr(askTotal)}</span>
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
                    className="mt-4 w-full rounded-lg bg-green-600 py-2.5 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
                  >
                    Lock margin &amp; continue
                  </button>
                )}

                {d.status === "MARGIN_SET" && (
                  <p className="mt-3 text-xs text-slate-500">
                    Margin is locked (floor {inr(d.floor_total)}). Quote the lot out to the
                    vendors on the right.
                  </p>
                )}
              </div>
            </Card>

            {/* ---- Vendor-facing quotation preview + routing (proto 914-925) ---- */}
            <Card>
              <div className="p-4">
                <div className="mb-2.5 text-[13px] font-bold">
                  Quotation PDF — vendor-facing preview
                </div>

                <div className="overflow-hidden rounded-lg border border-gray-200">
                  <div className="flex items-center justify-between bg-bb-navy px-3.5 py-2.5">
                    <span className="text-[12.5px] font-bold text-white">
                      iTarang · Scrap Battery Quotation
                    </span>
                    <span className="text-[10.5px] text-[#7C93A8]">Q-{d.request_no}</span>
                  </div>
                  <div className="p-3.5 text-[12.5px]">
                    {quotePreview.map(({ line, ask }) => {
                      const f = formatBatteryLine(line);
                      return (
                        <div
                          key={line.id}
                          className="flex items-center justify-between border-b border-[#F4F6F9] py-[7px]"
                        >
                          <span className="flex flex-wrap items-center gap-1.5">
                            {f.specLabel} ×{line.quantity}
                            <ConditionChip condition={line.condition} />
                            <span className="text-[11px] text-slate-400">
                              {line.photo_count} photos
                            </span>
                          </span>
                          <b className="tabular-nums text-green-600">{inr(ask)}/u</b>
                        </div>
                      );
                    })}
                    <div className="flex items-center justify-between pt-2.5 text-sm">
                      <span className="font-bold">Total ask</span>
                      <b className="tabular-nums text-green-600">{inr(quoteTotal)}</b>
                    </div>
                    <div className="mt-2.5 rounded-md bg-slate-50 px-2.5 py-[7px] text-[11px] text-slate-400">
                      ⚠ Per-SKU ask prices, condition &amp; photos only. No dealer name or
                      contact.
                    </div>
                  </div>
                </div>

                {/* Vendor multi-select + "send" — the board's routing section.
                    Same fetch/POST as ever; it renders nothing until the state
                    machine allows route_to_vendors. */}
                <VendorBoard requestId={id} section="routing" />
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* ============================== VENDOR BOARD ============================== */}
      {tab === "vendors" && (
        <div className="mt-4">
          <VendorBoard requestId={id} section="threads" />
        </div>
      )}

      {/* ============================== ACTIVITY LOG ============================== */}
      {tab === "log" && (
        <ActivityTimeline entries={activityEntries} note="Read-only audit trail." />
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
    green: "bg-green-600 text-white hover:bg-green-700",
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
