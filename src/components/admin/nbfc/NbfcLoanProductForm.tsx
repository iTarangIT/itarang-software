"use client";

/**
 * NbfcLoanProductForm — E-009 per-NBFC loan product creation.
 *
 * Visual: BRD §6.B. Sectioned (Product, Eligibility, Geography, Scheme
 * Highlights, Eligibility docs, Loan Parameters term-sheet). Scheme Highlights
 * uses independent housing-variant blocks with nested Health+Life Insurance and
 * an explicit CIBIL applicability toggle + min/max score range (E-115).
 *
 * Test contract — every existing `name="..."` and the form-root
 * `data-testid="nbfc-loan-product-form"` are preserved verbatim.
 */
import { useState } from "react";
import dynamic from "next/dynamic";
import { Loader2, AlertCircle, Plus, X } from "lucide-react";
import type { LocationPair } from "./StateCityPicker";

// Lazy-load the picker so the ~150 kB India states/cities dataset only ships
// to clients that actually open this form.
const StateCityPicker = dynamic(() => import("./StateCityPicker"), {
  ssr: false,
  loading: () => (
    <p className="text-xs text-[color:var(--color-ink-muted)] italic">
      Loading state &amp; city picker…
    </p>
  ),
});

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
  const [activeLocations, setActiveLocations] = useState<LocationPair[]>([]);

  // Scheme Highlights — housing variants (E-115 redesign).
  // Each variant is opt-in. Health+Life Insurance is nested per variant.
  const [ownedApplicable, setOwnedApplicable] = useState(true);
  const [rentedApplicable, setRentedApplicable] = useState(false);
  const [processingFeeOwned, setProcessingFeeOwned] = useState("");
  const [processingFeeRented, setProcessingFeeRented] = useState("");
  const [ownedHealthLifeApplicable, setOwnedHealthLifeApplicable] = useState(false);
  const [rentedHealthLifeApplicable, setRentedHealthLifeApplicable] = useState(false);
  const [healthLifeInsuranceOwned, setHealthLifeInsuranceOwned] = useState("");
  const [healthLifeInsuranceRented, setHealthLifeInsuranceRented] = useState("");
  const [disbursementTatHours, setDisbursementTatHours] = useState("");

  // CIBIL / CRIF gate + range (E-115).
  const [cibilRequired, setCibilRequired] = useState(true);
  const [minCreditScore, setMinCreditScore] = useState("");
  const [maxCreditScore, setMaxCreditScore] = useState("");

  const [eligibilityDocs, setEligibilityDocs] = useState<string[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleCategory = (cat: BatteryCategory) =>
    setCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat],
    );

  const updateEligibilityDoc = (idx: number, value: string) =>
    setEligibilityDocs((prev) => prev.map((d, i) => (i === idx ? value : d)));

  const removeEligibilityDoc = (idx: number) =>
    setEligibilityDocs((prev) => prev.filter((_, i) => i !== idx));

  const addEligibilityDoc = () =>
    setEligibilityDocs((prev) => [...prev, ""]);

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
      activeLocations,
      cibilRequired,
      eligibilityDocuments: eligibilityDocs
        .map((d) => d.trim())
        .filter((d) => d.length > 0),
    };
    if (fileChargeFixed !== "") body.fileChargeFixed = Number(fileChargeFixed);
    if (fileChargePct !== "") body.fileChargePct = Number(fileChargePct);

    // Owned housing variant — gate fee + insurance behind the variant toggle.
    if (ownedApplicable && processingFeeOwned !== "")
      body.processingFeeOwnedRupees = Number(processingFeeOwned);
    if (
      ownedApplicable &&
      ownedHealthLifeApplicable &&
      healthLifeInsuranceOwned !== ""
    )
      body.healthLifeInsuranceOwnedRupees = Number(healthLifeInsuranceOwned);

    // Rented housing variant — same shape.
    if (rentedApplicable && processingFeeRented !== "")
      body.processingFeeRentedRupees = Number(processingFeeRented);
    if (
      rentedApplicable &&
      rentedHealthLifeApplicable &&
      healthLifeInsuranceRented !== ""
    )
      body.healthLifeInsuranceRentedRupees = Number(healthLifeInsuranceRented);

    if (disbursementTatHours !== "")
      body.disbursementTatHours = Number(disbursementTatHours);

    // CIBIL range only when the gate is on. API zod will reject mismatched/
    // missing values, so we just pass through what the user typed.
    if (cibilRequired) {
      if (minCreditScore !== "") body.minCreditScore = Number(minCreditScore);
      if (maxCreditScore !== "") body.maxCreditScore = Number(maxCreditScore);
    }

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
        eyebrow="Geography"
        title="States and cities this scheme is available in"
        helper="Pick a state, then choose the cities within it. Add another row for additional states. Dealers outside the listed locations won't see this product."
      >
        <div className="md:col-span-3">
          <StateCityPicker
            value={activeLocations}
            onChange={setActiveLocations}
          />
        </div>
      </Section>

      <Section
        eyebrow="Scheme highlights"
        title="Housing variants, insurance & bureau gate"
        helper="Turn on each housing variant the NBFC underwrites. Health + Life Insurance is opt-in per variant. CIBIL/CRIF can be waived for the whole scheme."
      >
        <div className="md:col-span-3 space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <HousingVariantCard
              label="Apply to Owned House"
              variantKey="owned"
              applicable={ownedApplicable}
              onToggleApplicable={setOwnedApplicable}
              fee={processingFeeOwned}
              onFeeChange={setProcessingFeeOwned}
              feeName="processingFeeOwnedRupees"
              feePlaceholder="e.g. 5500"
              insuranceApplicable={ownedHealthLifeApplicable}
              onToggleInsurance={setOwnedHealthLifeApplicable}
              insurance={healthLifeInsuranceOwned}
              onInsuranceChange={setHealthLifeInsuranceOwned}
              insuranceName="healthLifeInsuranceOwnedRupees"
              insurancePlaceholder="e.g. 1000"
            />
            <HousingVariantCard
              label="Apply to Rented House"
              variantKey="rented"
              applicable={rentedApplicable}
              onToggleApplicable={setRentedApplicable}
              fee={processingFeeRented}
              onFeeChange={setProcessingFeeRented}
              feeName="processingFeeRentedRupees"
              feePlaceholder="e.g. 7000"
              insuranceApplicable={rentedHealthLifeApplicable}
              onToggleInsurance={setRentedHealthLifeApplicable}
              insurance={healthLifeInsuranceRented}
              onInsuranceChange={setHealthLifeInsuranceRented}
              insuranceName="healthLifeInsuranceRentedRupees"
              insurancePlaceholder="e.g. 1000"
            />
          </div>

          <Field label="Disbursement TAT (hours)">
            <input
              type="number"
              value={disbursementTatHours}
              onChange={(e) => setDisbursementTatHours(e.target.value)}
              min={1}
              step={1}
              className="input-itarang"
              name="disbursementTatHours"
              placeholder="e.g. 48"
            />
          </Field>

          <div
            className="rounded-xl border p-4 space-y-3"
            style={{
              borderColor: "var(--color-border)",
              background: "var(--color-surface-soft, #F7FAFC)",
            }}
          >
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={cibilRequired}
                onChange={(e) => setCibilRequired(e.target.checked)}
                name="cibilRequired"
                className="mt-1 w-4 h-4 cursor-pointer accent-[color:var(--color-brand-sky)]"
              />
              <span>
                <span className="block text-sm font-semibold text-[color:var(--color-ink)]">
                  CIBIL / CRIF score required for all borrowers
                </span>
                <span className="block text-xs text-[color:var(--color-ink-muted)] mt-0.5">
                  When off, the bureau score check is waived for this scheme and
                  no score range is enforced.
                </span>
              </span>
            </label>

            {cibilRequired && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pl-7">
                <Field label="Min score (300–900)">
                  <input
                    type="number"
                    value={minCreditScore}
                    onChange={(e) => setMinCreditScore(e.target.value)}
                    min={300}
                    max={900}
                    step={1}
                    required={cibilRequired}
                    className="input-itarang"
                    name="minCreditScore"
                    placeholder="e.g. 650"
                  />
                </Field>
                <Field label="Max score (300–900)">
                  <input
                    type="number"
                    value={maxCreditScore}
                    onChange={(e) => setMaxCreditScore(e.target.value)}
                    min={300}
                    max={900}
                    step={1}
                    required={cibilRequired}
                    className="input-itarang"
                    name="maxCreditScore"
                    placeholder="e.g. 850"
                  />
                </Field>
              </div>
            )}
          </div>
        </div>
      </Section>

      <Section
        eyebrow="Eligibility"
        title="Borrower requirements & required documents"
        helper="Shown to dealers and borrowers verbatim. Add one bullet per row."
      >
        <div className="md:col-span-3 space-y-2">
          {eligibilityDocs.length === 0 && (
            <p className="text-xs text-[color:var(--color-ink-muted)] italic">
              No requirements yet. Click "Add requirement" to start.
            </p>
          )}
          {eligibilityDocs.map((doc, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <input
                type="text"
                value={doc}
                onChange={(e) => updateEligibilityDoc(idx, e.target.value)}
                maxLength={500}
                className="input-itarang flex-1"
                name="eligibilityDocuments"
                placeholder="e.g. Aadhaar Card, PAN Card, Bank Statement mandatory"
              />
              <button
                type="button"
                onClick={() => removeEligibilityDoc(idx)}
                aria-label="Remove requirement"
                className="inline-flex items-center justify-center w-9 h-9 rounded-lg border border-[color:var(--color-border)] bg-white text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-danger)] hover:border-[color:var(--color-danger)] transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={addEligibilityDoc}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-[color:var(--color-brand-sky)] hover:text-[color:var(--color-brand-navy)] transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add requirement
          </button>
        </div>
      </Section>

      <Section
        eyebrow="Loan Parameters"
        title="Term sheet"
        helper="Amount band, tenure, pricing knobs, and charges in a single editable table."
      >
        <div className="md:col-span-3">
          <div className="rounded-xl border overflow-hidden" style={{ borderColor: "var(--color-border)" }}>
            <div
              className="hidden md:grid grid-cols-[1.4fr_1fr_1fr_0.6fr] gap-3 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide"
              style={{
                color: "var(--color-ink-muted)",
                background: "var(--color-surface-soft, #F7FAFC)",
                borderBottom: "1px solid var(--color-border)",
              }}
            >
              <span>Parameter</span>
              <span>Min</span>
              <span>Max</span>
              <span>Unit</span>
            </div>

            <ParamRow
              label="Loan amount"
              unit="₹"
              min={
                <input
                  type="number"
                  value={loanAmountMin}
                  onChange={(e) => setLoanAmountMin(e.target.value)}
                  required
                  min={0}
                  className="input-itarang"
                  name="loanAmountMin"
                  placeholder="e.g. 50000"
                />
              }
              max={
                <input
                  type="number"
                  value={loanAmountMax}
                  onChange={(e) => setLoanAmountMax(e.target.value)}
                  required
                  min={1}
                  className="input-itarang"
                  name="loanAmountMax"
                  placeholder="e.g. 500000"
                />
              }
            />

            <ParamRow
              label="Tenure"
              unit="months"
              min={
                <input
                  type="number"
                  value={tenureMin}
                  onChange={(e) => setTenureMin(e.target.value)}
                  required
                  min={1}
                  className="input-itarang"
                  name="tenureMonthsMin"
                  placeholder="e.g. 12"
                />
              }
              max={
                <input
                  type="number"
                  value={tenureMax}
                  onChange={(e) => setTenureMax(e.target.value)}
                  required
                  min={1}
                  className="input-itarang"
                  name="tenureMonthsMax"
                  placeholder="e.g. 36"
                />
              }
            />

            <ParamRow
              label="ROI"
              unit="% p.a."
              min={
                <input
                  type="number"
                  value={minRoi}
                  onChange={(e) => setMinRoi(e.target.value)}
                  required
                  step="0.01"
                  min={0}
                  className="input-itarang"
                  name="minRoiPct"
                  placeholder="e.g. 14.00"
                />
              }
              max={
                <input
                  type="number"
                  value={maxRoi}
                  onChange={(e) => setMaxRoi(e.target.value)}
                  required
                  step="0.01"
                  min={0}
                  className="input-itarang"
                  name="maxRoiPct"
                  placeholder="e.g. 22.00"
                />
              }
            />

            <ParamRow
              label="Down payment"
              unit="%"
              min={null}
              max={
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
                  placeholder="e.g. 20"
                />
              }
            />

            <ParamRow
              label="File charge — fixed"
              unit="₹"
              min={null}
              max={
                <input
                  type="number"
                  value={fileChargeFixed}
                  onChange={(e) => setFileChargeFixed(e.target.value)}
                  step="0.01"
                  min={0}
                  className="input-itarang"
                  name="fileChargeFixed"
                  placeholder="e.g. 1500"
                />
              }
            />

            <ParamRow
              label="File charge — % of loan"
              unit="%"
              min={null}
              max={
                <input
                  type="number"
                  value={fileChargePct}
                  onChange={(e) => setFileChargePct(e.target.value)}
                  step="0.01"
                  min={0}
                  max={100}
                  className="input-itarang"
                  name="fileChargePct"
                  placeholder="e.g. 1.5"
                />
              }
            />

            <ParamRow
              label="Subvention"
              wide
              control={
                <label className="inline-flex items-center gap-2 h-11 px-3 rounded-lg border border-[color:var(--color-border)] bg-white cursor-pointer text-sm">
                  <input
                    type="checkbox"
                    checked={subventionAvailable}
                    onChange={(e) =>
                      setSubventionAvailable(e.target.checked)
                    }
                    name="subventionAvailable"
                  />
                  <span>{subventionAvailable ? "Available" : "Not available"}</span>
                </label>
              }
            />

            <ParamRow
              label="Disbursement method"
              wide
              last
              control={
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
              }
            />
          </div>
        </div>
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

/**
 * Housing-variant card for the Scheme Highlights section. An opt-in toggle
 * gates a Processing Fee + Battery Insurance input and a nested Health + Life
 * Insurance toggle/amount. When the variant is off, inputs are disabled and
 * visually muted; submit handler skips their values entirely.
 */
function HousingVariantCard({
  label,
  variantKey,
  applicable,
  onToggleApplicable,
  fee,
  onFeeChange,
  feeName,
  feePlaceholder,
  insuranceApplicable,
  onToggleInsurance,
  insurance,
  onInsuranceChange,
  insuranceName,
  insurancePlaceholder,
}: {
  label: string;
  variantKey: "owned" | "rented";
  applicable: boolean;
  onToggleApplicable: (v: boolean) => void;
  fee: string;
  onFeeChange: (v: string) => void;
  feeName: string;
  feePlaceholder: string;
  insuranceApplicable: boolean;
  onToggleInsurance: (v: boolean) => void;
  insurance: string;
  onInsuranceChange: (v: string) => void;
  insuranceName: string;
  insurancePlaceholder: string;
}) {
  return (
    <div
      className="rounded-xl border p-4 space-y-3 transition-opacity"
      style={{
        borderColor: applicable
          ? "var(--color-brand-sky)"
          : "var(--color-border)",
        background: applicable
          ? "rgba(19,143,198,0.04)"
          : "var(--color-surface-soft, #F7FAFC)",
        opacity: applicable ? 1 : 0.7,
      }}
      data-variant={variantKey}
    >
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={applicable}
          onChange={(e) => onToggleApplicable(e.target.checked)}
          className="w-4 h-4 cursor-pointer accent-[color:var(--color-brand-sky)]"
        />
        <span className="text-sm font-semibold text-[color:var(--color-ink)]">
          {label}
        </span>
      </label>

      <Field label="Processing Fee + Battery Insurance (₹)">
        <input
          type="number"
          value={fee}
          onChange={(e) => onFeeChange(e.target.value)}
          min={0}
          step={1}
          disabled={!applicable}
          className="input-itarang disabled:cursor-not-allowed disabled:bg-[color:var(--color-surface-soft,#F7FAFC)]"
          name={feeName}
          placeholder={feePlaceholder}
        />
      </Field>

      <div className="space-y-2">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={insuranceApplicable}
            onChange={(e) => onToggleInsurance(e.target.checked)}
            disabled={!applicable}
            className="w-4 h-4 cursor-pointer accent-[color:var(--color-brand-sky)] disabled:cursor-not-allowed"
          />
          <span className="text-sm font-semibold text-[color:var(--color-ink)]">
            Health + Life Insurance
          </span>
        </label>
        {applicable && insuranceApplicable && (
          <Field label="Insurance amount (₹)">
            <input
              type="number"
              value={insurance}
              onChange={(e) => onInsuranceChange(e.target.value)}
              min={0}
              step={1}
              className="input-itarang"
              name={insuranceName}
              placeholder={insurancePlaceholder}
            />
          </Field>
        )}
      </div>
    </div>
  );
}

/**
 * One row of the Loan Parameters term-sheet table. Numeric rows render
 * min/max/unit columns; when `wide` is true the `control` slot spans
 * min+max+unit (used for the Subvention toggle and Disbursement select).
 */
function ParamRow({
  label,
  unit,
  min,
  max,
  wide,
  control,
  last,
}: {
  label: string;
  unit?: string;
  min?: React.ReactNode;
  max?: React.ReactNode;
  wide?: boolean;
  control?: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className="grid grid-cols-1 md:grid-cols-[1.4fr_1fr_1fr_0.6fr] items-center gap-3 px-4 py-3"
      style={{
        borderBottom: last ? undefined : "1px solid var(--color-border)",
      }}
    >
      <span className="text-sm font-semibold text-[color:var(--color-ink)]">
        {label}
      </span>
      {wide ? (
        <div className="md:col-span-3">{control}</div>
      ) : (
        <>
          <div>
            {min ?? (
              <span className="block text-sm text-[color:var(--color-ink-muted)] px-1">
                —
              </span>
            )}
          </div>
          <div>{max}</div>
          <span className="text-xs text-[color:var(--color-ink-muted)]">
            {unit}
          </span>
        </>
      )}
    </div>
  );
}
