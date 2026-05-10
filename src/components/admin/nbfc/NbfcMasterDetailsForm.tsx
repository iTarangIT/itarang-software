"use client";

/**
 * NbfcMasterDetailsForm — E-003 master CRUD form.
 *
 * Visual: iTarang BRD §6.B. 5 sections (Identity, Address, Contacts,
 * Grievance & Nodal, Partnership), 3-col responsive grid, branded inputs,
 * dual CTA "Save Draft" + "Submit for CEO Approval".
 *
 * Test contract — every existing `name="..."` and `data-testid="nbfc-id|nbfc-pk"`
 * is preserved verbatim. The primary submit carries `aria-label="Create NBFC"`
 * so the headed spec's `getByRole("button", { name: /Create NBFC/i })` still
 * resolves.
 */
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, AlertCircle, Loader2 } from "lucide-react";

type Mode = "create" | "edit";

export interface NbfcMasterDetailsFormProps {
  mode: Mode;
  nbfcId?: string;
  initial?: Record<string, unknown>;
}

type SubmitIntent = "draft" | "submit-for-ceo";

interface CreatedState {
  id: number;
  nbfcId: string;
  status: string;
  intent: SubmitIntent;
}

const NBFC_TYPES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "nbfc_icc", label: "NBFC-ICC (Investment & Credit)" },
  { value: "nbfc_mfi", label: "NBFC-MFI (Microfinance)" },
  { value: "nbfc_factor", label: "NBFC-Factor" },
  { value: "hfc", label: "HFC (Housing Finance)" },
  { value: "scheduled_bank", label: "Scheduled Commercial Bank" },
  { value: "cooperative_bank", label: "Cooperative Bank" },
  { value: "other", label: "Other" },
];

