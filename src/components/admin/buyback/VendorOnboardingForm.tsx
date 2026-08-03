"use client";

/**
 * Admin scrap-vendor onboarding (E-223).
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
 * VALIDATION IS PER FIELD, AND IT IS OURS. The browser's own bubbles say
 * "Please match the requested format", one at a time; the server's zod says
 * "Too small: expected string to have >=2 characters". Neither names the box or
 * the fix. So every rule the route enforces is mirrored into VALIDATORS below —
 * checked on blur, re-checked on each keystroke once a field has gone red, and
 * re-run across the whole form on submit. A failure is a red border, a red
 * tint, and the sentence directly under that control; the first offender is
 * scrolled to and focused. Server refusals are mapped back onto the same
 * fields, so a rejected GSTIN reddens the GSTIN box instead of only appearing
 * in a banner at the bottom of a long form.
 *
 * WHAT THEY COLLECT IS NOT ASKED HERE. Chemistry, collection states, payment
 * terms and credit limit were a "Commercials" section on this form; they are
 * routing preferences, not onboarding facts, and every one of them is editable
 * on the vendor record afterwards. Onboarding is now identity + address +
 * paperwork. The route still accepts all four and defaults them to empty.
 *
 * THE ENDING IS TWO OUTCOMES, NOT ONE. Creating the vendor and delivering their
 * password are separate things that fail separately, so the result card says
 * which happened. A bounced email leaves a real vendor who is not routable, and
 * the admin gets the mail server's own sentence plus a retry — not a green tick.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

import VendorDocUpload, { type VendorDocValue } from "./VendorDocUpload";
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
  agreement_ref: "Agreement reference",
  agreement_signed_on: "Agreement signed on",
};

// Deliberately the same expressions the route parses with, not looser ones — a
// field that goes green here and red on the server is worse than no check.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;
const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;
const UDYAM_RE = /^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/;
const PINCODE_RE = /^\d{6}$/;

const EMPTY = {
  name: "",
  contact_name: "",
  contact_email: "",
  contact_phone: "",
  gstin: "",
  pan: "",
  udyam_number: "",
  address_line1: "",
  address_line2: "",
  city: "",
  state: "",
  pincode: "",
  agreement_ref: "",
  agreement_signed_on: "",
};

type FormState = typeof EMPTY;
type FieldName = keyof FormState;

const REQUIRED_DOCS = ["GSTIN", "PAN", "UDYAM"] as const;

/** Error keys in the order they appear on screen — drives "first offender". */
const ERROR_ORDER: string[] = [
  "name",
  "contact_name",
  "contact_email",
  "contact_phone",
  "gstin",
  "pan",
  "udyam_number",
  "address_line1",
  "address_line2",
  "city",
  "state",
  "pincode",
  ...REQUIRED_DOCS.map((d) => `doc-${d}`),
  "agreement_ref",
  "agreement_signed_on",
];

/**
 * One rule per field, returning the sentence to print under it. Written as
 * instructions ("Enter the GSTIN — we invoice against it") rather than
 * diagnoses ("invalid format"), because the person filling this in is an admin
 * copying off a certificate, not the author of the schema.
 */
