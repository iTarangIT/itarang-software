"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  CheckCircle2,
  ChevronRight,
  AlertCircle,
  Banknote,
  Package,
  Plus,
  RefreshCw,
  Clock,
  X,
  ShieldCheck,
} from "lucide-react";

import {
  ProgressHeader,
  SectionCard,
  StickyBottomBar,
  PrimaryButton,
  SecondaryButton,
  OutlineButton,
  ErrorBanner,
  FullPageLoader,
} from "@/components/dealer-portal/lead-wizard/shared";
import {
  CartPricingSummary,
  ProductCartSections,
  ProductCategoryCard,
  inr,
  useProductCart,
  useProductScope,
} from "@/components/dealer-portal/lead-wizard/product-cart";
import type {
  BatteryRow,
  ChargerRow,
  PriorSelection,
} from "@/components/dealer-portal/lead-wizard/product-cart";
import FinancingOffersSection from "./FinancingOffersSection";
import NbfcDocRequestsBlock from "./NbfcDocRequestsBlock";

// BRD V2 Part E §2.2 — Step 4 Product Selection (dealer side)
//
// Since the Step-4/Step-5 split this page means "send this customer to the
// lenders". For a FINANCE lead it keeps only:
//   G. Financing Options — the 1–2 NBFC picks + customer disclosure
//   Pre-sanction documents
//   The Financing Offers thread once lenders respond
//
// Category / Product Type AND the Battery / Charger / Paraphernalia / Pricing
// cart all moved to Step 5, where the dealer picks real stock once the lender
// has quoted. A CASH lead still does all of it HERE, because a cash lead
// completes at Step 4 and never reaches Step 5 (see step-5-access).

interface AccessData {
  allowed: boolean;
  paymentMode?: "cash" | "finance";
  dealerId?: string | null;
  customerName?: string | null;
  category?: string | null;
  categoryName?: string | null;
  productId?: string | null;
  productTypeName?: string | null;
  productSku?: string | null;
  kycStatus?: string;
  redirectTo?: string;
  readOnly?: boolean;
  reason?: string;
  priorSelection?: PriorSelection | null;
}

// Kept byte-identical so browser drafts written before the cart extraction
// still rehydrate. The cart hook namespaces its own key off this prefix.
const DRAFT_KEY_PREFIX = "step4-draft";

