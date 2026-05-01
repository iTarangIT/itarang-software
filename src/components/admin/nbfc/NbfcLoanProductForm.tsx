"use client";

import { useState } from "react";

// E-009 — Admin form to create a per-NBFC loan product. Submits to
// POST /api/admin/nbfc/{nbfcId}/loan-products and surfaces server-side
// validation errors verbatim (server enforces every rule per BRD 6.0.5).

const BATTERY_CATEGORIES = ["3W", "2W", "4W", "INVERTER", "SOLAR"] as const;
type BatteryCategory = (typeof BATTERY_CATEGORIES)[number];

const DISBURSEMENT_METHODS = [
  { value: "direct_to_dealer", label: "Direct to Dealer" },
  { value: "rtgs_to_dealer", label: "RTGS to Dealer Account" },
  { value: "escrow", label: "Escrow" },
] as const;

type Props = {
  nbfcId: number;
  onCreated?: (productId: number) => void;
};

export default function NbfcLoanProductForm({ nbfcId, onCreated }: Props) {
  const [productName, setProductName] = useState("");
  const [categories, setCategories] = useState<BatteryCategory[]>([]);
  const [loanAmountMin, setLoanAmountMin] = useState("");
  const [loanAmountMax, setLoanAmountMax] = useState("");
  const [tenureMin, setTenureMin] = useState("");
  const [tenureMax, setTenureMax] = useState("");
  const [minRoi, setMinRoi] = useState("");
  const [maxRoi, setMaxRoi] = useState("");
  const [downPayment, setDownPayment] = useState("");
  const [subventionAvailable, setSubventionAvailable] = useState(false);
  const [fileChargeFixed, setFileChargeFixed] = useState("");
  const [fileChargePct, setFileChargePct] = useState("");
  const [disbursement, setDisbursement] = useState("direct_to_dealer");
  const [status, setStatus] = useState<"active" | "inactive">("active");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleCategory = (cat: BatteryCategory) => {
    setCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat],
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    const body: Record<string, unknown> = {
      productName,
      eligibleBatteryCategories: categories,
      loanAmountMin: Number(loanAmountMin),
      loanAmountMax: Number(loanAmountMax),
      tenureMonthsMin: Number(tenureMin),
      tenureMonthsMax: Number(tenureMax),
      minRoiPct: Number(minRoi),
      maxRoiPct: Number(maxRoi),
      downPaymentPct: Number(downPayment),
      subventionAvailable,
      disbursementMethod: disbursement,
      status,
    };
    if (fileChargeFixed !== "")
      body.fileChargeFixed = Number(fileChargeFixed);
    if (fileChargePct !== "") body.fileChargePct = Number(fileChargePct);

    try {
      const res = await fetch(
        `/api/admin/nbfc/${nbfcId}/loan-products`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data?.message ?? `Request failed (${res.status})`);
      } else {
        onCreated?.(data.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 max-w-2xl"
      data-testid="nbfc-loan-product-form"
    >
      <div>
        <label className="block text-sm font-medium">Product Name</label>
        <input
          type="text"
          value={productName}
          onChange={(e) => setProductName(e.target.value)}
          required
          maxLength={120}
          className="mt-1 w-full border rounded px-2 py-1"
          name="productName"
        />
      </div>

      <fieldset>
        <legend className="text-sm font-medium">
          Eligible Battery Categories
        </legend>
        <div className="flex gap-3 mt-1">
          {BATTERY_CATEGORIES.map((cat) => (
            <label key={cat} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={categories.includes(cat)}
                onChange={() => toggleCategory(cat)}
              />
              <span>{cat}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid grid-cols-2 gap-3">
        <label className="block text-sm">
          Loan Amount Min (₹)
          <input
            type="number"
            value={loanAmountMin}
            onChange={(e) => setLoanAmountMin(e.target.value)}
            required
            min={0}
            className="mt-1 w-full border rounded px-2 py-1"
            name="loanAmountMin"
          />
        </label>
        <label className="block text-sm">
          Loan Amount Max (₹)
          <input
            type="number"
            value={loanAmountMax}
            onChange={(e) => setLoanAmountMax(e.target.value)}
            required
            min={1}
            className="mt-1 w-full border rounded px-2 py-1"
            name="loanAmountMax"
          />
        </label>
        <label className="block text-sm">
          Tenure Min (months)
          <input
            type="number"
            value={tenureMin}
            onChange={(e) => setTenureMin(e.target.value)}
            required
            min={1}
            className="mt-1 w-full border rounded px-2 py-1"
            name="tenureMonthsMin"
          />
        </label>
        <label className="block text-sm">
          Tenure Max (months)
          <input
            type="number"
            value={tenureMax}
            onChange={(e) => setTenureMax(e.target.value)}
            required
            min={1}
            className="mt-1 w-full border rounded px-2 py-1"
            name="tenureMonthsMax"
          />
        </label>
        <label className="block text-sm">
          Min ROI (%)
          <input
            type="number"
            value={minRoi}
            onChange={(e) => setMinRoi(e.target.value)}
            required
            step="0.01"
            min={0}
            className="mt-1 w-full border rounded px-2 py-1"
            name="minRoiPct"
          />
        </label>
        <label className="block text-sm">
          Max ROI (%)
          <input
            type="number"
            value={maxRoi}
            onChange={(e) => setMaxRoi(e.target.value)}
            required
            step="0.01"
            min={0}
            className="mt-1 w-full border rounded px-2 py-1"
            name="maxRoiPct"
          />
        </label>
        <label className="block text-sm">
          Down Payment (%)
          <input
            type="number"
            value={downPayment}
            onChange={(e) => setDownPayment(e.target.value)}
            required
            step="0.01"
            min={0}
            max={100}
            className="mt-1 w-full border rounded px-2 py-1"
            name="downPaymentPct"
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={subventionAvailable}
            onChange={(e) => setSubventionAvailable(e.target.checked)}
            name="subventionAvailable"
          />
          Subvention Available
        </label>
        <label className="block text-sm">
          File Charge — Fixed (₹)
          <input
            type="number"
            value={fileChargeFixed}
            onChange={(e) => setFileChargeFixed(e.target.value)}
            step="0.01"
            min={0}
            className="mt-1 w-full border rounded px-2 py-1"
            name="fileChargeFixed"
          />
        </label>
        <label className="block text-sm">
          File Charge — % of Loan
          <input
            type="number"
            value={fileChargePct}
            onChange={(e) => setFileChargePct(e.target.value)}
            step="0.01"
            min={0}
            max={100}
            className="mt-1 w-full border rounded px-2 py-1"
            name="fileChargePct"
          />
        </label>
      </div>

      <label className="block text-sm">
        Disbursement Method
        <select
          value={disbursement}
          onChange={(e) => setDisbursement(e.target.value)}
          className="mt-1 w-full border rounded px-2 py-1"
          name="disbursementMethod"
        >
          {DISBURSEMENT_METHODS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      <label className="block text-sm">
        Status
        <select
          value={status}
          onChange={(e) =>
            setStatus(e.target.value as "active" | "inactive")
          }
          className="mt-1 w-full border rounded px-2 py-1"
          name="status"
        >
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </label>

      {error && (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50"
      >
        {submitting ? "Saving..." : "Create Loan Product"}
      </button>
    </form>
  );
}
