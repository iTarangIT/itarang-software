"use client";

/**
 * NbfcLoanProductForm — E-009 per-NBFC loan product creation.
 *
 * Visual: BRD §6.B. Sectioned (Product, Eligibility, Amount band, Tenure,
 * ROI, Charges, Disbursement) with a chip group for battery categories.
 *
 * Test contract — every existing `name="..."` and the form-root
 * `data-testid="nbfc-loan-product-form"` are preserved verbatim.
 */
import { useState } from "react";
import { Loader2, AlertCircle } from "lucide-react";

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

  const toggleCategory = (cat: BatteryCategory) =>
    setCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat],
    );

  async function handleSubmit(e: React.FormEvent) {
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
    if (fileChargeFixed !== "") body.fileChargeFixed = Number(fileChargeFixed);
    if (fileChargePct !== "") body.fileChargePct = Number(fileChargePct);

    try {
      const res = await fetch(`/api/admin/nbfc/${nbfcId}/loan-products`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
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
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-6"
      data-testid="nbfc-loan-product-form"
    >
      <Section eyebrow="Product" title="Identity & Status">
        <Field label="Product name" full>
          <input
            type="text"
            value={productName}
            onChange={(e) => setProductName(e.target.value)}
            required
            maxLength={120}
            className="input-itarang"
            name="productName"
            placeholder="e.g. Bajaj E-Rickshaw Finance 2026"
          />
        </Field>
        <Field label="Status">
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as "active" | "inactive")}
            className="input-itarang"
            name="status"
          >
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </Field>
      </Section>

      <Section
        eyebrow="Eligibility"
        title="Battery categories this product finances"
        helper="Pick every category the NBFC will underwrite. Only `Active` products show in the dealer sanction dropdown."
      >
        <div className="md:col-span-3">
          <div className="flex flex-wrap gap-2">
            {BATTERY_CATEGORIES.map((cat) => {
              const selected = categories.includes(cat);
              return (
                <label
                  key={cat}
                  className={
                    "relative inline-flex items-center gap-2 px-3 h-9 rounded-full text-sm font-semibold cursor-pointer transition-colors border select-none " +
                    (selected
                      ? "text-white border-transparent shadow-[0_2px_8px_-2px_rgba(19,143,198,0.4)]"
                      : "text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-brand-navy)] border-[color:var(--color-border)] bg-white")
                  }
                  style={
                    selected
                      ? { background: "var(--color-brand-sky)" }
                      : undefined
                  }
                >
                  {/* Native checkbox covers the entire chip and stays
                      clickable by Playwright's `check()`. Visual is the
                      label itself. */}
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => toggleCategory(cat)}
                    className="absolute inset-0 opacity-0 cursor-pointer"
                  />
                  <span className="relative z-10 pointer-events-none">{cat}</span>
                </label>
              );
            })}
          </div>
        </div>
      </Section>

      <Section
        eyebrow="Amount band"
        title="Min and max sanction amount in ₹"
      >
        <Field label="Loan amount min (₹)">
          <input
            type="number"
            value={loanAmountMin}
            onChange={(e) => setLoanAmountMin(e.target.value)}
            required
            min={0}
            className="input-itarang"
            name="loanAmountMin"
          />
        </Field>
        <Field label="Loan amount max (₹)">
          <input
            type="number"
            value={loanAmountMax}
            onChange={(e) => setLoanAmountMax(e.target.value)}
            required
            min={1}
            className="input-itarang"
            name="loanAmountMax"
          />
        </Field>
      </Section>

      <Section eyebrow="Tenure" title="Allowed tenure window">
        <Field label="Min tenure (months)">
          <input
            type="number"
            value={tenureMin}
            onChange={(e) => setTenureMin(e.target.value)}
            required
            min={1}
            className="input-itarang"
            name="tenureMonthsMin"
          />
        </Field>
        <Field label="Max tenure (months)">
          <input
            type="number"
            value={tenureMax}
            onChange={(e) => setTenureMax(e.target.value)}
            required
            min={1}
            className="input-itarang"
            name="tenureMonthsMax"
          />
        </Field>
      </Section>

      <Section eyebrow="ROI & Down payment" title="Pricing knobs">
        <Field label="Min ROI (%)">
          <input
            type="number"
            value={minRoi}
            onChange={(e) => setMinRoi(e.target.value)}
            required
            step="0.01"
            min={0}
            className="input-itarang"
            name="minRoiPct"
          />
        </Field>
        <Field label="Max ROI (%)">
          <input
            type="number"
            value={maxRoi}
            onChange={(e) => setMaxRoi(e.target.value)}
            required
            step="0.01"
            min={0}
            className="input-itarang"
            name="maxRoiPct"
          />
        </Field>
        <Field label="Down payment (%)">
          <input
            type="number"
            value={downPayment}
            onChange={(e) => setDownPayment(e.target.value)}
            required
            step="0.01"
            min={0}
            max={100}
            className="input-itarang"
            name="downPaymentPct"
          />
        </Field>
      </Section>

      <Section eyebrow="Charges" title="Subvention and file charges">
        <Field label="Subvention available">
          <label
            className="inline-flex items-center gap-2 h-11 px-3 rounded-lg border border-[color:var(--color-border)] bg-white cursor-pointer text-sm"
          >
            <input
              type="checkbox"
              checked={subventionAvailable}
              onChange={(e) => setSubventionAvailable(e.target.checked)}
              name="subventionAvailable"
            />
            <span>{subventionAvailable ? "Yes" : "No"}</span>
          </label>
        </Field>
        <Field label="File charge — fixed (₹)">
          <input
            type="number"
            value={fileChargeFixed}
            onChange={(e) => setFileChargeFixed(e.target.value)}
            step="0.01"
            min={0}
            className="input-itarang"
            name="fileChargeFixed"
          />
        </Field>
        <Field label="File charge — % of loan">
          <input
            type="number"
            value={fileChargePct}
            onChange={(e) => setFileChargePct(e.target.value)}
            step="0.01"
            min={0}
            max={100}
            className="input-itarang"
            name="fileChargePct"
          />
        </Field>
      </Section>

      <Section eyebrow="Disbursement" title="Where the funds land">
        <Field label="Disbursement method" full>
          <select
            value={disbursement}
            onChange={(e) => setDisbursement(e.target.value)}
            className="input-itarang"
            name="disbursementMethod"
          >
            {DISBURSEMENT_METHODS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>
      </Section>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-xl px-4 py-3 border"
          style={{
            background: "var(--color-danger-bg)",
            borderColor: "rgba(192, 57, 43, 0.3)",
            color: "var(--color-danger)",
          }}
        >
          <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold">Couldn't create loan product</p>
            <p className="opacity-90">{error}</p>
          </div>
        </div>
      )}

      <div className="flex justify-end pt-2">
        <button type="submit" disabled={submitting} className="btn-primary">
          {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
          {submitting ? "Saving…" : "Create Loan Product"}
        </button>
      </div>
    </form>
  );
}

/* Local primitives mirroring NbfcMasterDetailsForm. */

function Section({
  eyebrow,
  title,
  helper,
  children,
}: {
  eyebrow: string;
  title: string;
  helper?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card-iTarang p-6 md:p-7 space-y-5">
      <header className="space-y-1">
        <p className="section-label">{eyebrow}</p>
        <h2 className="text-lg font-semibold text-[color:var(--color-brand-navy)]">
          {title}
        </h2>
        {helper && (
          <p className="text-xs text-[color:var(--color-ink-muted)]">{helper}</p>
        )}
      </header>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">{children}</div>
    </section>
  );
}

function Field({
  label,
  full,
  children,
}: {
  label: string;
  full?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`flex flex-col gap-1.5 ${full ? "md:col-span-3" : ""}`}>
      <span className="text-xs font-semibold text-[color:var(--color-ink)]">
        {label}
      </span>
      {children}
    </label>
  );
}
