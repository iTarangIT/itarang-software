"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  CheckCircle2,
  ChevronRight,
  AlertCircle,
  Banknote,
  CalendarDays,
  Battery as BatteryIcon,
  Plug,
  Package,
  Sparkles,
  Minus,
  Plus,
  RefreshCw,
  Clock,
  X,
  ShieldCheck,
  Wallet,
  TrendingUp,
  ChevronDown,
  Pencil,
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

// BRD V2 Part E §2.2 — Step 4 Product Selection (dealer side)
// Sections:
//   A. Category/Sub-Category
//   B. Battery Selection (ageing-sorted)
//   C. Charger Selection (compatibility filtered)
//   D. Paraphernalia (count-tracked)
//   E. Pricing & Margin
//   F. Submit (Finance: for final approval / Cash: confirm sale)

interface BatteryRow {
  id: string;
  serial_number: string;
  model_name: string | null;
  model_type: string | null;
  invoice_date: string | null;
  inventory_age_days: number;
  age_badge: "fresh" | "ageing" | "old";
  soc_percent: string | null;
  soc_last_sync_at?: string | null;
  status?: string | null;
  price: number | null;
  voltage_v?: number | null;
  capacity_ah?: number | null;
  warranty_months?: number | null;
  // GST snapshot from inventory.
  gross_amount?: string | number | null;
  gst_percent?: string | number | null;
  gst_amount?: string | number | null;
  net_amount?: string | number | null;
  recommended: boolean;
}

interface ChargerRow {
  id: string;
  serial_number: string;
  model_name: string | null;
  model_type: string | null;
  invoice_date?: string | null;
  inventory_age_days: number;
  age_badge: "fresh" | "ageing" | "old";
  status?: string | null;
  price: number | null;
  warranty_months?: number | null;
  gross_amount?: string | number | null;
  gst_percent?: string | number | null;
  gst_amount?: string | number | null;
  net_amount?: string | number | null;
  recommended: boolean;
}

interface ParaRow {
  product_id?: string | null;
  asset_type: string;
  model_type: string | null;
  product_name: string | null;
  available_qty: number;
  unit_price: number | null;
  unit_gross?: number | null;
  gst_percent?: string | number | null;
  unit_gst_amount?: number | null;
  unit_net?: number | null;
}

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
}

const DRAFT_KEY = (leadId: string) => `step4-draft-${leadId}`;

const inrFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

const inr = (n: number) => inrFormatter.format(Number.isFinite(n) ? n : 0);

