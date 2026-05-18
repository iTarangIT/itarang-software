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
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, AlertCircle, Loader2 } from "lucide-react";

// localStorage key for in-progress create-mode form data. Mode-scoped so an
// abandoned create draft can't bleed into an edit screen.
const DRAFT_STORAGE_KEY = "itarang:nbfc:new:draft-v1";

const PERSISTED_FIELDS = [
  "legalName",
  "shortName",
  "nbfcType",
  "rbiRegistrationNo",
  "cin",
  "gstNumber",
  "panNumber",
  "addr_line1",
  "addr_line2",
  "addr_city",
  "addr_district",
  "addr_state",
  "addr_pin",
  "primaryContactName",
  "primaryContactEmail",
  "primaryContactPhone",
  "grievanceOfficerName",
  "grievanceHelpline",
  "grievanceUrl",
  "nodalOfficer",
  "partnershipDate",
  "activeGeographies",
  "fldgTerms",
] as const;

type Mode = "create" | "edit";

export interface NbfcMasterDetailsFormProps {
  mode: Mode;
  nbfcId?: string;
  initial?: Record<string, unknown>;
  hasOpenCorrectionRound?: boolean;
  /**
   * Read-only mode. When true (NBFC is approved/active), every input is
   * disabled and the bottom CTAs are hidden. The page renders
   * NbfcReadOnlyBanner above this form.
   */
  locked?: boolean;
}

type SubmitIntent = "draft" | "submit-for-ceo";

interface CreatedState {
  id: number;
  nbfcId: string;
  status: string;
  intent: SubmitIntent;
}

// Mirrors src/app/api/admin/nbfc/route.ts createSchema.rbiRegistrationNo
const RBI_REG_REGEX = /^N-\d{2}\.\d{5}\.\d{2}\.\d{2}\.\d{4}\.\d{5}\.\d{2}$/;
const RBI_REG_PATTERN = "N-\\d{2}\\.\\d{5}\\.\\d{2}\\.\\d{2}\\.\\d{4}\\.\\d{5}\\.\\d{2}";
const RBI_REG_HINT = "N-DD.DDDDD.DD.DD.DDDD.DDDDD.DD";
const RBI_REG_ERROR = `Must match RBI format ${RBI_REG_HINT} (e.g. N-13.00243.00.00.0000.00000.00)`;

