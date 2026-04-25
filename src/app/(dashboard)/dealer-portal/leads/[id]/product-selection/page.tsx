"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { CheckCircle2, ChevronRight, AlertCircle } from "lucide-react";

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
  price: number | null;
  recommended: boolean;
}

interface ChargerRow {
  id: string;
  serial_number: string;
  model_name: string | null;
  model_type: string | null;
  inventory_age_days: number;
  age_badge: "fresh" | "ageing" | "old";
  price: number | null;
  recommended: boolean;
}

interface ParaRow {
  asset_type: string;
  model_type: string | null;
  product_name: string | null;
  available_qty: number;
  unit_price: number | null;
}

interface AccessData {
  allowed: boolean;
  paymentMode?: "cash" | "finance";
  dealerId?: string | null;
  category?: string | null;
  subCategory?: string | null;
  kycStatus?: string;
  redirectTo?: string;
  readOnly?: boolean;
  reason?: string;
}

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
  const [dealerMargin, setDealerMargin] = useState<number>(0);

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<null | {
    leadStatus: string;
    warrantyId?: string;
    productSelectionId: string;
  }>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Load access + dealer id
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
        const access: AccessData = accessJson.data;
        setAccess(access);
        setDealerId(access.dealerId ?? null);

        if (!access.allowed && access.redirectTo) {
          router.replace(access.redirectTo);
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

  // Load inventory lists once dealer + access ready
  useEffect(() => {
    if (!dealerId || !access?.allowed) return;
    (async () => {
      try {
        const cat = access.category ? `?category=${encodeURIComponent(access.category)}` : "";
        const [batRes, paraRes] = await Promise.all([
          fetch(`/api/inventory/dealer/${dealerId}/batteries${cat}`),
          fetch(`/api/inventory/dealer/${dealerId}/paraphernalia${cat}`),
        ]);
        const batJson = await batRes.json();
        const paraJson = await paraRes.json();
        if (batJson.success) setBatteries(batJson.data || []);
        if (paraJson.success) setParaphernalia(paraJson.data || []);
      } catch {
        setError("Failed to load inventory");
      }
    })();
  }, [dealerId, access]);

  // Load chargers once a battery is selected
  useEffect(() => {
    if (!dealerId || !selectedBattery) {
      setChargers([]);
      setSelectedCharger(null);
      return;
    }
    (async () => {
      try {
        const qs = new URLSearchParams();
        if (selectedBattery.model_type) qs.set("batteryModel", selectedBattery.model_type);
        if (access?.category) qs.set("category", access.category);
        const res = await fetch(`/api/inventory/dealer/${dealerId}/chargers?${qs.toString()}`);
        const json = await res.json();
        if (json.success) setChargers(json.data || []);
      } catch {
        setError("Failed to load chargers");
      }
    })();
  }, [dealerId, selectedBattery, access]);

  const batteryPrice = Number(selectedBattery?.price || 0);
  const chargerPrice = Number(selectedCharger?.price || 0);
  const paraCost = useMemo(() => {
    return paraphernalia.reduce((sum, p) => {
      const qty = paraQty[paraKey(p)] || 0;
      return sum + qty * Number(p.unit_price || 0);
    }, 0);
  }, [paraphernalia, paraQty]);
  const finalPrice = batteryPrice + chargerPrice + paraCost + Number(dealerMargin || 0);

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
        dealerMargin: Number(dealerMargin || 0),
        finalPrice,
        batteryPrice,
        chargerPrice,
        paraphernaliaCost: paraCost,
        category: access?.category ?? undefined,
        subCategory: access?.subCategory ?? undefined,
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
      } else {
        setError(json.error?.message || "Submit failed");
      }
    } catch {
      setError("Submit failed");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="p-8">Loading…</div>;
  if (error && !access) return <div className="p-8 text-red-600">{error}</div>;
  if (!access?.allowed) return <div className="p-8">{access?.reason || "Not available"}</div>;

  if (submitted) {
    return (
      <div className="max-w-3xl mx-auto p-8">
        <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-8 text-center">
          <CheckCircle2 className="w-14 h-14 text-emerald-600 mx-auto mb-4" />
          <h2 className="text-xl font-black text-emerald-900">
            {submitted.leadStatus === "sold" ? "Sale Confirmed" : "Submitted for Final Approval"}
          </h2>
          <p className="text-sm text-emerald-700 mt-2">
            {submitted.warrantyId
              ? `Warranty ${submitted.warrantyId} activated.`
              : "Admin will review and respond with the loan decision."}
          </p>
          <div className="mt-6 flex justify-center gap-3">
            <button
              onClick={() => router.push("/dealer-portal/leads")}
              className="px-6 py-2 bg-[#0047AB] text-white rounded-xl font-bold text-sm"
            >
              Back to Leads
            </button>
            {submitted.leadStatus === "loan_sanctioned" || submitted.leadStatus === "pending_final_approval" ? (
              <button
                onClick={() => router.push(`/dealer-portal/leads/${leadId}/step-5`)}
                className="px-6 py-2 border-2 border-[#0047AB] text-[#0047AB] rounded-xl font-bold text-sm"
              >
                Go to Step 5
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-8 space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-gray-900">Product Selection</h1>
          <p className="text-sm text-gray-500">Lead {leadId}</p>
        </div>
        <span
          className={`px-3 py-1 rounded-full text-xs font-bold ${
            access.paymentMode === "cash"
              ? "bg-yellow-100 text-yellow-800"
              : "bg-blue-100 text-blue-800"
          }`}
        >
          {access.paymentMode === "cash" ? "CASH SALE" : "FINANCE"}
        </span>
      </header>

      {access.paymentMode === "cash" && (
        <div className="p-3 rounded-lg bg-yellow-50 border border-yellow-200 text-xs text-yellow-800">
          Cash flow — KYC steps are skipped. Confirming will mark inventory sold and activate warranty immediately.
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          <AlertCircle className="w-4 h-4 mt-0.5" /> {error}
        </div>
      )}

      {/* Section A: Category */}
      <section className="bg-white border border-gray-200 rounded-xl p-6">
        <h2 className="font-bold mb-2">Category</h2>
        <p className="text-sm text-gray-600">
          Category: <strong>{access.category || "—"}</strong> · Sub-category:{" "}
          <strong>{access.subCategory || "—"}</strong>
        </p>
      </section>

      {/* Section B: Battery */}
      <section className="bg-white border border-gray-200 rounded-xl p-6">
        <h2 className="font-bold mb-4">Battery</h2>
        {batteries.length === 0 ? (
          <p className="text-sm text-gray-500">No available batteries in this category.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {batteries.map((b) => (
              <button
                key={b.id}
                onClick={() => setSelectedBattery(b)}
                className={`text-left p-4 rounded-lg border-2 transition-all ${
                  selectedBattery?.id === b.id
                    ? "border-[#0047AB] bg-blue-50"
                    : b.age_badge === "old"
                      ? "border-red-200 hover:border-red-300"
                      : b.age_badge === "ageing"
                        ? "border-amber-200 hover:border-amber-300"
                        : "border-gray-200 hover:border-gray-300"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="font-bold">{b.serial_number}</div>
                  {b.recommended && (
                    <span className="text-[10px] px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded-full font-bold">
                      Recommended
                    </span>
                  )}
                </div>
                <div className="text-xs text-gray-600 mt-1">
                  {b.model_name || b.model_type || "Model"} · ₹{b.price || 0}
                </div>
                <div className="flex items-center gap-2 mt-2 text-[11px]">
                  <AgeBadge badge={b.age_badge} days={b.inventory_age_days} />
                  <span className="text-gray-500">
                    SOC: {b.soc_percent != null ? `${b.soc_percent}%` : "N/A"}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Section C: Charger */}
      <section className="bg-white border border-gray-200 rounded-xl p-6">
        <h2 className="font-bold mb-4">Charger</h2>
        {!selectedBattery ? (
          <p className="text-sm text-gray-500">Select a battery first to see compatible chargers.</p>
        ) : chargers.length === 0 ? (
          <p className="text-sm text-gray-500">No compatible chargers available.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {chargers.map((c) => (
              <button
                key={c.id}
                onClick={() => setSelectedCharger(c)}
                className={`text-left p-4 rounded-lg border-2 transition-all ${
                  selectedCharger?.id === c.id
                    ? "border-[#0047AB] bg-blue-50"
                    : "border-gray-200 hover:border-gray-300"
                }`}
              >
                <div className="font-bold">{c.serial_number}</div>
                <div className="text-xs text-gray-600 mt-1">
                  {c.model_name || c.model_type || "Model"} · ₹{c.price || 0}
                </div>
                <div className="mt-2">
                  <AgeBadge badge={c.age_badge} days={c.inventory_age_days} />
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Section D: Paraphernalia */}
      <section className="bg-white border border-gray-200 rounded-xl p-6">
        <h2 className="font-bold mb-4">Paraphernalia</h2>
        {paraphernalia.length === 0 ? (
          <p className="text-sm text-gray-500">No paraphernalia available.</p>
        ) : (
          <div className="space-y-3">
            {paraphernalia.map((p) => {
              const k = paraKey(p);
              const qty = paraQty[k] || 0;
              return (
                <div key={k} className="flex items-center justify-between gap-4">
                  <div>
                    <div className="font-medium text-sm">
                      {p.product_name || `${p.asset_type} ${p.model_type ?? ""}`}
                    </div>
                    <div className="text-xs text-gray-500">
                      Available: {p.available_qty} · ₹{p.unit_price || 0}/unit
                    </div>
                  </div>
                  <input
                    type="number"
                    min={0}
                    max={p.available_qty}
                    value={qty}
                    onChange={(e) =>
                      setParaQty((prev) => ({
                        ...prev,
                        [k]: Math.min(Number(e.target.value || 0), p.available_qty),
                      }))
                    }
                    className="w-20 px-2 py-1 border border-gray-300 rounded text-sm"
                  />
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Section E: Pricing */}
      <section className="bg-white border border-gray-200 rounded-xl p-6">
        <h2 className="font-bold mb-4">Pricing</h2>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <PriceRow label="Battery Price" value={batteryPrice} />
          <PriceRow label="Charger Price" value={chargerPrice} />
          <PriceRow label="Paraphernalia" value={paraCost} />
          <div>
            <label className="block text-xs text-gray-500 uppercase mb-1">Dealer Margin (₹)</label>
            <input
              type="number"
              value={dealerMargin}
              onChange={(e) => setDealerMargin(Number(e.target.value || 0))}
              className="w-full px-2 py-1 border border-gray-300 rounded"
            />
          </div>
        </div>
        <div className="mt-4 pt-4 border-t flex items-center justify-between">
          <span className="text-sm font-bold">Final Price</span>
          <span className="text-2xl font-black text-[#0047AB]">₹{finalPrice.toLocaleString("en-IN")}</span>
        </div>
      </section>

      {/* Section F: Submit */}
      <div className="sticky bottom-4 flex items-center justify-end gap-3 bg-white rounded-xl border border-gray-200 p-4 shadow">
        <button
          onClick={() => router.back()}
          className="px-4 py-2 text-sm border rounded hover:bg-gray-50"
        >
          Back
        </button>
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className={`inline-flex items-center gap-2 px-6 py-2 rounded font-bold text-sm text-white disabled:opacity-50 ${
            access.paymentMode === "cash" ? "bg-emerald-600 hover:bg-emerald-700" : "bg-[#0047AB] hover:bg-[#003580]"
          }`}
        >
          {submitting
            ? "Submitting…"
            : access.paymentMode === "cash"
              ? "Confirm Sale"
              : "Submit for Final Approval"}
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {confirmOpen && selectedBattery && selectedCharger && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 max-w-md w-full">
            <h3 className="font-bold text-lg mb-3">Confirm Sale</h3>
            <p className="text-sm text-gray-600 mb-4">
              Battery <strong>{selectedBattery.serial_number}</strong>, Charger{" "}
              <strong>{selectedCharger.serial_number}</strong> for ₹{finalPrice.toLocaleString("en-IN")}.
              This will mark inventory as SOLD and activate warranty immediately.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConfirmOpen(false)}
                className="px-4 py-2 text-sm border rounded"
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                onClick={() => runSubmit("cash")}
                disabled={submitting}
                className="px-4 py-2 text-sm bg-emerald-600 text-white rounded font-bold disabled:opacity-50"
              >
                {submitting ? "Confirming…" : "Confirm Sale"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function paraKey(p: ParaRow): string {
  return `${p.asset_type}|${p.model_type || ""}`;
}

function PriceRow({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-xs text-gray-500 uppercase">{label}</div>
      <div className="font-medium">₹{value.toLocaleString("en-IN")}</div>
    </div>
  );
}

function AgeBadge({ badge, days }: { badge: "fresh" | "ageing" | "old"; days: number }) {
  const styles = {
    fresh: "bg-emerald-50 text-emerald-700 border-emerald-200",
    ageing: "bg-amber-50 text-amber-700 border-amber-200",
    old: "bg-red-50 text-red-700 border-red-200",
  }[badge];
  const label = { fresh: "", ageing: "Ageing", old: "Old Stock" }[badge];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-bold ${styles}`}>
      {days}d {label}
    </span>
  );
}