export default function ProductSelectionPage() {
  const params = useParams();
  const router = useRouter();
  const leadId = params.id as string;

  const [access, setAccess] = useState<AccessData | null>(null);
  const [dealerId, setDealerId] = useState<string | null>(null);

  const [batteries, setBatteries] = useState<BatteryRow[]>([]);
  const [chargers, setChargers] = useState<ChargerRow[]>([]);
  const [paraphernalia, setParaphernalia] = useState<ParaRow[]>([]);

  const [selectedBattery, setSelectedBattery] = useState<BatteryRow | null>(null);
  const [selectedCharger, setSelectedCharger] = useState<ChargerRow | null>(null);
  const [paraQty, setParaQty] = useState<Record<string, number>>({});
  // Dealer margin can be entered as flat rupees OR as a % of the net subtotal.
  // The actual rupee value is derived (see dealerMargin useMemo below) so the
  // two inputs stay in sync with the live cart total.
  const [marginMode, setMarginMode] = useState<"rupees" | "percent">("rupees");
  const [marginInput, setMarginInput] = useState<string>("0");
  const [marginPercentInput, setMarginPercentInput] = useState<string>("0");

  const [batteryFilter, setBatteryFilter] = useState<"all" | "recommended" | "ageing" | "old">("all");
  const [batteriesLoading, setBatteriesLoading] = useState(false);
  const [chargersLoading, setChargersLoading] = useState(false);

  // Section A — editable Category / Product Type. Lists feed the dropdowns.
  // Edits PATCH the lead row, so the change propagates back to Step 1.
  type CatOption = { id: string; name: string; slug: string };
  type ProdOption = {
    id: string;
    name: string;
    sku: string;
    voltage_v: number | null;
    capacity_ah: number | null;
    warranty_months?: number | null;
  };
  const [categories, setCategories] = useState<CatOption[]>([]);
  const [productsList, setProductsList] = useState<ProdOption[]>([]);
  const [savingCategory, setSavingCategory] = useState(false);

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

  const draftRestoredRef = useRef(false);

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

  // ── Load Category list once for the editable dropdown ───────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/inventory/categories");
        const json = await res.json();
        if (cancelled) return;
        if (json.success) setCategories(json.data || []);
      } catch {
        // non-fatal — Section A just falls back to read-only display.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Load Product Type list whenever the active category changes ──────
  useEffect(() => {
    let cancelled = false;
    if (!access?.category) {
      setProductsList([]);
      return;
    }
    const cat = categories.find((c) => c.id === access.category);
    if (!cat) return; // wait for categories to arrive
    (async () => {
      try {
        const res = await fetch(
          `/api/inventory/products?category=${encodeURIComponent(cat.slug)}`,
        );
        const json = await res.json();
        if (cancelled) return;
        if (json.success) setProductsList(json.data || []);
      } catch {
        // non-fatal
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [access?.category, categories]);

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

  // PATCH the lead with new category/product. Per BRD §3077–3080, switching
  // category clears any previously chosen battery / charger / paraphernalia
  // (their compatibility no longer holds).
  const patchLead = useCallback(
    async (body: {
      product_category_id?: string;
      primary_product_id?: string | null;
    }) => {
      const res = await fetch(`/api/dealer/leads/${leadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.success) {
        throw new Error(json.error?.message || "Failed to update lead");
      }
    },
    [leadId],
  );

  const handleCategoryChange = useCallback(
    async (newCategoryId: string) => {
      if (!newCategoryId || newCategoryId === access?.category) return;
      setSavingCategory(true);
      try {
        // Changing category invalidates the previously picked product.
        await patchLead({
          product_category_id: newCategoryId,
          primary_product_id: null,
        });
        setSelectedBattery(null);
        setSelectedCharger(null);
        setParaQty({});
        await refetchAccess();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to update category");
      } finally {
        setSavingCategory(false);
      }
    },
    [access?.category, patchLead, refetchAccess],
  );

  const handleProductChange = useCallback(
    async (newProductId: string) => {
      if (!newProductId || newProductId === access?.productId) return;
      setSavingCategory(true);
      try {
        await patchLead({ primary_product_id: newProductId });
        // Different product → previous battery serial is no longer valid.
        setSelectedBattery(null);
        setSelectedCharger(null);
        await refetchAccess();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to update product type");
      } finally {
        setSavingCategory(false);
      }
    },
    [access?.productId, patchLead, refetchAccess],
  );

  // ── Load battery + paraphernalia inventory once dealer ready ─────────
  const loadBatteriesAndPara = useCallback(async () => {
    if (!dealerId || !access?.allowed) return;
    setBatteriesLoading(true);
    try {
      const batQs = new URLSearchParams();
      if (access.category) batQs.set("category", access.category);
      // Filter batteries to the exact product the dealer picked at Step 1.
      if (access.productId) batQs.set("productId", access.productId);
      const paraQs = new URLSearchParams();
      if (access.category) paraQs.set("category", access.category);

      const [batRes, paraRes] = await Promise.all([
        fetch(`/api/inventory/dealer/${dealerId}/batteries?${batQs.toString()}`),
        fetch(`/api/inventory/dealer/${dealerId}/paraphernalia?${paraQs.toString()}`),
      ]);
      const batJson = await batRes.json();
      const paraJson = await paraRes.json();
      if (batJson.success) setBatteries(batJson.data || []);
      if (paraJson.success) setParaphernalia(paraJson.data || []);
    } catch {
      setError("Failed to load inventory");
    } finally {
      setBatteriesLoading(false);
    }
  }, [dealerId, access]);

  useEffect(() => {
    void loadBatteriesAndPara();
  }, [loadBatteriesAndPara]);

  // ── Restore draft from localStorage once batteries are loaded ───────
  useEffect(() => {
    if (draftRestoredRef.current) return;
    if (!batteries.length || !access?.allowed) return;
    try {
      const raw = localStorage.getItem(DRAFT_KEY(leadId));
      if (!raw) {
        draftRestoredRef.current = true;
        return;
      }
      const draft = JSON.parse(raw) as {
        batterySerial?: string;
        chargerSerial?: string;
        paraQty?: Record<string, number>;
        dealerMargin?: number;
        marginMode?: "rupees" | "percent";
        marginInput?: string;
        marginPercentInput?: string;
        savedAt?: string;
      };
      const b = batteries.find((x) => x.serial_number === draft.batterySerial);
      if (b) setSelectedBattery(b);
      if (draft.paraQty) setParaQty(draft.paraQty);
      if (draft.marginMode === "percent" || draft.marginMode === "rupees") {
        setMarginMode(draft.marginMode);
      }
      if (typeof draft.marginInput === "string") {
        setMarginInput(draft.marginInput);
      } else if (typeof draft.dealerMargin === "number") {
        // legacy drafts (rupees-only)
        setMarginInput(String(draft.dealerMargin));
      }
      if (typeof draft.marginPercentInput === "string") {
        setMarginPercentInput(draft.marginPercentInput);
      }
      if (draft.savedAt) setLastSaved(formatLastSaved(new Date(draft.savedAt)));
    } catch {
      // ignore corrupted draft
    } finally {
      draftRestoredRef.current = true;
    }
  }, [batteries, access, leadId]);

  // ── Load chargers once a battery is selected ────────────────────────
  useEffect(() => {
    if (!dealerId || !selectedBattery) {
      setChargers([]);
      setSelectedCharger(null);
      return;
    }
    let cancelled = false;
    setChargersLoading(true);
    (async () => {
      try {
        const qs = new URLSearchParams();
        if (selectedBattery.model_type) qs.set("batteryModel", selectedBattery.model_type);
        if (access?.category) qs.set("category", access.category);
        const res = await fetch(`/api/inventory/dealer/${dealerId}/chargers?${qs.toString()}`);
        const json = await res.json();
        if (cancelled) return;
        if (json.success) {
          setChargers(json.data || []);
          // Restore selected charger from draft if applicable
          try {
            const raw = localStorage.getItem(DRAFT_KEY(leadId));
            if (raw) {
              const draft = JSON.parse(raw) as { chargerSerial?: string };
              if (draft.chargerSerial) {
                const c = (json.data || []).find(
                  (x: ChargerRow) => x.serial_number === draft.chargerSerial,
                );
                if (c) setSelectedCharger(c);
              }
            }
          } catch {
            // ignore
          }
        }
      } catch {
        if (!cancelled) setError("Failed to load chargers");
      } finally {
        if (!cancelled) setChargersLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dealerId, selectedBattery, access, leadId]);

  // ── Pricing calculations (per-line gross/GST/net + totals) ──────────
  const batteryPriceTriple = useMemo(() => triple(selectedBattery), [selectedBattery]);
  const chargerPriceTriple = useMemo(() => triple(selectedCharger), [selectedCharger]);

  const paraLines = useMemo(() => {
    return paraphernalia
      .map((p) => {
        const qty = paraQty[paraKey(p)] || 0;
        const unitGross = Number(p.unit_gross ?? p.unit_price ?? 0);
        const gstPct = Number(p.gst_percent ?? 0);
        const unitGstAmt =
          Number(p.unit_gst_amount) || Math.round((unitGross * gstPct) / 100);
        const unitNet = Number(p.unit_net) || unitGross + unitGstAmt;
        return {
          asset_type: p.asset_type,
          model_type: p.model_type,
          product_name: p.product_name,
          product_id: p.product_id ?? null,
          qty,
          unit_gross: unitGross,
          gst_percent: gstPct,
          gst_amount: unitGstAmt,
          unit_net: unitNet,
          line_gross: qty * unitGross,
          line_gst: qty * unitGstAmt,
          line_net: qty * unitNet,
        };
      })
      .filter((l) => l.qty > 0);
  }, [paraphernalia, paraQty]);

  const paraCost = useMemo(
    () => paraLines.reduce((s, l) => s + l.line_net, 0),
    [paraLines],
  );
  const paraGross = useMemo(
    () => paraLines.reduce((s, l) => s + l.line_gross, 0),
    [paraLines],
  );
  const paraGst = useMemo(
    () => paraLines.reduce((s, l) => s + l.line_gst, 0),
    [paraLines],
  );

  const grossSubtotal =
    batteryPriceTriple.gross + chargerPriceTriple.gross + paraGross;
  const gstSubtotal =
    batteryPriceTriple.gst + chargerPriceTriple.gst + paraGst;
  const netSubtotal =
    batteryPriceTriple.net + chargerPriceTriple.net + paraCost;

  // Backward-compat aliases used by existing UI fragments.
  const batteryPrice = batteryPriceTriple.net;
  const chargerPrice = chargerPriceTriple.net;

  // Effective margin in rupees. In percent mode it's a live function of
  // netSubtotal so changing the cart auto-updates the margin amount.
  const dealerMargin = useMemo(() => {
    if (marginMode === "percent") {
      const p = parseFloat(marginPercentInput);
      if (!Number.isFinite(p) || p < 0) return 0;
      return Math.round((netSubtotal * p) / 100);
    }
    const r = parseFloat(marginInput);
    return Number.isFinite(r) && r >= 0 ? r : 0;
  }, [marginMode, marginPercentInput, marginInput, netSubtotal]);

  const finalPrice = netSubtotal + Number(dealerMargin || 0);

  // ── Filter battery list ─────────────────────────────────────────────
  const filteredBatteries = useMemo(() => {
    switch (batteryFilter) {
      case "recommended":
        return batteries.filter((b) => b.recommended);
      case "ageing":
        return batteries.filter((b) => b.age_badge === "ageing");
      case "old":
        return batteries.filter((b) => b.age_badge === "old");
      default:
        return batteries;
    }
  }, [batteries, batteryFilter]);

  const ageingCount = batteries.filter((b) => b.age_badge === "ageing").length;
  const oldCount = batteries.filter((b) => b.age_badge === "old").length;
  const recommendedCount = batteries.filter((b) => b.recommended).length;

  // ── Submit gating ───────────────────────────────────────────────────
  const pendingRequirements = useMemo(() => {
    const list: string[] = [];
    if (!selectedBattery) list.push("Battery serial");
    if (!selectedCharger) list.push("Charger serial");
    return list;
  }, [selectedBattery, selectedCharger]);

  const canSubmit =
    !!selectedBattery &&
    !!selectedCharger &&
    !submitting &&
    !access?.readOnly;

  const paramList = useMemo(() => {
    const result: Record<string, number | string> = {};
    paraphernalia.forEach((p) => {
      const k = paraKey(p);
      if (paraQty[k] > 0) result[k] = paraQty[k];
    });
    return result;
  }, [paraphernalia, paraQty]);

  // ── Handlers ────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!canSubmit || !selectedBattery || !selectedCharger) return;
    if (access?.paymentMode === "cash") {
      setConfirmOpen(true);
      return;
    }
    await runSubmit("finance");
  };

  const runSubmit = async (mode: "cash" | "finance") => {
    setSubmitting(true);
    setError(null);
    try {
      const body = {
        batterySerial: selectedBattery!.serial_number,
        chargerSerial: selectedCharger!.serial_number,
        paraphernalia: paramList,
        paraphernaliaLines: paraLines,
        dealerMargin: Number(dealerMargin || 0),
        finalPrice,
        batteryPrice,
        chargerPrice,
        paraphernaliaCost: paraCost,
        // GST snapshot — captured exactly as displayed.
        batteryGross: batteryPriceTriple.gross,
        batteryGstPercent: batteryPriceTriple.gstPct,
        batteryGstAmount: batteryPriceTriple.gst,
        batteryNet: batteryPriceTriple.net,
        chargerGross: chargerPriceTriple.gross,
        chargerGstPercent: chargerPriceTriple.gstPct,
        chargerGstAmount: chargerPriceTriple.gst,
        chargerNet: chargerPriceTriple.net,
        grossSubtotal,
        gstSubtotal,
        netSubtotal,
        category: access?.category ?? undefined,
        productId: access?.productId ?? undefined,
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
        try {
          localStorage.removeItem(DRAFT_KEY(leadId));
        } catch {
          // ignore
        }
      } else {
        setError(json.error?.message || "Submit failed");
      }
    } catch {
      setError("Submit failed");
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveDraft = () => {
    try {
      const payload = {
        batterySerial: selectedBattery?.serial_number ?? null,
        chargerSerial: selectedCharger?.serial_number ?? null,
        paraQty,
        dealerMargin,
        marginMode,
        marginInput,
        marginPercentInput,
        savedAt: new Date().toISOString(),
      };
      localStorage.setItem(DRAFT_KEY(leadId), JSON.stringify(payload));
      setLastSaved(formatLastSaved(new Date()));
    } catch {
      setError("Could not save draft locally");
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
    const isCash = submitted.leadStatus === "sold";
    return (
      <div className="min-h-screen bg-[#F8F9FB] flex items-center justify-center p-6">
        <div className="bg-white rounded-3xl border border-gray-100 shadow-[0_8px_30px_rgb(0,0,0,0.04)] max-w-xl w-full p-10 text-center">
          <div
            className={`w-20 h-20 mx-auto mb-6 rounded-full flex items-center justify-center ${
              isCash ? "bg-emerald-50" : "bg-blue-50"
            }`}
          >
            {isCash ? (
              <CheckCircle2 className="w-12 h-12 text-emerald-600" />
            ) : (
              <Clock className="w-12 h-12 text-[#0047AB]" />
            )}
          </div>
          <h2 className="text-2xl font-black text-gray-900 tracking-tight">
            {isCash ? "Sale Confirmed" : "Submitted for Final Approval"}
          </h2>
          <p className="text-sm text-gray-500 mt-3 leading-relaxed max-w-sm mx-auto">
            {isCash
              ? `Inventory marked SOLD and warranty activated for lead ${leadId}.`
              : "Admin will review your submission and respond with the loan decision. You'll be notified."}
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

  const paymentMode = access.paymentMode || "finance";
  const isCash = paymentMode === "cash";
  const subtitleParts = [`Lead #${leadId}`];
  if (access.customerName) subtitleParts.push(access.customerName);

  return (
    <div className="min-h-screen bg-[#F8F9FB]">
      <div className="max-w-[1200px] mx-auto px-6 py-8 pb-40">
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
              <button
                onClick={() => loadBatteriesAndPara()}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white border border-gray-200 hover:bg-gray-50 text-sm font-semibold text-gray-700"
              >
                <RefreshCw className={`w-4 h-4 ${batteriesLoading ? "animate-spin" : ""}`} /> Refresh
              </button>
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

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-8 space-y-6">
            {/* Section A — Category & Product Type (editable; mirrors Step 1) */}
            <SectionCard title="Category">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {access.readOnly ? (
                  <ReadOnlyField
                    label="Product Category"
                    value={access.categoryName || access.category || "—"}
                  />
                ) : (
                  <EditableSelectField
                    label="Product Category"
                    value={access.category ?? ""}
                    options={categories.map((c) => ({ value: c.id, label: c.name }))}
                    onChange={handleCategoryChange}
                    saving={savingCategory}
                    disabled={!categories.length}
                  />
                )}
                {access.readOnly ? (
                  <ReadOnlyField
                    label="Product Type"
                    value={
                      access.productTypeName ||
                      (access.productSku ? `SKU ${access.productSku}` : "—")
                    }
                  />
                ) : (
                  <EditableSelectField
                    label="Product Type"
                    value={access.productId ?? ""}
                    options={productsList.map((p) => ({
                      value: p.id,
                      label: `${p.name}${p.voltage_v ? ` — ${p.voltage_v}V` : ""}${p.capacity_ah ? ` / ${p.capacity_ah}Ah` : ""} | SKU: ${p.sku}`,
                    }))}
                    onChange={handleProductChange}
                    saving={savingCategory}
                    disabled={!productsList.length}
                    emptyText={
                      !access.category
                        ? "Pick a category first"
                        : "No products in this category"
                    }
                  />
                )}
              </div>
              <p className="text-[11px] text-gray-400 mt-3">
                {access.readOnly
                  ? "Category and product type were set in Step 1. Inventory below is filtered to match."
                  : "Edits here also update Step 1. Switching category clears the chosen battery, charger, and paraphernalia."}
              </p>
            </SectionCard>

            {/* Section B — Battery */}
            <SectionCard
              title="Battery"
              action={
                <div className="flex items-center gap-2 flex-wrap">
                  <FilterChip
                    label={`All ${batteries.length}`}
                    active={batteryFilter === "all"}
                    onClick={() => setBatteryFilter("all")}
                  />
                  {recommendedCount > 0 && (
                    <FilterChip
                      label={`Recommended ${recommendedCount}`}
                      active={batteryFilter === "recommended"}
                      tone="emerald"
                      onClick={() => setBatteryFilter("recommended")}
                    />
                  )}
                  {ageingCount > 0 && (
                    <FilterChip
                      label={`Ageing ${ageingCount}`}
                      active={batteryFilter === "ageing"}
                      tone="amber"
                      onClick={() => setBatteryFilter("ageing")}
                    />
                  )}
                  {oldCount > 0 && (
                    <FilterChip
                      label={`Old ${oldCount}`}
                      active={batteryFilter === "old"}
                      tone="red"
                      onClick={() => setBatteryFilter("old")}
                    />
                  )}
                </div>
              }
            >
              {batteriesLoading ? (
                <SkeletonCardGrid />
              ) : filteredBatteries.length === 0 ? (
                <EmptyState
                  icon={<BatteryIcon className="w-10 h-10 text-gray-300" />}
                  title={
                    batteries.length === 0
                      ? "No available batteries in this category"
                      : "No batteries match this filter"
                  }
                  hint="Try refreshing or contact your inventory manager."
                />
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {filteredBatteries.map((b) => (
                    <BatteryCard
                      key={b.id}
                      battery={b}
                      selected={selectedBattery?.id === b.id}
                      onSelect={() => setSelectedBattery(b)}
                      disabled={!!access.readOnly}
                    />
                  ))}
                </div>
              )}
            </SectionCard>

            {/* Section C — Charger */}
            <SectionCard title="Charger">
              {!selectedBattery ? (
                <EmptyState
                  icon={<Plug className="w-10 h-10 text-gray-300" />}
                  title="Select a battery first"
                  hint="Compatible chargers will appear here once a battery is selected."
                />
              ) : chargersLoading ? (
                <SkeletonCardGrid />
              ) : chargers.length === 0 ? (
                <EmptyState
                  icon={<Plug className="w-10 h-10 text-gray-300" />}
                  title="No compatible chargers available"
                  hint={`Looking for chargers matching ${selectedBattery.model_type || "battery model"}.`}
                />
              ) : (
                <>
                  <p className="text-[11px] text-gray-400 mb-3 px-1">
                    Showing chargers compatible with{" "}
                    <strong className="text-gray-700">
                      {selectedBattery.model_name || selectedBattery.model_type}
                    </strong>
                    .
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {chargers.map((c) => (
                      <ChargerCard
                        key={c.id}
                        charger={c}
                        selected={selectedCharger?.id === c.id}
                        onSelect={() => setSelectedCharger(c)}
                        disabled={!!access.readOnly}
                      />
                    ))}
                  </div>
                </>
              )}
            </SectionCard>

            {/* Section D — Paraphernalia */}
            <SectionCard title="Paraphernalia">
              {paraphernalia.length === 0 ? (
                <EmptyState
                  icon={<Package className="w-10 h-10 text-gray-300" />}
                  title="No paraphernalia available"
                  hint="No add-on items in this category for your inventory."
                />
              ) : (
                <ParaphernaliaList
                  items={paraphernalia}
                  paraQty={paraQty}
                  onChangeQty={(k, n, max) =>
                    setParaQty((prev) => ({
                      ...prev,
                      [k]: Math.max(0, Math.min(max, n)),
                    }))
                  }
                  disabled={!!access.readOnly}
                />
              )}
            </SectionCard>
          </div>

          {/* Right rail — Pricing summary (sticky on desktop) */}
          <div className="lg:col-span-4">
            <div className="lg:sticky lg:top-6">
              <PricingSummary
                batteryPrice={batteryPrice}
                chargerPrice={chargerPrice}
                paraCost={paraCost}
                grossSubtotal={grossSubtotal}
                gstSubtotal={gstSubtotal}
                netSubtotal={netSubtotal}
                dealerMargin={dealerMargin}
                marginMode={marginMode}
                marginInput={marginInput}
                marginPercentInput={marginPercentInput}
                onMarginChange={(raw) => {
                  setMarginInput(raw.replace(/[^0-9.]/g, ""));
                }}
                onMarginPercentChange={(raw) => {
                  setMarginPercentInput(raw.replace(/[^0-9.]/g, ""));
                }}
                onMarginModeChange={(next) => {
                  // Convert the current value to the new mode so the displayed
                  // margin amount stays roughly the same when the user toggles.
                  if (next === marginMode) return;
                  if (next === "percent") {
                    if (netSubtotal > 0) {
                      const pct = (dealerMargin / netSubtotal) * 100;
                      setMarginPercentInput(
                        pct > 0 ? (Math.round(pct * 100) / 100).toString() : "0",
                      );
                    }
                  } else {
                    setMarginInput(dealerMargin > 0 ? String(dealerMargin) : "0");
                  }
                  setMarginMode(next);
                }}
                finalPrice={finalPrice}
                inventoryNote={
                  isCash
                    ? "Inventory will be marked SOLD on confirm"
                    : "Inventory will be reserved on submit"
                }
                disabled={!!access.readOnly}
              />
            </div>
          </div>
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
        <OutlineButton onClick={() => router.back()}>Back</OutlineButton>
        <SecondaryButton onClick={handleSaveDraft} disabled={!!access.readOnly}>
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
            Submit for Final Approval
            <ChevronRight className="w-4 h-4" />
          </PrimaryButton>
        )}
      </StickyBottomBar>

      {confirmOpen && selectedBattery && selectedCharger && (
        <CashConfirmModal
          customerName={access.customerName || "—"}
          battery={selectedBattery}
          charger={selectedCharger}
          finalPrice={finalPrice}
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

function paraKey(p: ParaRow): string {
  return `${p.asset_type}|${p.model_type || ""}`;
}

// Returns the per-line { gross, gst%, gst, net } for a battery or charger row.
// Falls back to legacy `price` (treated as net) when GST snapshot is absent.
function triple(
  row: { price?: number | null; gross_amount?: string | number | null; gst_percent?: string | number | null; gst_amount?: string | number | null; net_amount?: string | number | null } | null,
): { gross: number; gstPct: number; gst: number; net: number } {
  if (!row) return { gross: 0, gstPct: 0, gst: 0, net: 0 };
  const gross = Number(row.gross_amount ?? 0);
  const gstPct = Number(row.gst_percent ?? 0);
  const gstAmt = Number(row.gst_amount ?? 0);
  const net = Number(row.net_amount ?? 0);
  if (gross > 0 || net > 0) {
    return { gross, gstPct, gst: gstAmt, net: net || gross + gstAmt };
  }
  // Legacy fallback: treat `price` as net, infer no GST split.
  const fallback = Number(row.price ?? 0);
  return { gross: fallback, gstPct: 0, gst: 0, net: fallback };
}

function formatGstPct(v: string | number | null | undefined): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n) || n === 0) return "0%";
  return `${Number.isInteger(n) ? n : n.toFixed(2)}%`;
}

function formatLastSaved(d: Date): string {
  const time = d.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  return `Auto-saved at ${time}`;
}

// ── Sub-components ───────────────────────────────────────────────────

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest px-1">
        {label}
      </label>
      <div className="mt-1.5 h-11 px-4 rounded-xl bg-gray-50 border-2 border-[#F1F2F4] flex items-center text-sm font-bold text-gray-800">
        {value}
      </div>
    </div>
  );
}

function EditableSelectField({
  label,
  value,
  options,
  onChange,
  saving,
  disabled,
  emptyText,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (next: string) => void;
  saving?: boolean;
  disabled?: boolean;
  emptyText?: string;
}) {
  const isDisabled = disabled || saving;
  return (
    <div>
      <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest px-1 flex items-center gap-1.5">
        <Pencil className="w-3 h-3" /> {label}
      </label>
      <div className="mt-1.5 relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={isDisabled}
          className={`w-full h-11 px-4 pr-10 bg-white border-2 rounded-xl text-sm font-bold outline-none appearance-none transition-colors ${
            isDisabled
              ? "border-[#F1F2F4] bg-gray-50 text-gray-400 cursor-not-allowed"
              : "border-[#EBEBEB] text-gray-900 focus:border-[#1D4ED8] focus:ring-4 focus:ring-blue-50/50"
          }`}
        >
          {!options.length && (
            <option value="">{emptyText || "No options available"}</option>
          )}
          {options.length > 0 && !value && (
            <option value="">Select…</option>
          )}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
        {saving && (
          <span className="absolute right-9 top-1/2 -translate-y-1/2 text-[10px] font-bold text-[#0047AB]">
            Saving…
          </span>
        )}
      </div>
    </div>
  );
}

function FilterChip({
  label,
  active,
  tone = "blue",
  onClick,
}: {
  label: string;
  active: boolean;
  tone?: "blue" | "emerald" | "amber" | "red";
  onClick: () => void;
}) {
  const styles = active
    ? {
        blue: "bg-[#0047AB] text-white border-[#0047AB]",
        emerald: "bg-emerald-600 text-white border-emerald-600",
        amber: "bg-amber-500 text-white border-amber-500",
        red: "bg-red-500 text-white border-red-500",
      }[tone]
    : "bg-white text-gray-600 border-gray-200 hover:border-gray-300";
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-[11px] font-bold border-2 transition-all ${styles}`}
    >
      {label}
    </button>
  );
}

function AgeBadge({
  badge,
  days,
}: {
  badge: "fresh" | "ageing" | "old";
  days: number;
}) {
  const styles = {
    fresh: "bg-emerald-50 text-emerald-700 border-emerald-200",
    ageing: "bg-amber-50 text-amber-700 border-amber-200",
    old: "bg-red-50 text-red-700 border-red-200",
  }[badge];
  const label =
    badge === "fresh" ? "Fresh" : badge === "ageing" ? "Ageing" : "Old Stock";
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-black ${styles}`}
    >
      <CalendarDays className="w-3 h-3" />
      {days}d · {label}
    </span>
  );
}

function SocBar({
  socPercent,
  lastSyncAt,
}: {
  socPercent: string | null;
  lastSyncAt?: string | null;
}) {
  if (socPercent == null) {
    return (
      <div className="text-[11px] text-gray-400 font-medium">SOC: N/A</div>
    );
  }
  const n = Math.max(0, Math.min(100, Number(socPercent)));
  const tone = n >= 60 ? "emerald" : n >= 30 ? "amber" : "red";
  const barColor = {
    emerald: "bg-emerald-500",
    amber: "bg-amber-500",
    red: "bg-red-500",
  }[tone];
  let syncLabel = "";
  let stale = false;
  if (lastSyncAt) {
    const diffMs = Date.now() - new Date(lastSyncAt).getTime();
    if (Number.isFinite(diffMs) && diffMs >= 0) {
      const hours = Math.floor(diffMs / (1000 * 60 * 60));
      if (hours >= 24) {
        stale = true;
        syncLabel = `Last sync >24h ago — data may be outdated`;
      } else if (hours >= 1) {
        syncLabel = `Last sync: ${hours}h ago`;
      } else {
        syncLabel = `Last sync: just now`;
      }
    }
  }
  return (
    <div className="flex flex-col gap-1 w-full">
      <div className="flex items-center justify-between text-[10px] font-bold text-gray-600">
        <span>SOC</span>
        <span className={stale ? "text-amber-600" : "text-gray-700"}>{n}%</span>
      </div>
      <div className="h-1.5 w-full bg-gray-100 rounded-full overflow-hidden">
        <div
          className={`h-full ${barColor} transition-all`}
          style={{ width: `${n}%` }}
        />
      </div>
      {syncLabel && (
        <span className={`text-[9px] ${stale ? "text-amber-600" : "text-gray-400"}`}>
          {syncLabel}
        </span>
      )}
    </div>
  );
}

function BatteryCard({
  battery,
  selected,
  onSelect,
  disabled,
}: {
  battery: BatteryRow;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
}) {
  const ageBorder = selected
    ? "border-[#0047AB] bg-blue-50/50 ring-4 ring-blue-100"
    : battery.age_badge === "old"
      ? "border-red-200 hover:border-red-400"
      : battery.age_badge === "ageing"
        ? "border-amber-200 hover:border-amber-400"
        : "border-gray-100 hover:border-gray-300";
  return (
    <button
      onClick={onSelect}
      disabled={disabled}
      className={`relative text-left p-4 rounded-2xl border-2 transition-all bg-white shadow-sm hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed ${ageBorder}`}
    >
      {battery.recommended && (
        <span className="absolute -top-2 -right-2 inline-flex items-center gap-1 px-2.5 py-0.5 bg-emerald-500 text-white rounded-full text-[10px] font-black uppercase tracking-wider shadow-sm">
          <Sparkles className="w-3 h-3" /> Recommended
        </span>
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-black text-gray-900 font-mono tracking-tight truncate">
            {battery.serial_number}
          </div>
          <div className="text-[11px] text-gray-500 mt-1 font-medium truncate">
            {battery.model_name || battery.model_type || "Battery"}
          </div>
          <SpecChips
            voltage={battery.voltage_v}
            capacity={battery.capacity_ah}
            warrantyMonths={battery.warranty_months}
            status={battery.status}
          />
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-base font-black text-[#0047AB]">
            {inr(Number(battery.net_amount ?? battery.price ?? 0))}
          </div>
          <div className="text-[10px] text-gray-400 font-medium">incl. GST</div>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <AgeBadge badge={battery.age_badge} days={battery.inventory_age_days} />
        {battery.invoice_date && (
          <span className="text-[10px] text-gray-500 font-medium">
            Invoiced {formatShortDate(battery.invoice_date)}
          </span>
        )}
      </div>
      <div className="mt-3">
        <SocBar
          socPercent={battery.soc_percent}
          lastSyncAt={battery.soc_last_sync_at}
        />
      </div>
      <GstLine
        gross={battery.gross_amount}
        gstPercent={battery.gst_percent}
        gstAmount={battery.gst_amount}
        net={battery.net_amount}
      />
    </button>
  );
}

function ChargerCard({
  charger,
  selected,
  onSelect,
  disabled,
}: {
  charger: ChargerRow;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
}) {
  const border = selected
    ? "border-[#0047AB] bg-blue-50/50 ring-4 ring-blue-100"
    : "border-gray-100 hover:border-gray-300";
  return (
    <button
      onClick={onSelect}
      disabled={disabled}
      className={`relative text-left p-4 rounded-2xl border-2 transition-all bg-white shadow-sm hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed ${border}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-black text-gray-900 font-mono tracking-tight truncate">
            {charger.serial_number}
          </div>
          <div className="text-[11px] text-gray-500 mt-1 font-medium truncate">
            {charger.model_name || charger.model_type || "Charger"}
          </div>
          <SpecChips
            warrantyMonths={charger.warranty_months}
            status={charger.status}
          />
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-base font-black text-[#0047AB]">
            {inr(Number(charger.net_amount ?? charger.price ?? 0))}
          </div>
          <div className="text-[10px] text-gray-400 font-medium">incl. GST</div>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <AgeBadge badge={charger.age_badge} days={charger.inventory_age_days} />
        {charger.invoice_date && (
          <span className="text-[10px] text-gray-500 font-medium">
            Invoiced {formatShortDate(charger.invoice_date)}
          </span>
        )}
      </div>
      <GstLine
        gross={charger.gross_amount}
        gstPercent={charger.gst_percent}
        gstAmount={charger.gst_amount}
        net={charger.net_amount}
      />
    </button>
  );
}

function SpecChips({
  voltage,
  capacity,
  warrantyMonths,
  status,
}: {
  voltage?: number | null;
  capacity?: number | null;
  warrantyMonths?: number | null;
  status?: string | null;
}) {
  const chips: string[] = [];
  if (voltage) chips.push(`${voltage}V`);
  if (capacity) chips.push(`${capacity}AH`);
  if (warrantyMonths && warrantyMonths > 0) {
    const years = warrantyMonths / 12;
    chips.push(
      Number.isInteger(years) ? `${years} yr warranty` : `${warrantyMonths} mo warranty`,
    );
  }
  const norm = (status ?? "").toLowerCase();
  const statusChip =
    norm === "available"
      ? { label: "Available", tone: "emerald" as const }
      : norm === "reserved"
        ? { label: "Reserved", tone: "amber" as const }
        : norm
          ? { label: status as string, tone: "gray" as const }
          : null;
  if (chips.length === 0 && !statusChip) return null;
  const toneClass: Record<string, string> = {
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-100",
    amber: "bg-amber-50 text-amber-700 border-amber-100",
    gray: "bg-gray-50 text-gray-600 border-gray-100",
  };
  return (
    <div className="mt-2 flex items-center gap-1.5 flex-wrap">
      {chips.map((c) => (
        <span
          key={c}
          className="px-2 py-0.5 rounded-md bg-gray-50 border border-gray-100 text-[10px] font-bold text-gray-700 tracking-wide"
        >
          {c}
        </span>
      ))}
      {statusChip && (
        <span
          className={`px-2 py-0.5 rounded-md border text-[10px] font-bold tracking-wide ${toneClass[statusChip.tone]}`}
        >
          {statusChip.label}
        </span>
      )}
    </div>
  );
}

function GstLine({
  gross,
  gstPercent,
  gstAmount,
  net,
}: {
  gross?: string | number | null;
  gstPercent?: string | number | null;
  gstAmount?: string | number | null;
  net?: string | number | null;
}) {
  const grossN = Number(gross ?? 0);
  const gstAmtN = Number(gstAmount ?? 0);
  const netN = Number(net ?? 0);
  if (grossN <= 0 && netN <= 0) return null;
  return (
    <div className="mt-3 grid grid-cols-3 gap-2 text-[10px] font-medium">
      <div className="bg-gray-50 border border-gray-100 rounded-lg px-2 py-1.5">
        <div className="text-gray-400 uppercase tracking-wider">Gross</div>
        <div className="text-gray-900 font-bold tabular-nums">{inr(grossN)}</div>
      </div>
      <div className="bg-gray-50 border border-gray-100 rounded-lg px-2 py-1.5">
        <div className="text-gray-400 uppercase tracking-wider">
          GST {formatGstPct(gstPercent)}
        </div>
        <div className="text-gray-900 font-bold tabular-nums">{inr(gstAmtN)}</div>
      </div>
      <div className="bg-emerald-50 border border-emerald-100 rounded-lg px-2 py-1.5">
        <div className="text-emerald-600 uppercase tracking-wider">Net</div>
        <div className="text-emerald-800 font-bold tabular-nums">{inr(netN || grossN + gstAmtN)}</div>
      </div>
    </div>
  );
}

function ParaphernaliaList({
  items,
  paraQty,
  onChangeQty,
  disabled,
}: {
  items: ParaRow[];
  paraQty: Record<string, number>;
  onChangeQty: (k: string, n: number, max: number) => void;
  disabled?: boolean;
}) {
  // BRD §SECTION D — four input types:
  //   1. Digital SOC      → quantity 0..N
  //   2. Volt SOC         → quantity 0..N
  //   3. Harness Variant  → dropdown (Type A / B / C / None), one variant per lead
  //   4. Additional Accessories → free multi-select over the rest of the
  //                               dealer's paraphernalia inventory.
  const digitalSoc = items.filter((p) => p.asset_type === "DigitalSOC");
  const voltSoc = items.filter((p) => p.asset_type === "VoltSOC");
  const harness = items.filter((p) => p.asset_type === "Harness");
  const additional = items.filter(
    (p) =>
      p.asset_type !== "DigitalSOC" &&
      p.asset_type !== "VoltSOC" &&
      p.asset_type !== "Harness",
  );

  return (
    <div className="space-y-5">
      {digitalSoc.length > 0 && (
        <ParaSubsection title="Digital SOC" hint="Count of digital SOC units. Validated against dealer stock.">
          {digitalSoc.map((p) => {
            const k = paraKey(p);
            return (
              <ParaItemRow
                key={k}
                item={p}
                qty={paraQty[k] || 0}
                onChange={(n) => onChangeQty(k, n, p.available_qty)}
                disabled={disabled}
              />
            );
          })}
        </ParaSubsection>
      )}

      {voltSoc.length > 0 && (
        <ParaSubsection title="Volt SOC" hint="Count of volt SOC units.">
          {voltSoc.map((p) => {
            const k = paraKey(p);
            return (
              <ParaItemRow
                key={k}
                item={p}
                qty={paraQty[k] || 0}
                onChange={(n) => onChangeQty(k, n, p.available_qty)}
                disabled={disabled}
              />
            );
          })}
        </ParaSubsection>
      )}

      {harness.length > 0 && (
        <ParaSubsection title="Harness Variant" hint="Pick one variant per lead.">
          <HarnessVariantPicker
            options={harness}
            paraQty={paraQty}
            onChangeQty={onChangeQty}
            disabled={disabled}
          />
        </ParaSubsection>
      )}

      {additional.length > 0 && (
        <ParaSubsection
          title="Additional Accessories"
          hint="Free multi-select — pick any other items from your paraphernalia stock."
        >
          <AdditionalAccessoriesPicker
            options={additional}
            paraQty={paraQty}
            onChangeQty={onChangeQty}
            disabled={disabled}
          />
        </ParaSubsection>
      )}
    </div>
  );
}

function ParaSubsection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="px-1 mb-2">
        <div className="text-[11px] font-black text-gray-700 uppercase tracking-widest">
          {title}
        </div>
        {hint && <div className="text-[11px] text-gray-400 mt-0.5">{hint}</div>}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function AdditionalAccessoriesPicker({
  options,
  paraQty,
  onChangeQty,
  disabled,
}: {
  options: ParaRow[];
  paraQty: Record<string, number>;
  onChangeQty: (k: string, n: number, max: number) => void;
  disabled?: boolean;
}) {
  // BRD §SECTION D — "Free multi-select. Other items from dealer's
  // paraphernalia inventory. Shown dynamically from backend."
  // An accessory is included when its qty > 0; toggling the checkbox
  // sets qty to 1 (or back to 0). Per-row stepper appears once selected.
  const selected = options.filter((o) => (paraQty[paraKey(o)] || 0) > 0);
  const unselected = options.filter((o) => (paraQty[paraKey(o)] || 0) <= 0);

  return (
    <div className="space-y-3">
      {unselected.length > 0 && (
        <div className="flex flex-wrap gap-2 px-1">
          {unselected.map((o) => {
            const k = paraKey(o);
            const label =
              o.product_name ||
              `${o.asset_type} ${o.model_type ?? ""}`.trim();
            const outOfStock = o.available_qty <= 0;
            return (
              <button
                key={k}
                type="button"
                disabled={disabled || outOfStock}
                onClick={() => onChangeQty(k, 1, o.available_qty)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border-2 text-xs font-bold transition-colors ${
                  outOfStock
                    ? "border-gray-100 bg-gray-50 text-gray-300 cursor-not-allowed"
                    : "border-[#EBEBEB] bg-white text-gray-700 hover:border-[#0047AB] hover:text-[#0047AB]"
                }`}
              >
                <Plus className="w-3 h-3" /> {label}
                <span className="text-[10px] text-gray-400 font-medium">
                  ({o.available_qty})
                </span>
              </button>
            );
          })}
        </div>
      )}

      {selected.map((p) => {
        const k = paraKey(p);
        return (
          <ParaItemRow
            key={k}
            item={p}
            qty={paraQty[k] || 0}
            onChange={(n) => onChangeQty(k, n, p.available_qty)}
            disabled={disabled}
            removable
            onRemove={() => onChangeQty(k, 0, p.available_qty)}
          />
        );
      })}

      {selected.length === 0 && unselected.length === 0 && (
        <div className="text-[11px] text-gray-400 px-1">
          No additional accessories in stock.
        </div>
      )}
    </div>
  );
}

