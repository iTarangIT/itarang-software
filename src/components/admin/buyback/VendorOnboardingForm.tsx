"use client";

/**
 * Admin scrap-vendor onboarding (E-222).
 *
 * Replaces the seven-field "+ Add vendor" modal on /admin/buyback/vendors. What
 * it adds is not just more boxes: a registered address, the three statutory
 * documents the desk needs on file before it can invoice anyone, an optional
 * manually signed agreement, and — the part with no UI at all — a portal login.
 * There is deliberately NO password field. iTarang mints the password and emails
 * it, the same way NBFC activation does, so an admin never handles, chooses or
 * has to communicate someone else's credentials.
 *
 * Follows NbfcMasterDetailsForm for structure and BRD §6.B for style: the local
 * Section/Field primitives at the bottom of this file, `card-iTarang` sections,
 * `input-itarang` controls, GSTIN/PAN/Udyam uppercased in place as you type.
 * What it does NOT copy is that form's localStorage draft restore — File
 * objects cannot be serialized, so a restored draft would come back with three
 * empty upload slots and a submit button that refuses to explain itself.
 *
 * THE ENDING IS TWO OUTCOMES, NOT ONE. Creating the vendor and delivering their
 * password are separate things that fail separately, so the result card says
 * which happened. A bounced email leaves a real vendor who is not routable, and
 * the admin gets the mail server's own sentence plus a retry — not a green tick.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

import VendorDocUpload, { type VendorDocValue } from "./VendorDocUpload";
import { CHEMISTRIES } from "@/lib/buyback/line-spec";
import { VENDOR_DOC_LABELS } from "@/lib/buyback/vendor-docs";

/** Server zod paths → the label on this form, so an error names a box. */
const FIELD_LABELS: Record<string, string> = {
  name: "Business name",
  contact_name: "Contact person",
  gstin: "GSTIN",
  pan: "PAN",
  udyam_number: "Udyam number",
  contact_email: "Contact email",
  contact_phone: "Phone",
  address_line1: "Address line 1",
  address_line2: "Address line 2",
  city: "City",
  state: "State",
  pincode: "Pincode",
  payment_terms: "Payment terms",
  credit_limit: "Credit limit",
  agreement_ref: "Agreement reference",
  agreement_signed_on: "Agreement signed on",
};

const GSTIN_PATTERN = "[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[A-Z0-9]{1}Z[A-Z0-9]{1}";
const PAN_PATTERN = "[A-Z]{5}[0-9]{4}[A-Z]{1}";

const EMPTY = {
  name: "",
  contact_name: "",
  gstin: "",
  pan: "",
  udyam_number: "",
  contact_email: "",
  contact_phone: "",
  address_line1: "",
  address_line2: "",
  city: "",
  state: "",
  pincode: "",
  payment_terms: "",
  credit_limit: "",
  agreement_ref: "",
  agreement_signed_on: "",
};

type FormState = typeof EMPTY;

interface CreatedVendor {
  entity_id: string;
  name: string;
  status: "ACTIVE" | "PENDING";
  credential: { dispatched: boolean; dispatchedTo: string; error?: string };
}

/**
 * Uppercase without losing the caret. Setting `value` on a controlled input
 * normally jumps the cursor to the end, which makes correcting the fourth
 * character of a GSTIN infuriating.
 */
function upperCaseInPlace(e: React.ChangeEvent<HTMLInputElement>): string {
  const el = e.target;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  const next = el.value.toUpperCase();
  if (next !== el.value) {
    el.value = next;
    if (start !== null && end !== null) el.setSelectionRange(start, end);
  }
  return next;
}