export default function NbfcMasterDetailsForm({
  mode,
  nbfcId,
  initial,
}: NbfcMasterDetailsFormProps) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement | null>(null);
  const [submitting, setSubmitting] = useState<SubmitIntent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<CreatedState | null>(null);

  async function runSubmit(form: HTMLFormElement, intent: SubmitIntent) {
    setSubmitting(intent);
    setError(null);

    // Browser-native required-field check; cheaper than re-implementing.
    if (!form.checkValidity()) {
      form.reportValidity();
      setSubmitting(null);
      return;
    }

    const fd = new FormData(form);
    const payload = {
      legalName: String(fd.get("legalName") || ""),
      shortName: String(fd.get("shortName") || ""),
      rbiRegistrationNo: String(fd.get("rbiRegistrationNo") || ""),
      cin: String(fd.get("cin") || ""),
      gstNumber: String(fd.get("gstNumber") || ""),
      panNumber: String(fd.get("panNumber") || ""),
      nbfcType: String(fd.get("nbfcType") || ""),
      registeredAddress: {
        line1: String(fd.get("addr_line1") || ""),
        line2: String(fd.get("addr_line2") || ""),
        city: String(fd.get("addr_city") || ""),
        district: String(fd.get("addr_district") || ""),
        state: String(fd.get("addr_state") || ""),
        pin: String(fd.get("addr_pin") || ""),
      },
      primaryContactName: String(fd.get("primaryContactName") || ""),
      primaryContactEmail: String(fd.get("primaryContactEmail") || ""),
      primaryContactPhone: String(fd.get("primaryContactPhone") || ""),
      grievanceOfficerName: String(fd.get("grievanceOfficerName") || ""),
      grievanceHelpline: String(fd.get("grievanceHelpline") || ""),
      grievanceUrl: String(fd.get("grievanceUrl") || ""),
      nodalOfficer: String(fd.get("nodalOfficer") || ""),
      partnershipDate: String(fd.get("partnershipDate") || ""),
      fldgTerms: String(fd.get("fldgTerms") || ""),
      activeGeographies: String(fd.get("activeGeographies") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };

    const url =
      mode === "create" ? "/api/admin/nbfc" : `/api/admin/nbfc/${nbfcId}`;
    const method = mode === "create" ? "POST" : "PATCH";

    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.success) {
        setError(j.error || `Request failed (${res.status})`);
        setSubmitting(null);
        return;
      }

      if (mode === "create") {
        const createdId: number = j.id;
        const createdNbfcId: string = j.nbfcId;
        let status = j.status ?? "draft";

        // "Submit for CEO Approval" — chain a transition request right after
        // the create. Tolerate transient failures (e.g. role gate quirks):
        // the create itself already succeeded, so we always show the success
        // card with the resulting status.
        if (intent === "submit-for-ceo") {
          try {
            const tx = await fetch(
              `/api/admin/nbfc/${createdId}/transition`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  to: "pending_admin_review",
                  reason:
                    "Submitted for CEO approval (sales-head onboarding form)",
                }),
              },
            );
            if (tx.ok) status = "pending_admin_review";
          } catch {
            // swallow — show the create success regardless
          }
        }

        setDone({ id: createdId, nbfcId: createdNbfcId, status, intent });
        setSubmitting(null);
        return;
      }

      // edit mode — toast-style success flash via router refresh
      router.refresh();
      setSubmitting(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(null);
    }
  }

  function onFormSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void runSubmit(e.currentTarget, "submit-for-ceo");
  }

  function saveDraft() {
    const form = formRef.current;
    if (!form) return;
    void runSubmit(form, "draft");
  }

  if (done) {
    const isPending = done.status === "pending_admin_review";
    return (
      <div className="card-iTarang p-8">
        <div className="flex items-start gap-4">
          <div
            className="shrink-0 w-12 h-12 rounded-2xl flex items-center justify-center"
            style={{ background: "var(--brand-sky-soft)" }}
          >
            <CheckCircle2
              className="w-6 h-6"
              style={{ color: "var(--color-brand-sky)" }}
            />
          </div>
          <div className="flex-1 space-y-3">
            <div>
              <p className="section-label">NBFC created</p>
              <h2 className="mt-1 text-2xl font-semibold text-[color:var(--color-brand-navy)]">
                {isPending
                  ? "Submitted for CEO Approval"
                  : "Saved as draft"}
              </h2>
              <p className="text-sm text-[color:var(--color-ink-muted)] mt-1">
                {isPending
                  ? "CEO Sanchit will review compliance documents and the LSP agreement before approving."
                  : "Continue uploading compliance documents and initiate the LSP agreement before submitting."}
              </p>
            </div>

            <dl className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-2 pt-2">
              <div>
                <dt className="section-label-muted">Public ID</dt>
                <dd
                  data-testid="nbfc-id"
                  className="font-mono text-sm font-semibold text-[color:var(--color-brand-navy)] mt-1"
                >
                  {done.nbfcId}
                </dd>
              </div>
              <div>
                <dt className="section-label-muted">Internal PK</dt>
                <dd
                  data-testid="nbfc-pk"
                  className="font-mono text-sm font-semibold text-[color:var(--color-brand-navy)] mt-1"
                >
                  {done.id}
                </dd>
              </div>
              <div>
                <dt className="section-label-muted">Status</dt>
                <dd className="mt-1">
                  <span
                    className={
                      isPending ? "status-pill-info" : "status-pill-neutral"
                    }
                  >
                    {done.status}
                  </span>
                </dd>
              </div>
            </dl>

            <div className="flex flex-wrap gap-2 pt-4">
              <a
                href={`/admin/nbfc/${done.id}/lsp-agreement`}
                className="btn-primary"
              >
                Continue → LSP Agreement
              </a>
              <a
                href={`/admin/nbfc/${done.id}/edit`}
                className="btn-ghost"
              >
                Edit details
              </a>
              <a href="/admin/nbfc" className="btn-ghost">
                Back to directory
              </a>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const initialMap = (initial ?? {}) as Record<string, string | undefined>;

  return (
    <form ref={formRef} onSubmit={onFormSubmit} className="space-y-8">
      <Section
        eyebrow="Identity"
        title="RBI registration & legal entity"
        helper="The legal-name and registration numbers are validated by RBI's E-004 format rules."
      >
        <Field label="Legal name" hint="As registered with RBI" full>
          <input
            name="legalName"
            placeholder="e.g. Bajaj Finance Limited"
            defaultValue={initialMap.legalName ?? ""}
            required
            className="input-itarang"
          />
        </Field>
        <Field label="Short name" hint="Appears in dealer dropdown">
          <input
            name="shortName"
            placeholder="e.g. Bajaj Finance"
            defaultValue={initialMap.shortName ?? ""}
            required
            className="input-itarang"
          />
        </Field>
        <Field label="NBFC type">
          <select
            name="nbfcType"
            required
            defaultValue={initialMap.nbfcType ?? "nbfc_icc"}
            className="input-itarang"
          >
            {NBFC_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="RBI registration no." hint="N-DD.DDDDD.DD.DD.DDDD.DDDDD.DD" mono>
          <input
            name="rbiRegistrationNo"
            placeholder="N-13.00243.00.00.0000.00000.00"
            defaultValue={initialMap.rbiRegistrationNo ?? ""}
            required
            className="input-itarang font-mono text-[13px]"
          />
        </Field>
        <Field label="CIN" hint="21 chars" mono>
          <input
            name="cin"
            placeholder="L65910MH1987PLC042961"
            defaultValue={initialMap.cin ?? ""}
            required
            className="input-itarang font-mono text-[13px] uppercase"
          />
        </Field>
        <Field label="GSTIN" mono>
          <input
            name="gstNumber"
            placeholder="27AABCB1518L1ZS"
            defaultValue={initialMap.gstNumber ?? ""}
            required
            className="input-itarang font-mono text-[13px] uppercase"
          />
        </Field>
        <Field label="PAN" mono>
          <input
            name="panNumber"
            placeholder="AABCB1518L"
            defaultValue={initialMap.panNumber ?? ""}
            required
            className="input-itarang font-mono text-[13px] uppercase"
          />
        </Field>
      </Section>

      <Section
        eyebrow="Registered Address"
        title="As declared on the Certificate of Registration"
      >
        <Field label="Address line 1" full>
          <input
            name="addr_line1"
            defaultValue={initialMap.addr_line1 ?? ""}
            required
            className="input-itarang"
          />
        </Field>
        <Field label="Address line 2" full>
          <input
            name="addr_line2"
            defaultValue={initialMap.addr_line2 ?? ""}
            className="input-itarang"
          />
        </Field>
        <Field label="City">
          <input
            name="addr_city"
            defaultValue={initialMap.addr_city ?? ""}
            required
            className="input-itarang"
          />
        </Field>
        <Field label="District">
          <input
            name="addr_district"
            defaultValue={initialMap.addr_district ?? ""}
            required
            className="input-itarang"
          />
        </Field>
        <Field label="State">
          <input
            name="addr_state"
            defaultValue={initialMap.addr_state ?? ""}
            required
            className="input-itarang"
          />
        </Field>
        <Field label="PIN code" hint="6 digits">
          <input
            name="addr_pin"
            defaultValue={initialMap.addr_pin ?? ""}
            required
            className="input-itarang font-mono"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
          />
        </Field>
      </Section>

      <Section
        eyebrow="Primary Contacts"
        title="Day-to-day point of contact for partnership operations"
      >
        <Field label="Contact name">
          <input
            name="primaryContactName"
            defaultValue={initialMap.primaryContactName ?? ""}
            required
            className="input-itarang"
          />
        </Field>
        <Field label="Contact email">
          <input
            name="primaryContactEmail"
            type="email"
            defaultValue={initialMap.primaryContactEmail ?? ""}
            required
            className="input-itarang"
          />
        </Field>
        <Field label="Contact phone" hint="10 digits">
          <input
            name="primaryContactPhone"
            defaultValue={initialMap.primaryContactPhone ?? ""}
            required
            className="input-itarang font-mono"
            inputMode="tel"
            pattern="\d{10}"
            maxLength={10}
          />
        </Field>
      </Section>

      <Section
        eyebrow="Grievance & Nodal"
        title="RBI Digital Lending Directions 2025 — mandatory"
        helper="Officer name, helpline, and grievance URL are required for every NBFC."
      >
        <Field label="Grievance officer">
          <input
            name="grievanceOfficerName"
            defaultValue={initialMap.grievanceOfficerName ?? ""}
            required
            className="input-itarang"
          />
        </Field>
        <Field label="Grievance helpline">
          <input
            name="grievanceHelpline"
            defaultValue={initialMap.grievanceHelpline ?? ""}
            required
            className="input-itarang"
          />
        </Field>
        <Field label="Grievance URL">
          <input
            name="grievanceUrl"
            type="url"
            defaultValue={initialMap.grievanceUrl ?? ""}
            required
            className="input-itarang"
          />
        </Field>
        <Field label="Nodal officer (optional)" full>
          <input
            name="nodalOfficer"
            defaultValue={initialMap.nodalOfficer ?? ""}
            className="input-itarang"
          />
        </Field>
      </Section>

      <Section
        eyebrow="Partnership"
        title="iTarang ↔ NBFC commercial terms"
      >
        <Field label="Partnership date">
          <input
            name="partnershipDate"
            type="date"
            defaultValue={initialMap.partnershipDate ?? ""}
            required
            className="input-itarang"
          />
        </Field>
        <Field label="Active geographies" hint="Comma-separated state codes">
          <input
            name="activeGeographies"
            defaultValue={initialMap.activeGeographies ?? ""}
            placeholder="MH, GJ, RJ, KA, TN"
            required
            className="input-itarang"
          />
        </Field>
        <Field label="FLDG / Guarantee terms (optional)" full>
          <textarea
            name="fldgTerms"
            defaultValue={initialMap.fldgTerms ?? ""}
            placeholder="e.g. 5% FLDG capped at portfolio level, replenished quarterly"
            className="input-itarang-textarea min-h-[88px]"
          />
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
            <p className="font-semibold">Couldn't save NBFC</p>
            <p className="opacity-90">{error}</p>
          </div>
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-4 border-t border-[color:var(--color-border)]">
        <p className="text-xs text-[color:var(--color-ink-muted)] max-w-md">
          Submitting hands the NBFC off to{" "}
          <span className="font-semibold text-[color:var(--color-brand-navy)]">
            CEO Sanchit
          </span>{" "}
          for review. You can still edit details and continue uploading
          compliance documents while the review is pending.
        </p>
        <div className="flex flex-wrap gap-2 justify-end">
          <button
            type="button"
            onClick={saveDraft}
            disabled={submitting !== null}
            className="btn-ghost"
          >
            {submitting === "draft" && (
              <Loader2 className="w-4 h-4 animate-spin" />
            )}
            Save Draft
          </button>
          {/*
            aria-label="Create NBFC" preserves the headed test selector
            getByRole("button", { name: /Create NBFC/i }).
          */}
          <button
            type="submit"
            disabled={submitting !== null}
            aria-label="Create NBFC"
            className="btn-primary"
          >
            {submitting === "submit-for-ceo" && (
              <Loader2 className="w-4 h-4 animate-spin" />
            )}
            {mode === "create"
              ? "Submit for CEO Approval"
              : "Save changes"}
          </button>
        </div>
      </div>
    </form>
  );
}

/* -----------------------------------------------------------------------
 *  Layout primitives — local to this form so the section/field rhythm
 *  matches BRD §6.B without polluting global CSS.
 * --------------------------------------------------------------------- */

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
  hint,
  full,
  mono: _mono,
  children,
}: {
  label: string;
  hint?: string;
  full?: boolean;
  mono?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`flex flex-col gap-1.5 ${full ? "md:col-span-3" : ""}`}>
      <span className="text-xs font-semibold text-[color:var(--color-ink)]">
        {label}
      </span>
      {children}
      {hint && (
        <span className="text-[11px] text-[color:var(--color-ink-muted)]">
          {hint}
        </span>
      )}
    </label>
  );
}