function ParaItemRow({
  item,
  qty,
  onChange,
  disabled,
  removable,
  onRemove,
}: {
  item: ParaRow;
  qty: number;
  onChange: (n: number) => void;
  disabled?: boolean;
  removable?: boolean;
  onRemove?: () => void;
}) {
  const unitGross = Number(item.unit_gross ?? item.unit_price ?? 0);
  const gstPct = Number(item.gst_percent ?? 0);
  const unitGst = Number(item.unit_gst_amount ?? 0);
  const unitNet = Number(item.unit_net ?? unitGross + unitGst);
  return (
    <div className="px-4 py-3 rounded-xl border border-gray-100 hover:border-gray-200 transition-colors bg-gray-50/40">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-white border border-gray-100 flex items-center justify-center flex-shrink-0">
            <Package className="w-4 h-4 text-gray-500" />
          </div>
          <div className="min-w-0">
            <div className="font-bold text-sm text-gray-900 truncate">
              {item.product_name || `${item.asset_type} ${item.model_type ?? ""}`.trim()}
            </div>
            <div className="text-[11px] text-gray-500 mt-0.5">
              Available: {item.available_qty}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <QuantityStepper
            value={qty}
            max={item.available_qty}
            onChange={onChange}
            disabled={disabled}
          />
          {removable && (
            <button
              type="button"
              onClick={onRemove}
              disabled={disabled}
              aria-label="Remove accessory"
              className="w-8 h-8 rounded-lg border-2 border-gray-100 bg-white text-gray-400 hover:border-red-200 hover:text-red-500 flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="mt-2.5 grid grid-cols-4 gap-2 text-[10px] font-medium">
        <div className="bg-white border border-gray-100 rounded-lg px-2 py-1.5">
          <div className="text-gray-400 uppercase tracking-wider">Gross</div>
          <div className="text-gray-900 font-bold tabular-nums">{inr(unitGross)}</div>
        </div>
        <div className="bg-white border border-gray-100 rounded-lg px-2 py-1.5">
          <div className="text-gray-400 uppercase tracking-wider">
            GST {formatGstPct(gstPct)}
          </div>
          <div className="text-gray-900 font-bold tabular-nums">{inr(unitGst)}</div>
        </div>
        <div className="bg-white border border-gray-100 rounded-lg px-2 py-1.5">
          <div className="text-gray-400 uppercase tracking-wider">Net / unit</div>
          <div className="text-gray-900 font-bold tabular-nums">{inr(unitNet)}</div>
        </div>
        <div className="bg-emerald-50 border border-emerald-100 rounded-lg px-2 py-1.5">
          <div className="text-emerald-600 uppercase tracking-wider">Line ×{qty}</div>
          <div className="text-emerald-800 font-bold tabular-nums">
            {inr(qty * unitNet)}
          </div>
        </div>
      </div>
    </div>
  );
}

function HarnessVariantPicker({
  options,
  paraQty,
  onChangeQty,
  disabled,
}: {
  options: ParaRow[];
  paraQty: Record<string, number>;
  onChangeQty: (k: string, n: number, max: number) => void;
  disabled?: boolean;
}) {
  // Pick whichever harness variant currently has qty > 0 (only one allowed).
  const active = options.find((o) => (paraQty[paraKey(o)] || 0) > 0) || null;
  const activeKey = active ? paraKey(active) : "";
  const activeQty = active ? paraQty[activeKey] || 0 : 0;
  const max = active?.available_qty ?? 0;

  const handleSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newKey = e.target.value;
    // Zero all other variants, set 1 on the chosen one.
    options.forEach((o) => {
      const k = paraKey(o);
      if (k === newKey) onChangeQty(k, 1, o.available_qty);
      else if ((paraQty[k] || 0) > 0) onChangeQty(k, 0, o.available_qty);
    });
  };

  const unitGross = active ? Number(active.unit_gross ?? active.unit_price ?? 0) : 0;
  const gstPct = active ? Number(active.gst_percent ?? 0) : 0;
  const unitGst = active ? Number(active.unit_gst_amount ?? 0) : 0;
  const unitNet = active ? Number(active.unit_net ?? unitGross + unitGst) : 0;

  return (
    <div className="px-4 py-3 rounded-xl border border-gray-100 bg-gray-50/40">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-white border border-gray-100 flex items-center justify-center flex-shrink-0">
            <Package className="w-4 h-4 text-gray-500" />
          </div>
          <div className="min-w-0">
            <div className="font-bold text-sm text-gray-900">Harness</div>
            <div className="text-[11px] text-gray-500 mt-0.5">
              Pick one variant per lead.
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={activeKey}
            onChange={handleSelect}
            disabled={disabled}
            className="h-10 px-3 rounded-xl bg-white border-2 border-gray-100 text-sm font-bold text-gray-900 outline-none focus:border-[#1D4ED8] disabled:bg-gray-50"
          >
            <option value="">None</option>
            {options.map((o) => {
              const k = paraKey(o);
              const label = o.product_name || `Harness ${o.model_type ?? ""}`.trim() || `Harness ${k}`;
              return (
                <option key={k} value={k} disabled={o.available_qty <= 0}>
                  {label} (avail {o.available_qty})
                </option>
              );
            })}
          </select>
          {active && (
            <QuantityStepper
              value={activeQty}
              max={max}
              onChange={(n) => onChangeQty(activeKey, n, max)}
              disabled={disabled}
            />
          )}
        </div>
      </div>
      {active && (
        <div className="mt-2.5 grid grid-cols-4 gap-2 text-[10px] font-medium">
          <div className="bg-white border border-gray-100 rounded-lg px-2 py-1.5">
            <div className="text-gray-400 uppercase tracking-wider">Gross</div>
            <div className="text-gray-900 font-bold tabular-nums">{inr(unitGross)}</div>
          </div>
          <div className="bg-white border border-gray-100 rounded-lg px-2 py-1.5">
            <div className="text-gray-400 uppercase tracking-wider">
              GST {formatGstPct(gstPct)}
            </div>
            <div className="text-gray-900 font-bold tabular-nums">{inr(unitGst)}</div>
          </div>
          <div className="bg-white border border-gray-100 rounded-lg px-2 py-1.5">
            <div className="text-gray-400 uppercase tracking-wider">Net / unit</div>
            <div className="text-gray-900 font-bold tabular-nums">{inr(unitNet)}</div>
          </div>
          <div className="bg-emerald-50 border border-emerald-100 rounded-lg px-2 py-1.5">
            <div className="text-emerald-600 uppercase tracking-wider">Line ×{activeQty}</div>
            <div className="text-emerald-800 font-bold tabular-nums">
              {inr(activeQty * unitNet)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function QuantityStepper({
  value,
  max,
  onChange,
  disabled,
}: {
  value: number;
  max: number;
  onChange: (n: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex items-center bg-white border-2 border-gray-100 rounded-xl overflow-hidden">
      <button
        onClick={() => onChange(value - 1)}
        disabled={disabled || value <= 0}
        className="w-9 h-9 flex items-center justify-center text-gray-600 hover:bg-gray-50 disabled:opacity-30 transition-colors"
        aria-label="Decrease quantity"
      >
        <Minus className="w-4 h-4" />
      </button>
      <input
        type="number"
        min={0}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value || 0))}
        disabled={disabled}
        className="w-12 h-9 text-center text-sm font-bold text-gray-900 outline-none border-x border-gray-100 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      />
      <button
        onClick={() => onChange(value + 1)}
        disabled={disabled || value >= max}
        className="w-9 h-9 flex items-center justify-center text-gray-600 hover:bg-gray-50 disabled:opacity-30 transition-colors"
        aria-label="Increase quantity"
      >
        <Plus className="w-4 h-4" />
      </button>
    </div>
  );
}

function PricingSummary({
  batteryPrice,
  chargerPrice,
  paraCost,
  grossSubtotal,
  gstSubtotal,
  netSubtotal,
  dealerMargin,
  marginMode,
  marginInput,
  marginPercentInput,
  onMarginChange,
  onMarginPercentChange,
  onMarginModeChange,
  finalPrice,
  inventoryNote,
  disabled,
}: {
  batteryPrice: number;
  chargerPrice: number;
  paraCost: number;
  grossSubtotal: number;
  gstSubtotal: number;
  netSubtotal: number;
  dealerMargin: number;
  marginMode: "rupees" | "percent";
  marginInput: string;
  marginPercentInput: string;
  onMarginChange: (raw: string) => void;
  onMarginPercentChange: (raw: string) => void;
  onMarginModeChange: (next: "rupees" | "percent") => void;
  finalPrice: number;
  inventoryNote: string;
  disabled?: boolean;
}) {
  return (
    <div className="bg-white rounded-[24px] border border-[#E9ECEF] shadow-[0_8px_30px_rgb(0,0,0,0.02)] overflow-hidden">
      <div className="px-6 pt-6 pb-3 flex items-center gap-3">
        <div className="w-[3px] h-6 bg-[#0047AB] rounded-full" />
        <h3 className="text-base font-black text-gray-900 tracking-tight">Pricing</h3>
      </div>
      <div className="px-6 pb-6 space-y-3">
        <PriceLine label="Battery (incl. GST)" value={batteryPrice} />
        <PriceLine label="Charger (incl. GST)" value={chargerPrice} />
        <PriceLine label="Paraphernalia (incl. GST)" value={paraCost} />

        <div className="pt-3 border-t border-gray-100 space-y-1.5">
          <PriceLine label="Gross subtotal" value={grossSubtotal} muted />
          <PriceLine label="GST subtotal" value={gstSubtotal} muted />
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-700 font-bold">Net subtotal</span>
            <span className="text-gray-900 font-black tabular-nums">
              {inrFormatter.format(netSubtotal)}
            </span>
          </div>
        </div>

        <div className="pt-3 border-t border-gray-100">
          <div className="flex items-center justify-between px-1">
            <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest flex items-center gap-1.5">
              <TrendingUp className="w-3 h-3" /> Dealer Margin
            </label>
            <div className="inline-flex rounded-lg border border-[#EBEBEB] bg-gray-50 p-0.5">
              <button
                type="button"
                onClick={() => onMarginModeChange("rupees")}
                disabled={disabled}
                className={`px-2.5 py-1 text-[10px] font-black rounded-md transition-colors ${
                  marginMode === "rupees"
                    ? "bg-white text-[#0047AB] shadow-sm"
                    : "text-gray-400 hover:text-gray-600"
                } disabled:cursor-not-allowed`}
                aria-pressed={marginMode === "rupees"}
              >
                ₹
              </button>
              <button
                type="button"
                onClick={() => onMarginModeChange("percent")}
                disabled={disabled}
                className={`px-2.5 py-1 text-[10px] font-black rounded-md transition-colors ${
                  marginMode === "percent"
                    ? "bg-white text-[#0047AB] shadow-sm"
                    : "text-gray-400 hover:text-gray-600"
                } disabled:cursor-not-allowed`}
                aria-pressed={marginMode === "percent"}
              >
                %
              </button>
            </div>
          </div>
          <div className="mt-1.5 relative">
            {marginMode === "rupees" ? (
              <>
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 text-sm font-bold">
                  ₹
                </span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={marginInput}
                  onChange={(e) => onMarginChange(e.target.value)}
                  disabled={disabled}
                  className="w-full h-11 pl-8 pr-4 bg-white border-2 border-[#EBEBEB] rounded-xl text-sm font-bold text-gray-900 outline-none focus:border-[#1D4ED8] focus:ring-4 focus:ring-blue-50/50 disabled:bg-gray-50 disabled:text-gray-400"
                  placeholder="0"
                />
              </>
            ) : (
              <>
                <input
                  type="text"
                  inputMode="decimal"
                  value={marginPercentInput}
                  onChange={(e) => onMarginPercentChange(e.target.value)}
                  disabled={disabled}
                  className="w-full h-11 pl-4 pr-10 bg-white border-2 border-[#EBEBEB] rounded-xl text-sm font-bold text-gray-900 outline-none focus:border-[#1D4ED8] focus:ring-4 focus:ring-blue-50/50 disabled:bg-gray-50 disabled:text-gray-400"
                  placeholder="0"
                />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 text-sm font-bold">
                  %
                </span>
              </>
            )}
          </div>
          {marginMode === "percent" ? (
            <p className="text-[10px] text-gray-500 mt-1.5 px-1 tabular-nums">
              {marginPercentInput && parseFloat(marginPercentInput) > 0
                ? `${marginPercentInput}% of net subtotal = `
                : "% of net subtotal = "}
              <span className="font-bold text-gray-700">
                {inrFormatter.format(dealerMargin)}
              </span>
            </p>
          ) : (
            <p className="text-[10px] text-gray-400 mt-1.5 px-1">
              Your earnings on this sale
            </p>
          )}
        </div>

        <div className="pt-4 mt-2 border-t-2 border-gray-100">
          <div className="flex items-center justify-between">
            <span className="text-xs font-black text-gray-500 uppercase tracking-widest">
              Final Price
            </span>
            <span className="text-2xl font-black text-[#0047AB] tabular-nums">
              {inr(finalPrice)}
            </span>
          </div>
          <p className="text-[10px] text-gray-400 mt-2 flex items-center gap-1.5">
            <Wallet className="w-3 h-3" /> {inventoryNote}
          </p>
        </div>

        {/* Compact margin breakdown stat — only shown in rupees mode (in
            percent mode the helper line above already shows this), and always
            measured against net subtotal so it agrees with the % input. */}
        {marginMode === "rupees" && dealerMargin > 0 && netSubtotal > 0 && (
          <div className="px-3 py-2 bg-emerald-50 border border-emerald-100 rounded-lg">
            <p className="text-[10px] text-emerald-700 font-bold">
              Margin = {((dealerMargin / netSubtotal) * 100).toFixed(1)}% of net subtotal
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function PriceLine({
  label,
  value,
  muted,
}: {
  label: string;
  value: number;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className={muted ? "text-gray-400 font-medium text-xs" : "text-gray-500 font-medium"}>
        {label}
      </span>
      <span
        className={`tabular-nums ${muted ? "text-gray-500 font-bold text-xs" : "text-gray-900 font-bold"}`}
      >
        {inr(value)}
      </span>
    </div>
  );
}

function EmptyState({
  icon,
  title,
  hint,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      <div className="mb-3">{icon}</div>
      <p className="text-sm font-bold text-gray-700">{title}</p>
      {hint && <p className="text-[11px] text-gray-400 mt-1 max-w-xs">{hint}</p>}
    </div>
  );
}

function SkeletonCardGrid() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="p-4 rounded-2xl border-2 border-gray-100 bg-white animate-pulse"
        >
          <div className="flex justify-between">
            <div className="space-y-2 flex-1">
              <div className="h-4 w-32 bg-gray-100 rounded" />
              <div className="h-3 w-24 bg-gray-100 rounded" />
            </div>
            <div className="h-5 w-16 bg-gray-100 rounded" />
          </div>
          <div className="mt-4 h-2 w-full bg-gray-100 rounded" />
        </div>
      ))}
    </div>
  );
}

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

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}