const VALIDATORS: Record<FieldName, (raw: string) => string | null> = {
  name: (v) => {
    const s = v.trim();
    if (!s) return "Enter the registered business name.";
    if (s.length < 2) return "That is too short to be a business name.";
    if (s.length > 200) return "Keep the business name under 200 characters.";
    return null;
  },
  contact_name: (v) => {
    const s = v.trim();
    if (!s) return "Enter the person we will be dealing with.";
    if (s.length < 2) return "Enter their full name.";
    if (s.length > 120) return "Keep the name under 120 characters.";
    return null;
  },
  contact_email: (v) => {
    const s = v.trim();
    if (!s) return "Enter their email — it is the login ID we send the password to.";
    if (!EMAIL_RE.test(s)) return "That does not look like an email address.";
    if (s.length > 255) return "That email is too long.";
    return null;
  },
  contact_phone: (v) => {
    const s = v.trim();
    if (!s) return null; // Optional.
    if (s.replace(/\D/g, "").length < 8) return "A phone number needs at least 8 digits.";
    if (s.length > 20) return "That is too long for a phone number.";
    return null;
  },
  gstin: (v) => {
    const s = v.trim().toUpperCase();
    if (!s) return "Enter the GSTIN — we invoice against it.";
    if (s.length !== 15) return `A GSTIN is 15 characters; this one has ${s.length}.`;
    if (!GSTIN_RE.test(s)) return "That is not a valid GSTIN. It should look like 27AABCB1518L1ZS.";
    return null;
  },
  pan: (v) => {
    const s = v.trim().toUpperCase();
    if (!s) return "Enter the PAN exactly as printed on the card.";
    if (s.length !== 10) return `A PAN is 10 characters; this one has ${s.length}.`;
    if (!PAN_RE.test(s)) return "That is not a valid PAN. It should look like AABCB1518L.";
    return null;
  },
  udyam_number: (v) => {
    const s = v.trim().toUpperCase();
    if (!s) return null; // Optional — the certificate itself is what we require.
    if (!UDYAM_RE.test(s))
      return "A Udyam number looks like UDYAM-MH-26-0012345. Leave it blank if you do not have it to hand.";
    return null;
  },
  address_line1: (v) => {
    const s = v.trim();
    if (!s) return "Enter the registered address.";
    if (s.length > 255) return "Split this across the two address lines.";
    return null;
  },
  address_line2: (v) =>
    v.trim().length > 255 ? "Keep this line under 255 characters." : null,
  city: (v) => {
    const s = v.trim();
    if (!s) return "Enter the city.";
    if (s.length > 120) return "Keep the city under 120 characters.";
    return null;
  },
  state: (v) => (v.trim() ? null : "Select the state the firm is registered in."),
  pincode: (v) => {
    const s = v.trim();
    if (!s) return "Enter the 6-digit pincode.";
    if (!PINCODE_RE.test(s)) return `A pincode is exactly 6 digits; this one has ${s.length}.`;
    return null;
  },
  agreement_ref: (v) =>
    v.trim().length > 120 ? "Keep the reference under 120 characters." : null,
  agreement_signed_on: (v) => {
    if (!v) return null; // Optional.
    const d = new Date(`${v}T00:00:00`);
    if (Number.isNaN(d.getTime())) return "That is not a valid date.";
    if (d.getTime() > Date.now()) return "An agreement cannot have been signed in the future.";
    return null;
  },
};