export default function VendorOnboardingForm() {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [categories, setCategories] = useState<string[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  const [docs, setDocs] = useState<Record<string, VendorDocValue | null>>({
    GSTIN: null,
    PAN: null,
    UDYAM: null,
    AGREEMENT: null,
  });

  const [stateOptions, setStateOptions] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedVendor | null>(null);
  const [retrying, setRetrying] = useState(false);

  const formRef = useRef<HTMLFormElement>(null);

  // The canonical state list (E-108 reference tables). Free-text state names
  // are how "Maharastra" and "MAHARASHTRA" end up as two regions that never
  // match a routing filter. Falls back to a plain text input if the reference
  // data is unreachable — an unavailable dropdown must not block onboarding.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const json = await fetch("/api/locations/regions")
        .then((r) => r.json())
        .catch(() => null);
      if (cancelled) return;
      const names = (json?.data?.states ?? []).map((s: { name: string }) => s.name);
      setStateOptions(names);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const setUpper = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = upperCaseInPlace(e);
    setForm((f) => ({ ...f, [k]: next }));
  };

  const toggle = (list: string[], value: string) =>
    list.includes(value) ? list.filter((x) => x !== value) : [...list, value];

  const requiredDocsAttached = Boolean(docs.GSTIN && docs.PAN && docs.UDYAM);

  const submit = async () => {
    setError(null);

    // Let the browser's own constraint validation speak first — but report ALL
    // of it, not just the first field. Native reportValidity() stops at one,
    // which turns a six-mistake form into six round trips.
    const el = formRef.current;
    if (el && !el.checkValidity()) {
      const invalid = Array.from(
        el.querySelectorAll<HTMLInputElement>(":invalid"),
      ).filter((i) => i.name);
      const names = invalid.map((i) => FIELD_LABELS[i.name] ?? i.name);
      setError(
        names.length === 1
          ? `${names[0]} is missing or not in the expected format.`
          : `Check these fields: ${names.join(", ")}.`,
      );
      invalid[0]?.focus();
      invalid[0]?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    if (!requiredDocsAttached) {
      setError(
        "The GST certificate, PAN card and Udyam certificate are all required before a vendor can be created.",
      );
      return;
    }

    setSubmitting(true);

    const res = await fetch("/api/admin/buyback/vendors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.name.trim(),
        contact_name: form.contact_name.trim(),
        gstin: form.gstin.trim().toUpperCase(),
        pan: form.pan.trim().toUpperCase(),
        udyam_number: form.udyam_number.trim() || undefined,
        contact_email: form.contact_email.trim(),
        contact_phone: form.contact_phone.trim() || undefined,
        address_line1: form.address_line1.trim(),
        address_line2: form.address_line2.trim() || undefined,
        city: form.city.trim(),
        state: form.state.trim(),
        pincode: form.pincode.trim(),
        categories,
        regions,
        payment_terms: form.payment_terms.trim() || undefined,
        credit_limit: form.credit_limit.trim() ? Number(form.credit_limit) : undefined,
        agreement_ref: form.agreement_ref.trim() || undefined,
        agreement_signed_on: form.agreement_signed_on || undefined,
        document_ids: {
          GSTIN: docs.GSTIN!.documentId,
          PAN: docs.PAN!.documentId,
          UDYAM: docs.UDYAM!.documentId,
          AGREEMENT: docs.AGREEMENT?.documentId,
        },
      }),
    }).catch(() => null);

    const json = await res?.json().catch(() => null);
    setSubmitting(false);

    if (!json?.success) {
      // Zod refusals arrive per-field in `details` as { path, message }. The
      // message alone ("Too small: expected string to have >=2 characters") is
      // useless without the field.
      const issue = json?.error?.details?.[0] as { path?: string; message?: string } | undefined;
      const label = issue?.path ? (FIELD_LABELS[issue.path] ?? issue.path) : null;
      setError(
        (issue?.message && (label ? `${label}: ${issue.message}` : issue.message)) ??
          json?.error?.message ??
          "The vendor could not be created.",
      );
      return;
    }

    setCreated(json.data as CreatedVendor);
  };

  const retry = async () => {
    if (!created) return;
    setRetrying(true);

    const res = await fetch(
      `/api/admin/buyback/vendors/${encodeURIComponent(created.entity_id)}/credentials`,
      { method: "POST" },
    ).catch(() => null);

    const json = await res?.json().catch(() => null);
    setRetrying(false);

    if (!json?.success) {
      setCreated({
        ...created,
        credential: {
          ...created.credential,
          error: json?.error?.message ?? "The credentials could not be sent.",
        },
      });
      return;
    }

    setCreated({ ...created, status: json.data.status, credential: json.data.credential });
  };

  /* ------------------------------------------------------------------ */
  /*  Result                                                             */
  /* ------------------------------------------------------------------ */

  if (created) {
    const ok = created.credential.dispatched;
    return (
      <section className="card-iTarang p-6 md:p-7 space-y-5">
        <header className="space-y-1">
          <p className="section-label">{ok ? "Vendor onboarded" : "Vendor created"}</p>
          <h2 className="text-lg font-semibold text-[color:var(--color-brand-navy)]">
            {created.name}
          </h2>
        </header>

        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-[11px] font-semibold text-[color:var(--color-ink-muted)]">
              Vendor code
            </dt>
            <dd className="mt-0.5 font-mono text-sm text-[color:var(--color-ink)]">
              {created.entity_id}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] font-semibold text-[color:var(--color-ink-muted)]">
              Status
            </dt>
            <dd className="mt-0.5">
              <span className={ok ? "status-pill-success" : "status-pill-warning"}>
                {created.status}
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-[11px] font-semibold text-[color:var(--color-ink-muted)]">
              Credentials
            </dt>
            <dd className="mt-0.5 text-sm text-[color:var(--color-ink)]">
              {ok ? `Emailed to ${created.credential.dispatchedTo}` : "Not delivered"}
            </dd>
          </div>
        </dl>

        {ok ? (
          <p className="text-xs text-[color:var(--color-ink-muted)]">
            They can sign in now and will be asked to change the password on first login. They
            are also selectable when routing a deal.
          </p>
        ) : (
          <div
            className="rounded-lg border p-4 text-xs"
            style={{
              borderColor: "var(--color-warning)",
              backgroundColor: "var(--color-warning-bg)",
              color: "var(--color-warning)",
            }}
          >
            <p className="font-semibold">
              The vendor and their documents are saved, but their login email did not go out — so
              they stay Pending and cannot be routed a deal yet.
            </p>
            {created.credential.error && (
              <p className="mt-1.5 font-mono">{created.credential.error}</p>
            )}
            <button
              type="button"
              onClick={() => void retry()}
              disabled={retrying}
              className="btn-primary mt-3 disabled:opacity-60"
            >
              {retrying ? "Sending…" : "↻ Retry credentials"}
            </button>
          </div>
        )}

        <div className="flex items-center gap-3 pt-1">
          <Link href="/admin/buyback/vendors" className="btn-primary">
            Back to Vendors
          </Link>
          <button
            type="button"
            onClick={() => {
              setCreated(null);
              setForm(EMPTY);
              setCategories([]);
              setRegions([]);
              setDocs({ GSTIN: null, PAN: null, UDYAM: null, AGREEMENT: null });
            }}
            className="btn-ghost"
          >
            Onboard another
          </button>
        </div>
      </section>
    );
  }

  /* ------------------------------------------------------------------ */
  /*  Form                                                               */
  /* ------------------------------------------------------------------ */

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="space-y-6"
    >
      <Section
        eyebrow="Business"
        title="Who they are"
        helper="The contact email is their login ID. iTarang generates the password and emails it — you never have to set or share one."
      >
        <Field label="Business name *">
          <input
            name="name"
            required
            minLength={2}
            value={form.name}
            onChange={set("name")}
            placeholder="AmpFusion Recyclers Pvt Ltd"
            className="input-itarang"
          />
        </Field>
        <Field label="Contact person *">
          <input
            name="contact_name"
            required
            minLength={2}
            value={form.contact_name}
            onChange={set("contact_name")}
            className="input-itarang"
          />
        </Field>
        <Field label="Contact email *" hint="Their login ID, and where quotations go.">
          <input
            name="contact_email"
            type="email"
            required
            value={form.contact_email}
            onChange={set("contact_email")}
            placeholder="buy@ampfusion.in"
            className="input-itarang"
          />
        </Field>
        <Field label="Phone">
          <input
            name="contact_phone"
            value={form.contact_phone}
            onChange={set("contact_phone")}
            inputMode="tel"
            className="input-itarang"
          />
        </Field>
      </Section>

      <Section
        eyebrow="Statutory identity"
        title="Registration"
        helper="We invoice against the GSTIN, so it has to be right before we can sell to them."
      >
        <Field label="GSTIN *" hint="15 characters, e.g. 27AABCB1518L1ZS">
          <input
            name="gstin"
            required
            maxLength={15}
            pattern={GSTIN_PATTERN}
            value={form.gstin}
            onChange={setUpper("gstin")}
            placeholder="27AABCB1518L1ZS"
            className="input-itarang font-mono uppercase"
          />
        </Field>
        <Field label="PAN *" hint="10 characters, e.g. AABCB1518L">
          <input
            name="pan"
            required
            maxLength={10}
            pattern={PAN_PATTERN}
            value={form.pan}
            onChange={setUpper("pan")}
            placeholder="AABCB1518L"
            className="input-itarang font-mono uppercase"
          />
        </Field>
        <Field label="Udyam number" hint="Optional — the certificate itself is required below.">
          <input
            name="udyam_number"
            maxLength={30}
            value={form.udyam_number}
            onChange={setUpper("udyam_number")}
            placeholder="UDYAM-MH-26-0012345"
            className="input-itarang font-mono uppercase"
          />
        </Field>
      </Section>

      <Section eyebrow="Registered address" title="Where the firm is">
        <Field label="Address line 1 *" full>
          <input
            name="address_line1"
            required
            value={form.address_line1}
            onChange={set("address_line1")}
            className="input-itarang"
          />
        </Field>
        <Field label="Address line 2" full>
          <input
            name="address_line2"
            value={form.address_line2}
            onChange={set("address_line2")}
            className="input-itarang"
          />
        </Field>
        <Field label="City *">
          <input
            name="city"
            required
            value={form.city}
            onChange={set("city")}
            className="input-itarang"
          />
        </Field>
        <Field label="State *">
          {stateOptions.length > 0 ? (
            <select
              name="state"
              required
              value={form.state}
              onChange={(e) => setForm((f) => ({ ...f, state: e.target.value }))}
              className="input-itarang"
            >
              <option value="">Select a state…</option>
              {stateOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          ) : (
            <input
              name="state"
              required
              value={form.state}
              onChange={set("state")}
              className="input-itarang"
            />
          )}
        </Field>
        <Field label="Pincode *">
          <input
            name="pincode"
            required
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            value={form.pincode}
            onChange={(e) =>
              setForm((f) => ({ ...f, pincode: e.target.value.replace(/\D/g, "") }))
            }
            className="input-itarang font-mono"
          />
        </Field>
      </Section>

      <Section
        eyebrow="Documents"
        title="Compliance"
        helper="All three are required. They are stored privately and are what an auditor is shown."
      >
        <VendorDocUpload
          kind="GSTIN"
          label={VENDOR_DOC_LABELS.GSTIN}
          required
          value={docs.GSTIN}
          onChange={(v) => setDocs((d) => ({ ...d, GSTIN: v }))}
        />
        <VendorDocUpload
          kind="PAN"
          label={VENDOR_DOC_LABELS.PAN}
          required
          value={docs.PAN}
          onChange={(v) => setDocs((d) => ({ ...d, PAN: v }))}
        />
        <VendorDocUpload
          kind="UDYAM"
          label={VENDOR_DOC_LABELS.UDYAM}
          required
          value={docs.UDYAM}
          onChange={(v) => setDocs((d) => ({ ...d, UDYAM: v }))}
        />
      </Section>

      <Section
        eyebrow="Agreement"
        title="Signed paperwork (optional)"
        helper="For a vendor agreement signed on paper. eSign via Digio is a separate, later step — leave this empty if there is nothing signed yet."
      >
        <VendorDocUpload
          kind="AGREEMENT"
          label={VENDOR_DOC_LABELS.AGREEMENT}
          value={docs.AGREEMENT}
          onChange={(v) => setDocs((d) => ({ ...d, AGREEMENT: v }))}
        />
        <Field label="Agreement reference">
          <input
            name="agreement_ref"
            value={form.agreement_ref}
            onChange={set("agreement_ref")}
            placeholder="ITG/VND/2026/014"
            className="input-itarang"
          />
        </Field>
        <Field label="Signed on">
          <input
            name="agreement_signed_on"
            type="date"
            value={form.agreement_signed_on}
            onChange={set("agreement_signed_on")}
            className="input-itarang"
          />
        </Field>
      </Section>

      <Section
        eyebrow="Commercials"
        title="What they collect"
        helper="Used to decide which lots to send them. All of it can be changed later."
      >
        <Field label="Chemistry">
          <div className="flex flex-wrap gap-2 pt-1">
            {CHEMISTRIES.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCategories((cs) => toggle(cs, c))}
                aria-pressed={categories.includes(c)}
                className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
                  categories.includes(c)
                    ? "border-transparent bg-[color:var(--color-brand-navy)] text-white"
                    : "border-[color:var(--color-border)] bg-white text-[color:var(--color-ink-muted)] hover:border-[color:var(--color-brand-sky)]"
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </Field>

        <Field
          label="States they collect from"
          full
          hint="Drives which deals they are offered. Leave empty to consider them for any state."
        >
          {stateOptions.length > 0 ? (
            <div className="flex max-h-44 flex-wrap gap-2 overflow-y-auto rounded-lg border border-[color:var(--color-border)] bg-white p-3">
              {stateOptions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setRegions((rs) => toggle(rs, s))}
                  aria-pressed={regions.includes(s)}
                  className={`rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                    regions.includes(s)
                      ? "border-transparent bg-[color:var(--color-brand-sky)] text-white"
                      : "border-[color:var(--color-border)] bg-white text-[color:var(--color-ink-muted)] hover:border-[color:var(--color-brand-sky)]"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          ) : (
            <input
              value={regions.join(", ")}
              onChange={(e) =>
                setRegions(
                  e.target.value
                    .split(",")
                    .map((r) => r.trim())
                    .filter(Boolean),
                )
              }
              placeholder="Maharashtra, Gujarat"
              className="input-itarang"
            />
          )}
        </Field>

        <Field label="Payment terms">
          <input
            name="payment_terms"
            value={form.payment_terms}
            onChange={set("payment_terms")}
            placeholder="Net 15"
            className="input-itarang"
          />
        </Field>
        <Field label="Credit limit (₹)">
          <input
            name="credit_limit"
            inputMode="decimal"
            value={form.credit_limit}
            onChange={(e) =>
              setForm((f) => ({ ...f, credit_limit: e.target.value.replace(/[^\d.]/g, "") }))
            }
            className="input-itarang font-mono"
          />
        </Field>
      </Section>

      {error && (
        <p
          role="alert"
          className="rounded-lg border px-4 py-3 text-xs font-semibold"
          style={{
            borderColor: "var(--color-danger)",
            backgroundColor: "var(--color-danger-bg)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={submitting} className="btn-primary disabled:opacity-60">
          {submitting ? "Creating vendor…" : "Create vendor & email login"}
        </button>
        <Link href="/admin/buyback/vendors" className="btn-ghost">
          Cancel
        </Link>
        {!requiredDocsAttached && (
          <span className="text-[11px] text-[color:var(--color-ink-muted)]">
            All three compliance documents must be attached.
          </span>
        )}
      </div>
    </form>
  );
}

/* -----------------------------------------------------------------------
 *  Layout primitives — local to this form so the section/field rhythm
 *  matches BRD §6.B, mirroring NbfcMasterDetailsForm.
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
        <h2 className="text-lg font-semibold text-[color:var(--color-brand-navy)]">{title}</h2>
        {helper && <p className="text-xs text-[color:var(--color-ink-muted)]">{helper}</p>}
      </header>
      <div className="grid grid-cols-1 gap-5 md:grid-cols-3">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  full,
  children,
}: {
  label: string;
  hint?: string;
  full?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`flex flex-col gap-1.5 ${full ? "md:col-span-3" : ""}`}>
      <span className="text-xs font-semibold text-[color:var(--color-ink)]">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-[color:var(--color-ink-muted)]">{hint}</span>}
    </label>
  );
}