export default function ProductSelectionPage() {
  const params = useParams();
  const router = useRouter();
  const leadId = params.id as string;

  const [access, setAccess] = useState<AccessData | null>(null);
  const [dealerId, setDealerId] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<null | {
    leadStatus: string;
    warrantyId?: string;
    productSelectionId?: string;
  }>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [lastSaved, setLastSaved] = useState<string | null>(null);

  // E-208 — Step-4 pre-sanction document bucket (≤10 items, all formats). Items
  // are uploaded immediately and held here; sent with the submit / draft payload
  // and stored on product_selections.pre_sanction_doc_urls.
  type PreSanctionDoc = { url: string; name: string; type: string; size: number };
  const [preSanctionDocs, setPreSanctionDocs] = useState<PreSanctionDoc[]>([]);
  const [preSanctionUploading, setPreSanctionUploading] = useState(false);
  const [preSanctionError, setPreSanctionError] = useState<string | null>(null);

  // E-130 / Addendum V0.1 §5.2 — Section G Financing Options (finance only).
  // The customer picks 1 or 2 NBFCs from the BRE-matched list (stub returns
  // all assigned NBFCs in Phase 2). disclosureAck is the mandatory checkbox
  // confirming the customer was told each picked NBFC verifies independently.
  type SectionGProduct = {
    id: number;
    productName: string;
    loanAmountMin: number;
    loanAmountMax: number;
    tenureMonthsMin: number;
    tenureMonthsMax: number;
    minRoiPct: string;
    maxRoiPct: string;
    downPaymentPct: string;
  };
  type SectionGNbfc = {
    nbfcId: number;
    nbfcCode: string;
    shortName: string;
    legalName: string;
    activeLoanProducts: SectionGProduct[];
  };
  const [sectionGOptions, setSectionGOptions] = useState<SectionGNbfc[]>([]);
  const [sectionGLoading, setSectionGLoading] = useState(false);
  const [sectionGError, setSectionGError] = useState<string | null>(null);
  const [selectedNbfcs, setSelectedNbfcs] = useState<{ nbfc_id: string; loan_product_id: number }[]>([]);
  const [customerDisclosureAck, setCustomerDisclosureAck] = useState(false);

  const preSanctionRestoredRef = useRef(false);

  // Refetch step-4-access so categoryName / productTypeName / productId
  // re-resolve on the page after a Section A edit.
  const refetchAccess = useCallback(async () => {
    try {
      const res = await fetch(`/api/lead/${leadId}/step-4-access`);
      const json = await res.json();
      if (json.success) setAccess(json.data);
    } catch {
      setError("Failed to refresh lead context");
    }
  }, [leadId]);

  // The scope narrows the cart, and a category change clears the cart — so the
  // two reference each other. The ref breaks the cycle: the scope hook is
  // declared first and reaches the cart's reset indirectly.
  const resetCartRef = useRef<() => void>(() => {});

  // Category / Product Type. Cash only — a finance lead sets these on Step 5.
  const scope = useProductScope({
    leadId,
    category: access?.category ?? null,
    productId: access?.productId ?? null,
    refetchLead: refetchAccess,
    onSelectionInvalidated: () => resetCartRef.current(),
    onError: setError,
  });

  // ── The product cart ────────────────────────────────────────────────
  // Cash leads pick their category and stock here (they complete at Step 4 and
  // never see Step 5). Finance leads do both on Step 5 once a lender has
  // quoted, so the hook gets a null dealerId and never fetches inventory here.
  const isCash = access?.paymentMode === "cash";
  const cart = useProductCart({
    leadId,
    dealerId: isCash ? dealerId : null,
    category: access?.category ?? null,
    scopeProducts: scope.selectedProducts,
    prior: (access?.priorSelection as PriorSelection | null) ?? null,
    readOnly: !!access?.readOnly,
    includeSerials: {
      battery: access?.priorSelection?.battery_serial ?? null,
      charger: access?.priorSelection?.charger_serial ?? null,
    },
    draftKeyPrefix: DRAFT_KEY_PREFIX,
    onError: setError,
  });
  const { selectedBattery, selectedCharger, resetSelection } = cart;

  useEffect(() => {
    resetCartRef.current = resetSelection;
  }, [resetSelection]);


  // ── Load access + dealer id ─────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const accessRes = await fetch(`/api/lead/${leadId}/step-4-access`);
        const accessJson = await accessRes.json();
        if (cancelled) return;
        if (!accessJson.success) {
          setError(accessJson.error?.message || "Unable to check access");
          setLoading(false);
          return;
        }
        const a: AccessData = accessJson.data;
        setAccess(a);
        setDealerId(a.dealerId ?? null);

        if (!a.allowed && a.redirectTo) {
          router.replace(a.redirectTo);
          return;
        }
      } catch {
        if (!cancelled) setError("Failed to load access");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [leadId, router]);

  // ── Restore the pre-sanction bucket from the submitted selection ─────
  // The cart's own state (serials, quantities, margin, photos) rehydrates
  // inside useProductCart; this bucket stays here because it belongs to the
  // finance section, not the cart.
  useEffect(() => {
    if (preSanctionRestoredRef.current) return;
    if (!access?.allowed) return;
    const prior = access.priorSelection;
    if (prior && Array.isArray(prior.pre_sanction_doc_urls)) {
      setPreSanctionDocs(prior.pre_sanction_doc_urls);
    }
    preSanctionRestoredRef.current = true;
  }, [access]);

  // ── Submit gating ───────────────────────────────────────────────────
  // Charger is optional — a battery-only sale (with or without paraphernalia)
  // is a valid order. Inventory-side guards still enforce that any charger
  // serial submitted has to be a real available row.
  // Addendum V0.1 §5.2 — Section G applies to finance leads only.
  const isFinanceLead = access?.paymentMode === "finance";
  const sectionGSatisfied = useMemo(() => {
    if (!isFinanceLead) return true;
    if (selectedNbfcs.length < 1 || selectedNbfcs.length > 2) return false;
    if (!customerDisclosureAck) return false;
    return true;
  }, [isFinanceLead, selectedNbfcs.length, customerDisclosureAck]);

  // A battery is required only for cash, where this page IS the sale. A
  // finance lead is going out for an offer, not shipping anything yet — the
  // serial is picked on Step 5.
  const pendingRequirements = useMemo(() => {
    const list: string[] = [];
    if (isCash && !selectedBattery) list.push("Battery serial");
    if (isFinanceLead && selectedNbfcs.length < 1) list.push("Pick 1 or 2 NBFCs in Section G");
    if (isFinanceLead && !customerDisclosureAck) list.push("Confirm the customer disclosure in Section G");
    return list;
  }, [isCash, selectedBattery, isFinanceLead, selectedNbfcs.length, customerDisclosureAck]);

  const canSubmit =
    (!isCash || !!selectedBattery) &&
    !submitting &&
    !access?.readOnly &&
    sectionGSatisfied;

  // ── Section G — load BRE-matched NBFCs (Addendum §5.2). Stub returns all
  //    of the dealer's assigned NBFCs with active loan products. Phase 3
  //    swaps this for a real customer-attribute BRE match. Re-runs are
  //    cheap so we fetch once when finance access is confirmed.
  useEffect(() => {
    if (!access || access.paymentMode !== "finance" || access.readOnly) return;
    let cancelled = false;
    setSectionGLoading(true);
    setSectionGError(null);
    (async () => {
      try {
        const res = await fetch(`/api/lead/${leadId}/section-g-options`);
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok || !json.success) {
          throw new Error(json?.error?.message || "Failed to load financing options");
        }
        setSectionGOptions(json.data.items as SectionGNbfc[]);
      } catch (err: unknown) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : "Failed to load financing options";
          setSectionGError(message);
        }
      } finally {
        if (!cancelled) setSectionGLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [access, leadId]);

  const toggleNbfcPick = useCallback(
    (nbfcId: number, loanProductId: number) => {
      setSelectedNbfcs((prev) => {
        const idStr = String(nbfcId);
        const idx = prev.findIndex((p) => p.nbfc_id === idStr);
        if (idx >= 0) {
          const existing = prev[idx];
          if (existing.loan_product_id === loanProductId) {
            // Same product re-clicked — toggle the NBFC off.
            return prev.filter((_, i) => i !== idx);
          }
          // A different product of an already-picked NBFC — swap the product
          // in place. One product per NBFC, so the pick count is unchanged.
          const next = [...prev];
          next[idx] = { nbfc_id: idStr, loan_product_id: loanProductId };
          return next;
        }
        if (prev.length >= 2) {
          // Cap at 2 NBFCs per §6.2; replace the oldest pick so dealer can
          // swap lenders easily.
          return [...prev.slice(1), { nbfc_id: idStr, loan_product_id: loanProductId }];
        }
        return [...prev, { nbfc_id: idStr, loan_product_id: loanProductId }];
      });
    },
    [],
  );

  // E-208/E-209 — persist the current pre-sanction bucket to
  // product_selections.pre_sanction_doc_urls immediately, so uploads survive a
  // reload even when Save Draft / Submit are unavailable (i.e. after the
  // selection is frozen). No-ops server-side if no selection row exists yet —
  // in that case Save Draft / Submit will persist it. Best-effort.
  const persistPreSanctionDocs = useCallback(
    async (items: PreSanctionDoc[]) => {
      try {
        await fetch(`/api/lead/${leadId}/pre-sanction-doc`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items }),
        });
      } catch {
        // best-effort; the next Save Draft / Submit will reconcile.
      }
    },
    [leadId],
  );

  // E-208 — upload files into the Step-4 pre-sanction bucket. mode 'separate'
  // adds one item per file; 'combine' merges image/PDF files into one PDF item.
  const uploadPreSanctionDocs = useCallback(
    async (fileList: FileList | File[], mode: "separate" | "combine") => {
      const files = Array.from(fileList);
      if (files.length === 0) return;
      setPreSanctionError(null);
      // Enforce the 10-item cap (a combined upload is one item).
      const willAdd = mode === "combine" ? 1 : files.length;
      if (preSanctionDocs.length + willAdd > 10) {
        setPreSanctionError(`Up to 10 items only (you have ${preSanctionDocs.length}).`);
        return;
      }
      setPreSanctionUploading(true);
      try {
        const fd = new FormData();
        files.forEach((f) => fd.append("files", f));
        fd.append("mode", mode);
        const res = await fetch(`/api/lead/${leadId}/pre-sanction-doc`, {
          method: "POST",
          body: fd,
        });
        const json = await res.json();
        if (!res.ok || !json.ok) {
          throw new Error(json?.error || "Upload failed");
        }
        const next = [...preSanctionDocs, ...(json.items as PreSanctionDoc[])];
        setPreSanctionDocs(next);
        void persistPreSanctionDocs(next);
      } catch (err: unknown) {
        setPreSanctionError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setPreSanctionUploading(false);
      }
    },
    [leadId, preSanctionDocs, persistPreSanctionDocs],
  );

  // ── Handlers ────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!canSubmit) return;
    if (isCash) {
      if (!selectedBattery) return;
      setConfirmOpen(true);
      return;
    }
    await runSubmit("finance");
  };

  const runSubmit = async (mode: "cash" | "finance") => {
    setSubmitting(true);
    setError(null);
    try {
      // The cart contributes serials, the GST snapshot and the totals. On a
      // finance lead it is empty — that is the point of the split; the API
      // accepts a submission with no product on it.
      const body = {
        ...cart.toSubmitPayload(),
        category: access?.category ?? undefined,
        productId: access?.productId ?? undefined,
        // E-130 / Addendum V0.1 §5.2, §5.3 — finance-only.
        ...(mode === "finance"
          ? {
              selectedNbfcs: selectedNbfcs.map((s) => ({
                nbfc_id: s.nbfc_id,
                loan_product_id: s.loan_product_id,
              })),
              customerDisclosureAck,
              // E-208 — Step-4 pre-sanction document bucket (finance/NBFC only).
              preSanctionDocs,
            }
          : {}),
      };
      const endpoint =
        mode === "cash"
          ? `/api/lead/${leadId}/confirm-cash-sale`
          : `/api/lead/${leadId}/submit-product-selection`;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json.success) {
        setSubmitted(json.data);
        setConfirmOpen(false);
        cart.clearLocalDraft();
      } else {
        setError(json.error?.message || "Submit failed");
      }
    } catch {
      setError("Submit failed");
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveDraft = async () => {
    // Local snapshot first — keeps the page hydrated on reload without a
    // round-trip and survives offline.
    setLastSaved(cart.saveLocalDraft());

    // Server persist — this is what makes the lead show up in /My Drafts.
    // Mirrors the submit body shape, but every field is optional on the API
    // so partial drafts work.
    try {
      const body: Record<string, unknown> = {
        ...cart.toSubmitPayload(),
        category: access?.category ?? undefined,
        subCategory: access?.productId ?? undefined,
        // E-208 — persist the pre-sanction bucket across Save Draft.
        preSanctionDocs,
      };
      const res = await fetch(
        `/api/lead/${leadId}/product-selection/draft`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const json = await res.json();
      if (!json.success) {
        setError(json.error?.message || "Could not save draft on server");
      }
    } catch {
      setError("Could not save draft on server");
    }
  };

  const handleStepClick = (target: number) => {
    if (target === 4) return;
    const routes: Record<number, string> = {
      1: `/dealer-portal/leads/${leadId}`,
      2: `/dealer-portal/leads/${leadId}/kyc`,
      3: `/dealer-portal/leads/${leadId}/borrower-consent`,
      5: `/dealer-portal/leads/${leadId}/step-5`,
    };
    const route = routes[target];
    if (route) router.push(route);
  };

  // ── Render ──────────────────────────────────────────────────────────

  if (loading) return <FullPageLoader />;
  if (error && !access)
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F8F9FB] p-8">
        <div className="text-red-600 font-medium">{error}</div>
      </div>
    );
  if (!access?.allowed)
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F8F9FB] p-8">
        <div className="text-gray-600">{access?.reason || "Not available"}</div>
      </div>
    );

  if (submitted) {
    const soldOutright = submitted.leadStatus === "sold";
    return (
      <div className="min-h-screen bg-[#F8F9FB] flex items-center justify-center p-6">
        <div className="bg-white rounded-3xl border border-gray-100 shadow-[0_8px_30px_rgb(0,0,0,0.04)] max-w-xl w-full p-10 text-center">
          <div
            className={`w-20 h-20 mx-auto mb-6 rounded-full flex items-center justify-center ${
              soldOutright ? "bg-emerald-50" : "bg-blue-50"
            }`}
          >
            {soldOutright ? (
              <CheckCircle2 className="w-12 h-12 text-emerald-600" />
            ) : (
              <Clock className="w-12 h-12 text-[#0047AB]" />
            )}
          </div>
          <h2 className="text-2xl font-black text-gray-900 tracking-tight">
            {soldOutright ? "Sale Confirmed" : "Sent to NBFC"}
          </h2>
          <p className="text-sm text-gray-500 mt-3 leading-relaxed max-w-sm mx-auto">
            {soldOutright
              ? `Inventory marked SOLD and warranty activated for lead ${leadId}.`
              : "The selected lender(s) will review this customer and come back with an offer. You'll be notified — then pick the battery and dispatch on Step 5."}
          </p>
          {submitted.warrantyId && (
            <div className="mt-6 inline-flex items-center gap-2 px-4 py-2 bg-emerald-50 border border-emerald-100 rounded-full">
              <ShieldCheck className="w-4 h-4 text-emerald-600" />
              <span className="text-xs font-bold text-emerald-700 tracking-wide">
                Warranty {submitted.warrantyId}
              </span>
            </div>
          )}
          <div className="mt-8 flex justify-center gap-3 flex-wrap">
            <PrimaryButton onClick={() => router.push("/dealer-portal/leads")}>
              Back to Leads
            </PrimaryButton>
            {(submitted.leadStatus === "loan_sanctioned" ||
              submitted.leadStatus === "pending_final_approval") && (
              <SecondaryButton
                onClick={() => router.push(`/dealer-portal/leads/${leadId}/step-5`)}
              >
                Go to Step 5 <ChevronRight className="w-4 h-4" />
              </SecondaryButton>
            )}
          </div>
        </div>
      </div>
    );
  }

  const subtitleParts = [`Lead #${leadId}`];
  if (access.customerName) subtitleParts.push(access.customerName);

  return (
    // -mx-6 cancels the dashboard layout's mobile p-6 so cards run edge-to-edge
    // on phones; reverts at sm+ (desktop/tablet unchanged).
    <div className="min-h-screen bg-[#F8F9FB] -mx-6 sm:mx-0">
      <div className="max-w-[1200px] mx-auto px-0 sm:px-6 py-8 pb-40">
        <ProgressHeader
          title="Product Selection"
          subtitle={subtitleParts.join(" — ")}
          step={4}
          totalSteps={5}
          workflowLabel={isCash ? "Cash Sale" : "Finance Application"}
          onBack={() => router.push("/dealer-portal/leads")}
          onPrev={() => handleStepClick(3)}
          onNext={() => handleStepClick(5)}
          onStepClick={handleStepClick}
          rightAction={
            <div className="flex items-center gap-3">
              {isCash && (
                <button
                  onClick={() => cart.reload()}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white border border-gray-200 hover:bg-gray-50 text-sm font-semibold text-gray-700"
                >
                  <RefreshCw
                    className={`w-4 h-4 ${cart.batteryList.loading ? "animate-spin" : ""}`}
                  />{" "}
                  Refresh
                </button>
              )}
              <span
                className={`px-3 py-1.5 rounded-full text-[11px] font-black uppercase tracking-widest border ${
                  isCash
                    ? "bg-amber-50 text-amber-700 border-amber-200"
                    : "bg-blue-50 text-[#0047AB] border-blue-200"
                }`}
              >
                {isCash ? "Cash Sale" : "Finance"}
              </span>
            </div>
          }
        />

        {isCash && (
          <div className="mb-6 flex items-start gap-3 px-5 py-4 rounded-2xl bg-amber-50 border-2 border-amber-200">
            <Banknote className="w-5 h-5 text-amber-700 flex-shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-black text-amber-900">CASH SALE — KYC steps skipped</p>
              <p className="text-amber-800 mt-0.5">
                Confirming will mark inventory <strong>SOLD</strong> and activate warranty
                immediately. There is no admin approval step.
              </p>
            </div>
          </div>
        )}

        <ErrorBanner message={error} onDismiss={() => setError(null)} />

        {access.readOnly && (
          <div className="mb-6 flex items-start gap-3 px-5 py-4 rounded-2xl bg-blue-50 border border-blue-200 text-sm text-blue-900">
            <ShieldCheck className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <span>
              This lead is in <strong>{access.kycStatus}</strong>.{" "}
              {access.reason ||
                "Product selection is read-only — visit Step 5 for the next action."}
            </span>
          </div>
        )}

        {/* §6.1/§6.2 — firm offers from picked NBFCs + winner selection. Self-hides for cash / un-routed leads. */}
        <FinancingOffersSection leadId={leadId} />

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-8 space-y-6">
            {/* Section A — Category & Product Type. Cash only: a finance
                lead sets these on Step 5 alongside the stock it scopes. */}
            {isCash && (
              <ProductCategoryCard
                scope={scope}
                category={access.category ?? null}
                categoryName={access.categoryName}
                productId={access.productId ?? null}
                productTypeName={access.productTypeName}
                productSku={access.productSku}
                readOnly={!!access.readOnly}
              />
            )}

            {/* Sections B–D — the product cart. Cash only: a finance lead
                picks its stock on Step 5, once the lender has quoted. */}
            {isCash && <ProductCartSections cart={cart} />}

            {/* Section G — Financing Options (Addendum V0.1 §5.2).
                Finance leads only. The customer picks 1 or 2 NBFCs from the
                BRE-matched list (Phase 2 stub returns all assigned NBFCs);
                each selected NBFC will independently run FI + Active Video
                KYC after submit, then submit firm financing conditions for
                customer winner-pick. Mandatory disclosure checkbox confirms
                the customer was told this. */}
            {isFinanceLead && !access.readOnly && (
              <SectionG
                options={sectionGOptions}
                loading={sectionGLoading}
                error={sectionGError}
                selected={selectedNbfcs}
                onTogglePick={toggleNbfcPick}
                disclosureAck={customerDisclosureAck}
                onDisclosureChange={setCustomerDisclosureAck}
              />
            )}

            {/* Pre-sanction documents bucket (E-208) — optional, finance only.
                Up to 10 items, any format; the NBFC + admin can view these
                before sanction. Combine multiple images/PDFs into one PDF.
                Stays enabled even after the selection is frozen (readOnly) — the
                dealer can send pre-sanction docs to the lender at any time; each
                add/remove is persisted immediately (see uploadPreSanctionDocs). */}
            {isFinanceLead && (
              <SectionCard
                title="Pre-sanction documents (optional)"
                action={
                  <span className="text-xs font-semibold text-slate-500">
                    {preSanctionDocs.length}/10
                  </span>
                }
              >
                {/* E-240 — anything the lender asked for DIRECTLY, answered in
                    place. Renders above the generic controls because it is the
                    one thing here someone is actually waiting on; self-hides
                    when there are no open requests. */}
                <NbfcDocRequestsBlock
                  leadId={leadId}
                  onDocsMirrored={(items) => setPreSanctionDocs(items)}
                />
                <p className="mb-3 text-xs text-slate-500">
                  Attach anything the lender needs before sanction — installation
                  images, NBFC-signed docs, agreements. Any format (image, video,
                  zip, PDF), up to 10 items. You can also merge several images /
                  PDFs into one PDF.
                </p>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <label
                    className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 ${
                      preSanctionUploading || preSanctionDocs.length >= 10
                        ? "pointer-events-none opacity-50"
                        : ""
                    }`}
                  >
                    <Plus className="h-4 w-4" />
                    Add documents
                    <input
                      type="file"
                      multiple
                      className="hidden"
                      disabled={preSanctionUploading || preSanctionDocs.length >= 10}
                      onChange={(e) => {
                        if (e.target.files?.length) {
                          void uploadPreSanctionDocs(e.target.files, "separate");
                        }
                        e.target.value = "";
                      }}
                    />
                  </label>
                  <label
                    className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-teal-300 bg-teal-50 px-3 py-1.5 text-sm font-semibold text-teal-700 hover:bg-teal-100 ${
                      preSanctionUploading || preSanctionDocs.length >= 10
                        ? "pointer-events-none opacity-50"
                        : ""
                    }`}
                  >
                    <Package className="h-4 w-4" />
                    Combine &amp; upload as one PDF
                    <input
                      type="file"
                      multiple
                      accept="image/*,application/pdf"
                      className="hidden"
                      disabled={preSanctionUploading || preSanctionDocs.length >= 10}
                      onChange={(e) => {
                        if (e.target.files?.length) {
                          void uploadPreSanctionDocs(e.target.files, "combine");
                        }
                        e.target.value = "";
                      }}
                    />
                  </label>
                  {preSanctionUploading ? (
                    <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Uploading…
                    </span>
                  ) : null}
                </div>
                {preSanctionError ? (
                  <p className="mb-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs text-rose-700">
                    {preSanctionError}
                  </p>
                ) : null}
                {preSanctionDocs.length > 0 ? (
                  <ul className="space-y-2">
                    {preSanctionDocs.map((d, i) => (
                      <li
                        key={`${d.url}-${i}`}
                        className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2"
                      >
                        <a
                          href={d.url}
                          target="_blank"
                          rel="noreferrer"
                          className="min-w-0 flex-1 truncate text-sm font-medium text-teal-700 hover:underline"
                          title={d.name}
                        >
                          {d.name}
                        </a>
                        <span className="shrink-0 text-[10px] uppercase tracking-wide text-slate-400">
                          {(d.type.split("/")[1] || d.type || "file").slice(0, 8)}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            const next = preSanctionDocs.filter((_, idx) => idx !== i);
                            setPreSanctionDocs(next);
                            void persistPreSanctionDocs(next);
                          }}
                          className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-rose-600"
                          aria-label="Remove"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-slate-400">No documents added yet.</p>
                )}
              </SectionCard>
            )}
          </div>

          {/* Right rail — Pricing summary (sticky on desktop, stays pinned
              while the dealer scrolls through battery/charger/paraphernalia).
              max-h + overflow lets a tall card scroll internally instead of
              getting clipped under the viewport.
              Cash only — a finance lead has no price at this stage. */}
          {isCash && (
            <div className="lg:col-span-4">
              <div className="lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto">
                <CartPricingSummary
                  cart={cart}
                  inventoryNote="Inventory will be marked SOLD on confirm"
                />
              </div>
            </div>
          )}
        </div>

        {pendingRequirements.length > 0 && !access.readOnly && (
          <div className="mt-6 flex items-center justify-end">
            <p className="text-xs font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-4 py-2">
              <AlertCircle className="w-3.5 h-3.5 inline mr-1.5 -mt-0.5" />
              Complete to submit: {pendingRequirements.join(", ")}
            </p>
          </div>
        )}
      </div>

      <StickyBottomBar lastSaved={lastSaved}>
        {/* Exactly one step back in the wizard: finance → Step 3
            (borrower-consent); cash → Step 1 (lead detail, its only prior step).
            router.back() was unreliable (browser history, not the wizard). */}
        <OutlineButton
          onClick={() =>
            router.push(
              access.paymentMode === "cash"
                ? `/dealer-portal/leads/${leadId}`
                : `/dealer-portal/leads/${leadId}/borrower-consent`,
            )
          }
        >
          Back
        </OutlineButton>
        {access.readOnly ? (
          // Read-only follow-ups by lead state. Once admin has acted, the
          // dealer's next move lives at Step 5 — surface a clear CTA so they
          // are not stranded staring at a disabled Submit button.
          access.kycStatus === "loan_sanctioned" ||
          access.kycStatus === "loan_rejected" ? (
            <PrimaryButton
              onClick={() => router.push(`/dealer-portal/leads/${leadId}/step-5`)}
            >
              Go to Step 5
              <ChevronRight className="w-4 h-4" />
            </PrimaryButton>
          ) : access.kycStatus === "pending_final_approval" ? (
            <span className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm font-bold">
              <Clock className="w-4 h-4" />
              Awaiting admin approval
            </span>
          ) : access.kycStatus === "sold" ? (
            <span className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm font-bold">
              <CheckCircle2 className="w-4 h-4" />
              Sale completed
            </span>
          ) : null
        ) : (
          <>
            <SecondaryButton onClick={handleSaveDraft}>
              Save Draft
            </SecondaryButton>
            {isCash ? (
              <button
                onClick={handleSubmit}
                disabled={!canSubmit}
                className="px-8 py-2.5 bg-emerald-600 text-white rounded-xl text-sm font-bold hover:bg-emerald-700 transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? "Confirming…" : "Confirm Sale"}
                <ChevronRight className="w-4 h-4" />
              </button>
            ) : (
              <PrimaryButton onClick={handleSubmit} disabled={!canSubmit} loading={submitting}>
                Send to NBFC
                <ChevronRight className="w-4 h-4" />
              </PrimaryButton>
            )}
          </>
        )}
      </StickyBottomBar>

      {confirmOpen && selectedBattery && selectedCharger && (
        <CashConfirmModal
          customerName={access.customerName || "—"}
          battery={selectedBattery}
          charger={selectedCharger}
          finalPrice={cart.live.finalPrice}
          submitting={submitting}
          error={error}
          onCancel={() => {
            setError(null);
            setConfirmOpen(false);
          }}
          onConfirm={() => runSubmit("cash")}
        />
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function CashConfirmModal({
  customerName,
  battery,
  charger,
  finalPrice,
  submitting,
  error,
  onCancel,
  onConfirm,
}: {
  customerName: string;
  battery: BatteryRow;
  charger: ChargerRow;
  finalPrice: number;
  submitting: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-3xl shadow-2xl max-w-lg w-full overflow-hidden">
        <div className="px-7 pt-7 pb-4 flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-full bg-emerald-50 flex items-center justify-center">
              <CheckCircle2 className="w-6 h-6 text-emerald-600" />
            </div>
            <div>
              <h3 className="text-xl font-black text-gray-900 tracking-tight">
                Confirm Sale
              </h3>
              <p className="text-[11px] text-gray-500 mt-0.5">
                Review the details below before confirming
              </p>
            </div>
          </div>
          <button
            onClick={onCancel}
            disabled={submitting}
            className="p-1 hover:bg-gray-100 rounded-lg"
            aria-label="Close"
          >
            <X className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        <div className="px-7 pb-2">
          <div className="rounded-2xl bg-gray-50 border border-gray-100 divide-y divide-gray-100">
            <ConfirmRow label="Customer" value={customerName} />
            <ConfirmRow
              label="Battery"
              value={
                <span className="font-mono text-xs">
                  {battery.serial_number} · {battery.model_name || battery.model_type || "—"}
                  {" · "}
                  {battery.inventory_age_days}d
                  {battery.soc_percent != null && ` · SOC ${battery.soc_percent}%`}
                </span>
              }
            />
            <ConfirmRow
              label="Charger"
              value={
                <span className="font-mono text-xs">
                  {charger.serial_number} · {charger.model_name || charger.model_type || "—"}
                </span>
              }
            />
            <ConfirmRow
              label="Final Price"
              value={
                <span className="text-lg font-black text-[#0047AB] tabular-nums">
                  {inr(finalPrice)}
                </span>
              }
            />
          </div>

          <div className="mt-4 flex items-start gap-2 px-3 py-2.5 rounded-xl bg-amber-50 border border-amber-200">
            <AlertCircle className="w-4 h-4 text-amber-700 flex-shrink-0 mt-0.5" />
            <p className="text-[11px] text-amber-800 font-medium leading-relaxed">
              By confirming, inventory will be marked <strong>SOLD</strong> and
              warranty will be activated immediately. This cannot be undone.
            </p>
          </div>

          {error && (
            <div className="mt-3 flex items-start gap-2 px-3 py-2.5 rounded-xl bg-red-50 border border-red-200">
              <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
              <p className="text-[11px] text-red-700 font-medium leading-relaxed">
                {error}
              </p>
            </div>
          )}
        </div>

        <div className="px-7 py-5 bg-gray-50/50 border-t border-gray-100 flex justify-end gap-3">
          <OutlineButton onClick={onCancel} disabled={submitting}>
            Cancel
          </OutlineButton>
          <button
            onClick={onConfirm}
            disabled={submitting}
            className="px-8 py-2.5 bg-emerald-600 text-white rounded-xl text-sm font-bold hover:bg-emerald-700 transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? "Confirming…" : "Confirm Sale"}
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfirmRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <span className="text-[11px] font-black uppercase tracking-widest text-gray-400 flex-shrink-0">
        {label}
      </span>
      <span className="text-sm font-bold text-gray-900 text-right truncate">
        {value}
      </span>
    </div>
  );
}

function SectionG({
  options,
  loading,
  error,
  selected,
  onTogglePick,
  disclosureAck,
  onDisclosureChange,
}: {
  options: Array<{
    nbfcId: number;
    nbfcCode: string;
    shortName: string;
    legalName: string;
    activeLoanProducts: Array<{
      id: number;
      productName: string;
      loanAmountMin: number;
      loanAmountMax: number;
      tenureMonthsMin: number;
      tenureMonthsMax: number;
      minRoiPct: string;
      maxRoiPct: string;
      downPaymentPct: string;
    }>;
  }>;
  loading: boolean;
  error: string | null;
  selected: Array<{ nbfc_id: string; loan_product_id: number }>;
  onTogglePick: (nbfcId: number, loanProductId: number) => void;
  disclosureAck: boolean;
  onDisclosureChange: (next: boolean) => void;
}) {
  // Selection is keyed per product now (one card per loan product), while the
  // cap is still on distinct NBFCs (max 2). pickedProductIds drives the card's
  // selected state; pickedNbfcIds gates which NBFCs are still selectable.
  const pickedProductIds = new Set(selected.map((s) => s.loan_product_id));
  const pickedNbfcIds = new Set(selected.map((s) => s.nbfc_id));
  const isNbfcPicked = (nbfcId: number) => pickedNbfcIds.has(String(nbfcId));
  const pickCount = selected.length;

  return (
    <SectionCard title="Financing Options">
      <div className="mb-3 px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-xl">
        <p className="text-[11px] text-amber-800 leading-relaxed">
          <strong>Indicative — subject to verification.</strong> Final terms are
          confirmed by the lender after Field Investigation and Active Video
          KYC. The customer may select <strong>up to two</strong> lending partners;
          each verifies independently and submits a firm offer.
        </p>
      </div>

      {loading ? (
        <div className="py-6 text-center text-xs text-gray-400">Loading lender options…</div>
      ) : error ? (
        <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-xs font-medium text-red-700 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      ) : options.length === 0 ? (
        <div className="py-6 text-center text-xs text-gray-500">
          No lending partners are currently available for this dealer. The
          lead will be routed to Manual Handoff after submit.
        </div>
      ) : (
        <div className="space-y-5">
          {options.map((opt, idx) => {
            const nbfcPicked = isNbfcPicked(opt.nbfcId);
            // When two NBFCs are already chosen, every product of any other
            // NBFC is locked (one product per NBFC, max two NBFCs).
            const nbfcLocked = !nbfcPicked && pickCount >= 2;
            return (
              <div key={opt.nbfcId} className="space-y-2">
                <div className="flex items-center gap-2 px-1">
                  <span className="text-[11px] font-bold uppercase tracking-wide text-gray-600">
                    {`iTarang Scheme ${idx + 1} (${opt.nbfcCode})`}
                  </span>
                  {opt.activeLoanProducts.length > 1 && (
                    <span className="text-[10px] text-gray-400">
                      · pick one of {opt.activeLoanProducts.length}
                    </span>
                  )}
                </div>
                {opt.activeLoanProducts.length === 0 ? (
                  <p className="text-[11px] text-gray-400 px-1">
                    No active products from this partner right now.
                  </p>
                ) : (
                  opt.activeLoanProducts.map((product) => {
                    const picked = pickedProductIds.has(product.id);
                    const disablePick = !picked && nbfcLocked;
                    return (
                      <button
                        key={product.id}
                        type="button"
                        onClick={() => onTogglePick(opt.nbfcId, product.id)}
                        disabled={disablePick}
                        className={`w-full text-left p-4 rounded-2xl border-2 transition-all ${
                          picked
                            ? "border-[#0047AB] bg-blue-50/60 shadow-sm"
                            : disablePick
                              ? "border-gray-100 bg-gray-50 opacity-60 cursor-not-allowed"
                              : "border-gray-200 bg-white hover:border-[#0047AB] hover:shadow-sm"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-bold text-gray-900 truncate">
                              {product.productName}
                            </div>
                          </div>
                          <div
                            className={`w-5 h-5 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${
                              picked
                                ? "border-[#0047AB] bg-[#0047AB]"
                                : "border-gray-300"
                            }`}
                          >
                            {picked && (
                              <CheckCircle2 className="w-3 h-3 text-white" />
                            )}
                          </div>
                        </div>
                        <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
                          <RangeStat
                            label="ROI"
                            value={`${product.minRoiPct}% – ${product.maxRoiPct}%`}
                          />
                          <RangeStat
                            label="Tenure"
                            value={`${product.tenureMonthsMin} – ${product.tenureMonthsMax} mo`}
                          />
                          <RangeStat
                            label="Down payment"
                            value={`${product.downPaymentPct}%`}
                          />
                          <RangeStat
                            label="Loan amount"
                            value={`₹${product.loanAmountMin.toLocaleString("en-IN")} – ₹${product.loanAmountMax.toLocaleString("en-IN")}`}
                          />
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            );
          })}
          <p className="text-[11px] text-gray-400 px-1">
            {pickCount === 0
              ? "Pick the lender(s) the customer wants to apply with."
              : `Selected: ${pickCount} of 2 lender${pickCount === 1 ? "" : "s"}.`}
          </p>
        </div>
      )}

      <label className="mt-4 flex items-start gap-3 px-3 py-3 rounded-xl border-2 border-gray-200 bg-gray-50 cursor-pointer">
        <input
          type="checkbox"
          checked={disclosureAck}
          onChange={(e) => onDisclosureChange(e.target.checked)}
          className="mt-0.5 w-4 h-4 rounded border-gray-300 text-[#0047AB] focus:ring-[#0047AB]"
        />
        <span className="text-xs text-gray-700 leading-relaxed">
          I confirm I have <strong>informed the customer</strong> that each
          selected lending partner will independently verify them (including
          Field Investigation and Active Video KYC), and that final terms may
          differ from the indicative ranges shown above.
        </span>
      </label>
    </SectionCard>
  );
}

function RangeStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-2 py-1.5 bg-white border border-gray-100 rounded-lg">
      <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400">{label}</div>
      <div className="text-xs font-bold text-gray-900 mt-0.5 truncate">{value}</div>
    </div>
  );
}

// Addendum V0.1 §5.1 — battery/charger photo upload block. Two named slots
// (serial close-up + unit photo) plus an "Add Another" option for extra
// shots. Uploads happen one at a time; URLs come back from
// /api/lead/[id]/product-photo and are tracked by the parent.