/** Red border + tint that survives focus, so a bad field stays bad-looking. */
const INVALID_CLS =
  "border-[color:var(--color-danger)] bg-[color:var(--color-danger-bg)] " +
  "focus:border-[color:var(--color-danger)] focus:ring-[color:var(--color-danger)]/20";

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
  const [docs, setDocs] = useState<Record<string, VendorDocValue | null>>({
    GSTIN: null,
    PAN: null,
    UDYAM: null,
    AGREEMENT: null,
  });

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
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

  /* ------------------------------------------------------------------ */
  /*  Field-level validation                                             */
  /* ------------------------------------------------------------------ */

  const setFieldError = (name: string, msg: string | null) =>
    setFieldErrors((prev) => {
      if (!msg && !prev[name]) return prev;
      const next = { ...prev };
      if (msg) next[name] = msg;
      else delete next[name];
      return next;
    });

  /**
   * Nothing goes red while it is still being typed — a required field would
   * scream at the first keystroke. It goes red on blur, and from then on it
   * re-checks live so the red clears the moment the value becomes valid.
   */
  const change = (k: FieldName) => (value: string) => {
    setForm((f) => ({ ...f, [k]: value }));
    if (fieldErrors[k]) setFieldError(k, VALIDATORS[k](value));
  };

  const blur = (k: FieldName) => () => setFieldError(k, VALIDATORS[k](form[k]));

  /** Base props shared by every text control — name, value, error wiring. */
  const bind = (k: FieldName, extraCls = "") => ({
    name: k,
    value: form[k],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      change(k)(e.target.value),
    onBlur: blur(k),
    "aria-invalid": fieldErrors[k] ? (true as const) : undefined,
    "aria-describedby": `${k}-msg`,
    className: `input-itarang ${extraCls} ${fieldErrors[k] ? INVALID_CLS : ""}`.trim(),
  });

  const attachDoc = (kind: string) => (v: VendorDocValue) => {
    setDocs((d) => ({ ...d, [kind]: v }));
    setFieldError(`doc-${kind}`, null);
  };

  function focusFirstError(errors: Record<string, string>) {
    const first = ERROR_ORDER.find((k) => errors[k]);
    if (!first) return;
    const control = formRef.current?.elements.namedItem(first);
    const el = (control instanceof HTMLElement ? control : null) ?? document.getElementById(first);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    // Defer focus so the scroll animation isn't interrupted.
    setTimeout(() => (el as HTMLElement).focus({ preventScroll: true }), 250);
  }

  /** Every rule, every field — what submit runs. */
  function validateAll(): Record<string, string> {
    const errors: Record<string, string> = {};
    for (const k of Object.keys(EMPTY) as FieldName[]) {
      const msg = VALIDATORS[k](form[k]);
      if (msg) errors[k] = msg;
    }
    for (const kind of REQUIRED_DOCS) {
      if (!docs[kind]) errors[`doc-${kind}`] = `Attach the ${VENDOR_DOC_LABELS[kind]}.`;
    }
    return errors;
  }

  const requiredDocsAttached = REQUIRED_DOCS.every((k) => docs[k]);

  const submit = async () => {
    setError(null);

    const errors = validateAll();
    const count = Object.keys(errors).length;
    if (count > 0) {
      setFieldErrors(errors);
      setError(
        count === 1
          ? "One field still needs attention — it is highlighted below."
          : `${count} fields still need attention — they are highlighted below.`,
      );
      focusFirstError(errors);
      return;
    }

    setFieldErrors({});
    setSubmitting(true);

    const res = await fetch("/api/admin/buyback/vendors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.name.trim(),
        contact_name: form.contact_name.trim(),
        gstin: form.gstin.trim().toUpperCase(),
        pan: form.pan.trim().toUpperCase(),
        udyam_number: form.udyam_number.trim().toUpperCase() || undefined,
        contact_email: form.contact_email.trim(),
        contact_phone: form.contact_phone.trim() || undefined,
        address_line1: form.address_line1.trim(),
        address_line2: form.address_line2.trim() || undefined,
        city: form.city.trim(),
        state: form.state.trim(),
        pincode: form.pincode.trim(),
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
      // Zod refusals arrive per-field in `details` as { path, message }. Push
      // every one of them back onto its own box — a banner saying "Too small:
      // expected string to have >=2 characters" at the bottom of a form this
      // long is a scavenger hunt.
      const details = (json?.error?.details ?? []) as Array<{ path?: string; message?: string }>;
      const mapped: Record<string, string> = {};
      for (const d of details) {
        if (d.path && d.path in EMPTY && d.message) mapped[d.path] = d.message;
      }

      const message: string =
        json?.error?.message ??
        details[0]?.message ??
        "The vendor could not be created.";

      // A duplicate GSTIN is a 409 with no zod detail, but it is still a
      // statement about one specific box.
      if (!Object.keys(mapped).length && /gstin/i.test(message)) mapped.gstin = message;

      setFieldErrors(mapped);
      if (Object.keys(mapped).length) focusFirstError(mapped);

      const label = details[0]?.path ? FIELD_LABELS[details[0].path] : null;
      setError(
        details[0]?.message && label
          ? `${label}: ${details[0].message}`
          : message,
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
              setFieldErrors({});
              setError(null);
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
        <Field name="name" label="Business name" required error={fieldErrors.name}>
          <input {...bind("name")} maxLength={200} placeholder="AmpFusion Recyclers Pvt Ltd" />
        </Field>
        <Field name="contact_name" label="Contact person" required error={fieldErrors.contact_name}>
          <input {...bind("contact_name")} maxLength={120} />
        </Field>
        <Field
          name="contact_email"
          label="Contact email"
          required
          hint="Their login ID, and where quotations go."
          error={fieldErrors.contact_email}
        >
          <input
            {...bind("contact_email")}
            type="email"
            maxLength={255}
            placeholder="buy@ampfusion.in"
          />
        </Field>
        <Field name="contact_phone" label="Phone" error={fieldErrors.contact_phone}>
          <input {...bind("contact_phone")} inputMode="tel" maxLength={20} />
        </Field>
      </Section>

      <Section
        eyebrow="Statutory identity"
        title="Registration"
        helper="We invoice against the GSTIN, so it has to be right before we can sell to them."
      >
        <Field
          name="gstin"
          label="GSTIN"
          required
          hint="15 characters, e.g. 27AABCB1518L1ZS"
          error={fieldErrors.gstin}
        >
          <input
            {...bind("gstin", "font-mono uppercase")}
            maxLength={15}
            placeholder="27AABCB1518L1ZS"
            onChange={(e) => change("gstin")(upperCaseInPlace(e))}
          />
        </Field>
        <Field
          name="pan"
          label="PAN"
          required
          hint="10 characters, e.g. AABCB1518L"
          error={fieldErrors.pan}
        >
          <input
            {...bind("pan", "font-mono uppercase")}
            maxLength={10}
            placeholder="AABCB1518L"
            onChange={(e) => change("pan")(upperCaseInPlace(e))}
          />
        </Field>
        <Field
          name="udyam_number"
          label="Udyam number"
          hint="Optional — the certificate itself is required below."
          error={fieldErrors.udyam_number}
        >
          <input
            {...bind("udyam_number", "font-mono uppercase")}
            maxLength={30}
            placeholder="UDYAM-MH-26-0012345"
            onChange={(e) => change("udyam_number")(upperCaseInPlace(e))}
          />
        </Field>
      </Section>

      <Section eyebrow="Registered address" title="Where the firm is">
        <Field
          name="address_line1"
          label="Address line 1"
          required
          full
          error={fieldErrors.address_line1}
        >
          <input {...bind("address_line1")} maxLength={255} />
        </Field>
        <Field name="address_line2" label="Address line 2" full error={fieldErrors.address_line2}>
          <input {...bind("address_line2")} maxLength={255} />
        </Field>
        <Field name="city" label="City" required error={fieldErrors.city}>
          <input {...bind("city")} maxLength={120} />
        </Field>
        <Field name="state" label="State" required error={fieldErrors.state}>
          {stateOptions.length > 0 ? (
            <select {...bind("state")}>
              <option value="">Select a state…</option>
              {stateOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          ) : (
            <input {...bind("state")} maxLength={120} />
          )}
        </Field>
        <Field name="pincode" label="Pincode" required error={fieldErrors.pincode}>
          <input
            {...bind("pincode", "font-mono")}
            inputMode="numeric"
            maxLength={6}
            onChange={(e) => change("pincode")(e.target.value.replace(/\D/g, ""))}
          />
        </Field>
      </Section>

      <Section
        eyebrow="Documents"
        title="Compliance"
        helper="All three are required. They are stored privately and are what an auditor is shown."
      >
        {REQUIRED_DOCS.map((kind) => (
          <VendorDocUpload
            key={kind}
            kind={kind}
            label={VENDOR_DOC_LABELS[kind]}
            required
            value={docs[kind]}
            error={fieldErrors[`doc-${kind}`]}
            onChange={attachDoc(kind)}
          />
        ))}
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
          onChange={attachDoc("AGREEMENT")}
        />
        <Field name="agreement_ref" label="Agreement reference" error={fieldErrors.agreement_ref}>
          <input {...bind("agreement_ref")} maxLength={120} placeholder="ITG/VND/2026/014" />
        </Field>
        <Field
          name="agreement_signed_on"
          label="Signed on"
          error={fieldErrors.agreement_signed_on}
        >
          <input {...bind("agreement_signed_on")} type="date" />
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

/**
 * The error replaces the hint rather than stacking under it — two lines of
 * small print, one grey and one red, is where people stop reading. The id is
 * what the control's aria-describedby points at, so a screen reader announces
 * the failure with the field instead of leaving it as decoration.
 */
function Field({
  name,
  label,
  hint,
  full,
  required,
  error,
  children,
}: {
  name: string;
  label: string;
  hint?: string;
  full?: boolean;
  required?: boolean;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <label className={`flex flex-col gap-1.5 ${full ? "md:col-span-3" : ""}`}>
      <span className="text-xs font-semibold text-[color:var(--color-ink)]">
        {label}
        {required && <span style={{ color: "var(--color-danger)" }}> *</span>}
      </span>
      {children}
      {error ? (
        <span
          id={`${name}-msg`}
          role="alert"
          className="text-[11px] font-medium"
          style={{ color: "var(--color-danger)" }}
        >
          {error}
        </span>
      ) : (
        hint && (
          <span id={`${name}-msg`} className="text-[11px] text-[color:var(--color-ink-muted)]">
            {hint}
          </span>
        )
      )}
    </label>
  );
}