// Letters + space + . - ' so legitimate Indian names/places (St. Thomas Mount,
// D'Souza, Jean-Paul) survive. Reject digits and other symbols.
const ALPHA_NAME_PATTERN = "[A-Za-z\\s.'\\-]+";
function stripToAlpha(value: string): string {
  return value.replace(/[^A-Za-z\s.'\-]/g, "");
}
function normaliseStateCodes(value: string): string {
  return value.toUpperCase().replace(/[^A-Z,\s]/g, "");
}
// CIN / GSTIN / PAN are stored as uppercase by the server. Forcing the
// caret to stay put by reassigning to the same node is required because
// React-controlled defaultValue inputs would otherwise re-render on every
// keystroke and lose the cursor position.
function upperCaseInPlace(el: HTMLInputElement) {
  const start = el.selectionStart;
  const end = el.selectionEnd;
  const upper = el.value.toUpperCase();
  if (el.value !== upper) {
    el.value = upper;
    try {
      if (start !== null && end !== null) el.setSelectionRange(start, end);
    } catch {
      // Some input types (e.g. type=email) reject setSelectionRange; ignore.
    }
  }
}

function validateRbi(value: string): string | null {
  if (!value) return null;
  return RBI_REG_REGEX.test(value) ? null : RBI_REG_ERROR;
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

// Maps the Zod schema's dotted path (server response) to the form input's
// `name` attribute. Keeps the highlight wiring in one place instead of
// scattered string literals.
const ZOD_PATH_TO_INPUT_NAME: Record<string, string> = {
  legalName: "legalName",
  shortName: "shortName",
  rbiRegistrationNo: "rbiRegistrationNo",
  cin: "cin",
  gstNumber: "gstNumber",
  panNumber: "panNumber",
  nbfcType: "nbfcType",
  "registeredAddress.line1": "addr_line1",
  "registeredAddress.line2": "addr_line2",
  "registeredAddress.city": "addr_city",
  "registeredAddress.district": "addr_district",
  "registeredAddress.state": "addr_state",
  "registeredAddress.pin": "addr_pin",
  primaryContactName: "primaryContactName",
  primaryContactEmail: "primaryContactEmail",
  primaryContactPhone: "primaryContactPhone",
  grievanceOfficerName: "grievanceOfficerName",
  grievanceHelpline: "grievanceHelpline",
  grievanceUrl: "grievanceUrl",
  nodalOfficer: "nodalOfficer",
  partnershipDate: "partnershipDate",
  activeGeographies: "activeGeographies",
  fldgTerms: "fldgTerms",
};

// Friendly fallbacks for fields whose default Zod messages ("Invalid",
// "Required") read as noise. Keyed by the input `name`.
const FRIENDLY_FIELD_ERROR: Record<string, string> = {
  cin: "CIN must be 21 characters (e.g. L65910MH1987PLC042961)",
  gstNumber: "GSTIN must be 15 chars (e.g. 27AABCB1518L1ZS)",
  panNumber: "PAN must be 10 chars (e.g. AABCB1518L)",
  rbiRegistrationNo: RBI_REG_ERROR,
  primaryContactEmail: "Enter a valid email address",
  primaryContactPhone: "Phone must be 10 digits",
  grievanceUrl: "Enter a valid URL (https://…)",
  addr_pin: "PIN must be 6 digits",
  activeGeographies:
    "Comma-separated two-letter state codes (e.g. MH, GJ, RJ)",
  partnershipDate: "Pick a partnership date",
};

export default function NbfcMasterDetailsForm({
  mode,
  nbfcId,
  initial,
  hasOpenCorrectionRound = false,
  locked = false,
}: NbfcMasterDetailsFormProps) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement | null>(null);
  const [submitting, setSubmitting] = useState<SubmitIntent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<CreatedState | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [rbiTouched, setRbiTouched] = useState(false);
  const [restored, setRestored] = useState(false);

  const rbiError = fieldErrors.rbiRegistrationNo ?? null;

  function setFieldError(name: string, msg: string | null) {
    setFieldErrors((prev) => {
      const next = { ...prev };
      if (msg) next[name] = msg;
      else delete next[name];
      return next;
    });
  }

  function clearFieldErrorOnChange(name: string) {
    return () => {
      if (fieldErrors[name]) setFieldError(name, null);
    };
  }

  function inputErrorClass(name: string): string {
    return fieldErrors[name]
      ? "border-[color:var(--color-danger)] ring-1 ring-[color:var(--color-danger)]"
      : "";
  }

  // Rehydrate in-progress create-mode draft from localStorage on mount.
  // Edit mode is skipped because its initial values are DB-backed.
  useEffect(() => {
    if (mode !== "create") return;
    if (typeof window === "undefined") return;
    const form = formRef.current;
    if (!form) return;

    try {
      const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
      if (!raw) return;
      const cached = JSON.parse(raw) as Record<string, string>;
      let anyFilled = false;
      for (const name of PERSISTED_FIELDS) {
        const val = cached[name];
        if (typeof val !== "string" || val === "") continue;
        const el = form.elements.namedItem(name) as
          | HTMLInputElement
          | HTMLTextAreaElement
          | HTMLSelectElement
          | null;
        if (!el) continue;
        el.value = val;
        anyFilled = true;
      }
      if (anyFilled) setRestored(true);
    } catch {
      // Corrupted cache — drop it silently and start fresh.
      window.localStorage.removeItem(DRAFT_STORAGE_KEY);
    }
  }, [mode]);

  // Snapshot the form into localStorage on every change. Uncontrolled inputs
  // bubble onChange to the form root, so a single handler covers all fields.
  function persistDraft() {
    if (mode !== "create") return;
    if (typeof window === "undefined") return;
    const form = formRef.current;
    if (!form) return;
    try {
      const fd = new FormData(form);
      const snapshot: Record<string, string> = {};
      for (const name of PERSISTED_FIELDS) {
        snapshot[name] = String(fd.get(name) ?? "");
      }
      window.localStorage.setItem(
        DRAFT_STORAGE_KEY,
        JSON.stringify(snapshot),
      );
    } catch {
      // Quota / private-mode failures are not fatal — user just loses autosave.
    }
  }

  function clearPersistedDraft() {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.removeItem(DRAFT_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  function focusFirstError(errors: Record<string, string>) {
    const form = formRef.current;
    if (!form) return;
    const firstName = Object.keys(errors)[0];
    if (!firstName) return;
    const el = form.elements.namedItem(firstName) as
      | HTMLInputElement
      | HTMLTextAreaElement
      | HTMLSelectElement
      | null;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    // Defer focus so the scroll animation isn't interrupted.
    setTimeout(() => el.focus({ preventScroll: true }), 250);
  }

  async function runSubmit(form: HTMLFormElement, intent: SubmitIntent) {
    // Hard guard for read-only mode — the UI hides the CTAs but a stray
    // programmatic submit (Enter key, etc.) must also be a no-op.
    if (locked) return;
    setSubmitting(intent);
    setError(null);
    setFieldErrors({});

    // Browser-native required-field check; cheaper than re-implementing.
    if (!form.checkValidity()) {
      // Walk every form control and surface every invalid one (not just the
      // browser's default "first failure tooltip" UX) so the user sees red
      // borders + inline messages on all of them at once.
      const native: Record<string, string> = {};
      for (const el of Array.from(form.elements)) {
        const ctrl = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        if (!ctrl.name || ctrl.willValidate === false) continue;
        if (!ctrl.checkValidity()) {
          native[ctrl.name] =
            FRIENDLY_FIELD_ERROR[ctrl.name] ||
            ctrl.validationMessage ||
            "Please check this field";
        }
      }
      setFieldErrors(native);
      setError(
        "Some fields don't match the required format — see highlighted fields below.",
      );
      focusFirstError(native);
      form.reportValidity();
      setSubmitting(null);
      return;
    }

    const rbiValue = String(new FormData(form).get("rbiRegistrationNo") || "");
    const rbiCheck = validateRbi(rbiValue);
    if (rbiCheck) {
      setRbiTouched(true);
      setFieldError("rbiRegistrationNo", rbiCheck);
      setError(
        "Some fields don't match the required format — see highlighted fields below.",
      );
      focusFirstError({ rbiRegistrationNo: rbiCheck });
      setSubmitting(null);
      return;
    }

    const fd = new FormData(form);
    // CIN, GSTIN, PAN are stored with `.uppercase` CSS but the underlying
    // value preserves whatever case the user typed. Normalise here so the
    // server's strict [A-Z]{...} regexes don't reject "khupk6198m" when the
    // user *thought* they typed uppercase (the field looked uppercase).
    const payload = {
      legalName: String(fd.get("legalName") || "").trim(),
      shortName: String(fd.get("shortName") || "").trim(),
      rbiRegistrationNo: String(fd.get("rbiRegistrationNo") || "").trim(),
      cin: String(fd.get("cin") || "").trim().toUpperCase(),
      gstNumber: String(fd.get("gstNumber") || "").trim().toUpperCase(),
      panNumber: String(fd.get("panNumber") || "").trim().toUpperCase(),
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
        if (j.error === "validation_failed") {
          // New shape: details.fieldErrors is a path-keyed flat map
          // (e.g. "registeredAddress.city": "Letters only"). Translate
          // each path into the form input's `name` so we can highlight it.
          const rawFieldErrors =
            (j?.details?.fieldErrors as Record<string, string | string[]>) ||
            {};
          const mapped: Record<string, string> = {};
          for (const [path, msg] of Object.entries(rawFieldErrors)) {
            const inputName = ZOD_PATH_TO_INPUT_NAME[path] ?? path;
            const flat = Array.isArray(msg) ? msg[0] : msg;
            if (!flat) continue;
            mapped[inputName] =
              FRIENDLY_FIELD_ERROR[inputName] || String(flat);
          }
          if (mapped.rbiRegistrationNo) setRbiTouched(true);
          setFieldErrors(mapped);
          setError(
            "Some fields don't match the required format — see highlighted fields below.",
          );
          focusFirstError(mapped);
        } else if (j.error === "rbi_registration_no_already_exists") {
          setRbiTouched(true);
          const msg = "This RBI registration number is already on file";
          setFieldErrors({ rbiRegistrationNo: msg });
          setError(msg);
          focusFirstError({ rbiRegistrationNo: msg });
        } else {
          setError(j.error || `Request failed (${res.status})`);
        }
        setSubmitting(null);
        return;
      }

      if (mode === "create") {
        const createdId: number = j.id;
        const createdNbfcId: string = j.nbfcId;
        const status = j.status ?? "draft";

        // Per BRD §6.0.2, Step 1 only persists the master record (status:
        // draft). The transition to pending_admin_review is Step 5 and is
        // performed downstream — it does not belong on the Step 1 form.
        clearPersistedDraft();
        setDone({ id: createdId, nbfcId: createdNbfcId, status, intent });
        setSubmitting(null);
        return;
      }

      // edit mode — if the NBFC is still a draft, surface the same Next CTA
      // success card used by create mode so the admin keeps moving through
      // the 3-step flow (Master → Documents → LSP). When a CEO correction
      // round is open, also surface a success card so the admin gets a clear
      // Next → Approval handoff instead of a silent refresh. Once the NBFC
      // has left draft AND has no open round (e.g. approved/active
      // grievance-only edits), fall back to a toast-style success flash.
      const editedStatus: string = j.status ?? "";
      const editedNbfcId: string | undefined = j.nbfcId;
      const editedPk = Number(nbfcId);
      const eligibleForSuccessCard =
        editedStatus === "draft" || hasOpenCorrectionRound;
      if (eligibleForSuccessCard && Number.isInteger(editedPk) && editedPk > 0) {
        setDone({
          id: editedPk,
          nbfcId: editedNbfcId ?? "",
          status: editedStatus,
          intent,
        });
        setSubmitting(null);
        return;
      }
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
    const isDraftOnly = done.intent === "draft";
    const isEdit = mode === "edit";
    const isCorrectionFlow = isEdit && hasOpenCorrectionRound;
    const eyebrowText = isEdit ? "Master details" : "NBFC created";
    const headingText = isCorrectionFlow
      ? "Corrections saved"
      : isEdit
        ? "Changes saved"
        : isDraftOnly
          ? "Saved as draft"
          : "Master details saved";
    const subtitleText = isCorrectionFlow
      ? "Review the application and submit corrections for CEO approval from the Approval step."
      : isEdit
        ? "Continue to compliance documents to keep moving through onboarding."
        : isDraftOnly
          ? "Pick up where you left off any time — the record is parked as a draft in the directory."
          : "Next: upload the 11 compliance documents required by RBI DL Directions 2025 (BRD §6.0.4).";
    const nextHref = isCorrectionFlow
      ? `/admin/nbfc/${done.id}/approval`
      : `/admin/nbfc/${done.id}/documents`;
    const nextLabel = isCorrectionFlow
      ? "Next → Approval"
      : "Next → Compliance Documents";
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
              <p className="section-label">{eyebrowText}</p>
              <h2 className="mt-1 text-2xl font-semibold text-[color:var(--color-brand-navy)]">
                {headingText}
              </h2>
              <p className="text-sm text-[color:var(--color-ink-muted)] mt-1">
                {subtitleText}
              </p>
            </div>

            {/* Public ID / Internal PK / Status — useful on create as a
             * confirmation the row persisted, but redundant on edit (the
             * admin already knows the NBFC). Hidden in edit mode. */}
            {!isEdit && (
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
                    <span className="status-pill-neutral">{done.status}</span>
                  </dd>
                </div>
              </dl>
            )}

            <div className="flex flex-wrap gap-2 pt-4">
              <a href={nextHref} className="btn-primary">
                {nextLabel}
              </a>
              {!isEdit && (
                <a
                  href={`/admin/nbfc/${done.id}/edit`}
                  className="btn-ghost"
                >
                  Edit details
                </a>
              )}
              {isEdit ? (
                <a
                  href={`/admin/nbfc/${done.id}/edit`}
                  className="btn-ghost"
                >
                  Back to Master
                </a>
              ) : (
                <a href="/admin/nbfc" className="btn-ghost">
                  Back to directory
                </a>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const initialMap = (initial ?? {}) as Record<string, string | undefined>;

  return (
    <form
      ref={formRef}
      onSubmit={onFormSubmit}
      onChange={persistDraft}
      className="space-y-8"
    >
      {/* Lock the entire form when read-only. Three layers of defense:
            1. `inert` blocks focus + keyboard + mouse on every descendant
               (React 19's native prop — works without per-input changes).
            2. `<fieldset disabled>` propagates `disabled` to every form
               control for browsers that don't yet honor `inert` fully.
            3. `opacity-60` + `cursor-not-allowed` give a clear visual
               signal that nothing here is editable.
          When unlocked, the wrapper is invisible (`display: contents`)
          so layout is identical to before. */}
      <fieldset
        disabled={locked}
        inert={locked || undefined}
        className={
          locked
            ? "block opacity-60 cursor-not-allowed select-none border-0 p-0 m-0 space-y-8"
            : "contents"
        }
      >
      {restored && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-xl px-4 py-3 border"
          style={{
            background: "var(--brand-sky-soft)",
            borderColor: "rgba(15, 118, 178, 0.25)",
            color: "var(--color-brand-navy)",
          }}
        >
          <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold">Restored your in-progress draft</p>
            <p className="opacity-80">
              We brought back the values you'd typed before refreshing. Submit
              or Save Draft when you're ready.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              clearPersistedDraft();
              formRef.current?.reset();
              setRestored(false);
            }}
            className="ml-auto text-xs font-semibold underline"
          >
            Clear
          </button>
        </div>
      )}
      <Section
        eyebrow="Identity"
        title="RBI registration & legal entity"
        helper="The legal-name and registration numbers are validated by RBI's E-004 format rules."
      >
        <Field label="Legal name" hint="As registered with RBI" full error={fieldErrors.legalName}>
          <input
            name="legalName"
            placeholder="e.g. Bajaj Finance Limited"
            defaultValue={initialMap.legalName ?? ""}
            required
            aria-invalid={fieldErrors.legalName ? true : undefined}
            onInput={clearFieldErrorOnChange("legalName")}
            className={`input-itarang ${inputErrorClass("legalName")}`}
          />
        </Field>
        <Field label="Short name" hint="Appears in dealer dropdown" error={fieldErrors.shortName}>
          <input
            name="shortName"
            placeholder="e.g. Bajaj Finance"
            defaultValue={initialMap.shortName ?? ""}
            required
            aria-invalid={fieldErrors.shortName ? true : undefined}
            onInput={clearFieldErrorOnChange("shortName")}
            className={`input-itarang ${inputErrorClass("shortName")}`}
          />
        </Field>
        <Field label="NBFC type" error={fieldErrors.nbfcType}>
          <select
            name="nbfcType"
            required
            defaultValue={initialMap.nbfcType ?? "nbfc_icc"}
            aria-invalid={fieldErrors.nbfcType ? true : undefined}
            onChange={clearFieldErrorOnChange("nbfcType")}
            className={`input-itarang ${inputErrorClass("nbfcType")}`}
          >
            {NBFC_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="RBI registration no."
          hint={RBI_REG_HINT}
          mono
          error={rbiTouched ? rbiError : null}
        >
          <input
            name="rbiRegistrationNo"
            placeholder="N-13.00243.00.00.0000.00000.00"
            defaultValue={initialMap.rbiRegistrationNo ?? ""}
            required
            pattern={RBI_REG_PATTERN}
            title={`RBI CoR format: ${RBI_REG_HINT}`}
            aria-invalid={rbiTouched && rbiError ? true : undefined}
            onBlur={(e) => {
              setRbiTouched(true);
              setFieldError("rbiRegistrationNo", validateRbi(e.currentTarget.value));
            }}
            onChange={(e) => {
              if (rbiTouched)
                setFieldError("rbiRegistrationNo", validateRbi(e.currentTarget.value));
            }}
            className={`input-itarang font-mono text-[13px] ${
              rbiTouched && rbiError
                ? "border-[color:var(--color-danger)] ring-1 ring-[color:var(--color-danger)]"
                : ""
            }`}
          />
        </Field>
        <Field label="CIN" hint="21 chars" mono error={fieldErrors.cin}>
          <input
            name="cin"
            placeholder="L65910MH1987PLC042961"
            defaultValue={initialMap.cin ?? ""}
            required
            pattern="[A-Z0-9]{21}"
            title="21-character alphanumeric CIN (uppercase)"
            maxLength={25}
            aria-invalid={fieldErrors.cin ? true : undefined}
            onInput={(e) => {
              upperCaseInPlace(e.currentTarget);
              if (fieldErrors.cin) setFieldError("cin", null);
            }}
            className={`input-itarang font-mono text-[13px] uppercase ${inputErrorClass("cin")}`}
          />
        </Field>
        <Field label="GSTIN" hint="15 chars" mono error={fieldErrors.gstNumber}>
          <input
            name="gstNumber"
            placeholder="27AABCB1518L1ZS"
            defaultValue={initialMap.gstNumber ?? ""}
            required
            pattern="\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}Z[A-Z\d]{1}"
            title="GSTIN format: 2 digits + 5 letters + 4 digits + letter + alphanumeric + Z + alphanumeric"
            maxLength={15}
            aria-invalid={fieldErrors.gstNumber ? true : undefined}
            onInput={(e) => {
              upperCaseInPlace(e.currentTarget);
              if (fieldErrors.gstNumber) setFieldError("gstNumber", null);
            }}
            className={`input-itarang font-mono text-[13px] uppercase ${inputErrorClass("gstNumber")}`}
          />
        </Field>
        <Field label="PAN" hint="10 chars" mono error={fieldErrors.panNumber}>
          <input
            name="panNumber"
            placeholder="AABCB1518L"
            defaultValue={initialMap.panNumber ?? ""}
            required
            pattern="[A-Z]{5}\d{4}[A-Z]"
            title="PAN format: 5 letters + 4 digits + 1 letter (uppercase)"
            maxLength={10}
            aria-invalid={fieldErrors.panNumber ? true : undefined}
            onInput={(e) => {
              upperCaseInPlace(e.currentTarget);
              if (fieldErrors.panNumber) setFieldError("panNumber", null);
            }}
            className={`input-itarang font-mono text-[13px] uppercase ${inputErrorClass("panNumber")}`}
          />
        </Field>
      </Section>

      <Section
        eyebrow="Registered Address"
        title="As declared on the Certificate of Registration"
      >
        <Field label="Address line 1" full error={fieldErrors.addr_line1}>
          <input
            name="addr_line1"
            defaultValue={initialMap.addr_line1 ?? ""}
            required
            aria-invalid={fieldErrors.addr_line1 ? true : undefined}
            onInput={clearFieldErrorOnChange("addr_line1")}
            className={`input-itarang ${inputErrorClass("addr_line1")}`}
          />
        </Field>
        <Field label="Address line 2" full error={fieldErrors.addr_line2}>
          <input
            name="addr_line2"
            defaultValue={initialMap.addr_line2 ?? ""}
            aria-invalid={fieldErrors.addr_line2 ? true : undefined}
            onInput={clearFieldErrorOnChange("addr_line2")}
            className={`input-itarang ${inputErrorClass("addr_line2")}`}
          />
        </Field>
        <Field label="City" error={fieldErrors.addr_city}>
          <input
            name="addr_city"
            defaultValue={initialMap.addr_city ?? ""}
            required
            pattern={ALPHA_NAME_PATTERN}
            title="Letters only"
            aria-invalid={fieldErrors.addr_city ? true : undefined}
            onInput={(e) => {
              e.currentTarget.value = stripToAlpha(e.currentTarget.value);
              if (fieldErrors.addr_city) setFieldError("addr_city", null);
            }}
            className={`input-itarang ${inputErrorClass("addr_city")}`}
          />
        </Field>
        <Field label="District" error={fieldErrors.addr_district}>
          <input
            name="addr_district"
            defaultValue={initialMap.addr_district ?? ""}
            required
            pattern={ALPHA_NAME_PATTERN}
            title="Letters only"
            aria-invalid={fieldErrors.addr_district ? true : undefined}
            onInput={(e) => {
              e.currentTarget.value = stripToAlpha(e.currentTarget.value);
              if (fieldErrors.addr_district) setFieldError("addr_district", null);
            }}
            className={`input-itarang ${inputErrorClass("addr_district")}`}
          />
        </Field>
        <Field label="State" error={fieldErrors.addr_state}>
          <input
            name="addr_state"
            defaultValue={initialMap.addr_state ?? ""}
            required
            pattern={ALPHA_NAME_PATTERN}
            title="Letters only"
            aria-invalid={fieldErrors.addr_state ? true : undefined}
            onInput={(e) => {
              e.currentTarget.value = stripToAlpha(e.currentTarget.value);
              if (fieldErrors.addr_state) setFieldError("addr_state", null);
            }}
            className={`input-itarang ${inputErrorClass("addr_state")}`}
          />
        </Field>
        <Field label="PIN code" hint="6 digits" error={fieldErrors.addr_pin}>
          <input
            name="addr_pin"
            defaultValue={initialMap.addr_pin ?? ""}
            required
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            aria-invalid={fieldErrors.addr_pin ? true : undefined}
            onInput={clearFieldErrorOnChange("addr_pin")}
            className={`input-itarang font-mono ${inputErrorClass("addr_pin")}`}
          />
        </Field>
      </Section>

      <Section
        eyebrow="Primary Contacts"
        title="Day-to-day point of contact for partnership operations"
      >
        <Field label="Contact name" error={fieldErrors.primaryContactName}>
          <input
            name="primaryContactName"
            defaultValue={initialMap.primaryContactName ?? ""}
            required
            pattern={ALPHA_NAME_PATTERN}
            title="Letters only"
            aria-invalid={fieldErrors.primaryContactName ? true : undefined}
            onInput={(e) => {
              e.currentTarget.value = stripToAlpha(e.currentTarget.value);
              if (fieldErrors.primaryContactName)
                setFieldError("primaryContactName", null);
            }}
            className={`input-itarang ${inputErrorClass("primaryContactName")}`}
          />
        </Field>
        <Field label="Contact email" error={fieldErrors.primaryContactEmail}>
          <input
            name="primaryContactEmail"
            type="email"
            defaultValue={initialMap.primaryContactEmail ?? ""}
            required
            aria-invalid={fieldErrors.primaryContactEmail ? true : undefined}
            onInput={clearFieldErrorOnChange("primaryContactEmail")}
            className={`input-itarang ${inputErrorClass("primaryContactEmail")}`}
          />
        </Field>
        <Field label="Contact phone" hint="10 digits" error={fieldErrors.primaryContactPhone}>
          <input
            name="primaryContactPhone"
            defaultValue={initialMap.primaryContactPhone ?? ""}
            required
            inputMode="tel"
            pattern="\d{10}"
            maxLength={10}
            aria-invalid={fieldErrors.primaryContactPhone ? true : undefined}
            onInput={clearFieldErrorOnChange("primaryContactPhone")}
            className={`input-itarang font-mono ${inputErrorClass("primaryContactPhone")}`}
          />
        </Field>
      </Section>

      <Section
        eyebrow="Grievance & Nodal"
        title="RBI Digital Lending Directions 2025 — mandatory"
        helper="Officer name, helpline, and grievance URL are required for every NBFC."
      >
        <Field label="Grievance officer" error={fieldErrors.grievanceOfficerName}>
          <input
            name="grievanceOfficerName"
            defaultValue={initialMap.grievanceOfficerName ?? ""}
            required
            pattern={ALPHA_NAME_PATTERN}
            title="Letters only"
            aria-invalid={fieldErrors.grievanceOfficerName ? true : undefined}
            onInput={(e) => {
              e.currentTarget.value = stripToAlpha(e.currentTarget.value);
              if (fieldErrors.grievanceOfficerName)
                setFieldError("grievanceOfficerName", null);
            }}
            className={`input-itarang ${inputErrorClass("grievanceOfficerName")}`}
          />
        </Field>
        <Field label="Grievance helpline" error={fieldErrors.grievanceHelpline}>
          <input
            name="grievanceHelpline"
            defaultValue={initialMap.grievanceHelpline ?? ""}
            required
            aria-invalid={fieldErrors.grievanceHelpline ? true : undefined}
            onInput={clearFieldErrorOnChange("grievanceHelpline")}
            className={`input-itarang ${inputErrorClass("grievanceHelpline")}`}
          />
        </Field>
        <Field label="Grievance URL" error={fieldErrors.grievanceUrl}>
          <input
            name="grievanceUrl"
            type="url"
            defaultValue={initialMap.grievanceUrl ?? ""}
            required
            placeholder="https://example.com/grievance"
            aria-invalid={fieldErrors.grievanceUrl ? true : undefined}
            onInput={clearFieldErrorOnChange("grievanceUrl")}
            className={`input-itarang ${inputErrorClass("grievanceUrl")}`}
          />
        </Field>
        <Field label="Nodal officer (optional)" full error={fieldErrors.nodalOfficer}>
          <input
            name="nodalOfficer"
            defaultValue={initialMap.nodalOfficer ?? ""}
            aria-invalid={fieldErrors.nodalOfficer ? true : undefined}
            onInput={clearFieldErrorOnChange("nodalOfficer")}
            className={`input-itarang ${inputErrorClass("nodalOfficer")}`}
          />
        </Field>
      </Section>

      <Section
        eyebrow="Partnership"
        title="iTarang ↔ NBFC commercial terms"
      >
        <Field label="Partnership date" error={fieldErrors.partnershipDate}>
          <input
            name="partnershipDate"
            type="date"
            defaultValue={initialMap.partnershipDate ?? ""}
            required
            aria-invalid={fieldErrors.partnershipDate ? true : undefined}
            onChange={clearFieldErrorOnChange("partnershipDate")}
            className={`input-itarang ${inputErrorClass("partnershipDate")}`}
          />
        </Field>
        <Field label="Active geographies" hint="Comma-separated state codes" error={fieldErrors.activeGeographies}>
          <input
            name="activeGeographies"
            defaultValue={initialMap.activeGeographies ?? ""}
            placeholder="MH, GJ, RJ, KA, TN"
            required
            pattern="[A-Z]{2}(?:\s*,\s*[A-Z]{2})*"
            title="Comma-separated two-letter state codes (e.g. MH, GJ, RJ)"
            aria-invalid={fieldErrors.activeGeographies ? true : undefined}
            onInput={(e) => {
              e.currentTarget.value = normaliseStateCodes(e.currentTarget.value);
              if (fieldErrors.activeGeographies)
                setFieldError("activeGeographies", null);
            }}
            className={`input-itarang uppercase ${inputErrorClass("activeGeographies")}`}
          />
        </Field>
        <Field label="FLDG / Guarantee terms (optional)" full error={fieldErrors.fldgTerms}>
          <textarea
            name="fldgTerms"
            defaultValue={initialMap.fldgTerms ?? ""}
            placeholder="e.g. 5% FLDG capped at portfolio level, replenished quarterly"
            aria-invalid={fieldErrors.fldgTerms ? true : undefined}
            onInput={clearFieldErrorOnChange("fldgTerms")}
            className={`input-itarang-textarea min-h-[88px] ${inputErrorClass("fldgTerms")}`}
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
          {hasOpenCorrectionRound ? (
            <>
              Next saves your corrections and moves you to the{" "}
              <span className="font-semibold text-[color:var(--color-brand-navy)]">
                Approval
              </span>{" "}
              step to resubmit for CEO review.
            </>
          ) : (
            <>
              Next saves the master details and moves you to{" "}
              <span className="font-semibold text-[color:var(--color-brand-navy)]">
                compliance documents
              </span>
              . You can keep editing master details later from the NBFC directory.
            </>
          )}
        </p>
        {!locked && (
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
              {mode === "create" ? "Next" : "Save changes"}
            </button>
          </div>
        )}
      </div>
      </fieldset>
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
  error,
  children,
}: {
  label: string;
  hint?: string;
  full?: boolean;
  mono?: boolean;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <label className={`flex flex-col gap-1.5 ${full ? "md:col-span-3" : ""}`}>
      <span className="text-xs font-semibold text-[color:var(--color-ink)]">
        {label}
      </span>
      {children}
      {error ? (
        <span
          role="alert"
          className="text-[11px] font-medium"
          style={{ color: "var(--color-danger)" }}
        >
          {error}
        </span>
      ) : (
        hint && (
          <span className="text-[11px] text-[color:var(--color-ink-muted)]">
            {hint}
          </span>
        )
      )}
    </label>
  );
}
