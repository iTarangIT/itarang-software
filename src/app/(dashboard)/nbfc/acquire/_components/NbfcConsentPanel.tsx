"use client";

import { useCallback, useEffect, useState } from "react";

// Change 7 — DPDP consent surface for the NBFC. View/track the consent status
// per applicant AND re-initiate consent capture (e-sign via Digio, or OTP) for
// the customer or the co-borrower.

interface ConsentRow {
  consent_for: string | null;
  consent_type: string | null;
  consent_status: string | null;
  sign_method: string | null;
  signed_at: string | null;
  signed_consent_url: string | null;
  generated_pdf_url: string | null;
  consent_link_url: string | null;
}

const STATUS_STYLE = (s: string | null): string => {
  const v = (s ?? "").toLowerCase();
  if (v.includes("verified") || v.includes("completed") || v.includes("signed"))
    return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (v.includes("fail") || v.includes("blocked") || v.includes("rejected"))
    return "bg-rose-50 text-rose-700 border-rose-200";
  if (!v || v.includes("awaiting") || v.includes("pending") || v.includes("sent"))
    return "bg-amber-50 text-amber-700 border-amber-200";
  return "bg-slate-100 text-slate-600 border-slate-200";
};

export default function NbfcConsentPanel({ leadId }: { leadId: string }) {
  const [consents, setConsents] = useState<ConsentRow[]>([]);
  const [template, setTemplate] = useState<{ url: string; size: number | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [method, setMethod] = useState<"esign" | "manual">("esign");
  const [consentFor, setConsentFor] = useState<"customer" | "borrower">("customer");
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  // Manual consent — the applicant wet-signs the NBFC's own consent template.
  const [manualNote, setManualNote] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/nbfc/acquire/${leadId}/consent`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (json.ok) {
        setConsents(json.consents ?? []);
        setTemplate(json.consentTemplate ?? null);
      }
    } catch {
      // best-effort
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    load();
  }, [load]);

  const send = async () => {
    // e-sign signs the NBFC's own template — block if none is configured.
    if (!template) {
      setBanner("Upload your consent document in Settings before sending consent.");
      return;
    }
    setBusy(true);
    setBanner(null);
    try {
      // e-sign delivers the Digio signing link over SMS.
      const res = await fetch(`/api/nbfc/acquire/${leadId}/consent/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "esign", consentFor, channel: "sms" }),
      });
      const json = await res.json();
      if (json.ok) {
        setBanner("E-sign link sent to the applicant.");
        await load();
      } else {
        setBanner(json.error ?? "Could not initiate consent");
      }
    } finally {
      setBusy(false);
    }
  };

  // Manual consent: the applicant wet-signs the NBFC's own consent template. The
  // request is raised to the admin (NBFC Actions), who forwards the template to
  // the dealer for the customer's signature, then the signed copy comes back up.
  const sendManual = async () => {
    if (!template) {
      setBanner("Upload your consent document in Settings before sending consent.");
      return;
    }
    setBusy(true);
    setBanner(null);
    try {
      const res = await fetch(`/api/nbfc/acquire/${leadId}/consent/manual`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          consentFor,
          comments: manualNote.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (json.ok) {
        setManualNote("");
        setBanner(
          "Sent to the admin for review. They will forward your consent document to the dealer for the applicant's signature.",
        );
        await load();
      } else {
        setBanner(json.error ?? "Could not send the consent request");
      }
    } catch {
      setBanner("Could not send the consent request");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="border border-slate-200 rounded-xl bg-white p-5">
      <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500 mb-4">
        DPDP Consent
      </h2>

      {/* The NBFC's own consent template (uploaded in Settings, reused per lead). */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
        <span className="text-xs font-semibold text-slate-600">
          Your consent document
          <span className="ml-1 font-normal text-slate-400">
            (used for e-sign &amp; manual signing)
          </span>
        </span>
        {template ? (
          <a
            href={template.url}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-semibold text-[color:var(--color-brand-sky)] hover:underline"
          >
            View template
          </a>
        ) : (
          <a
            href="/nbfc/settings"
            className="text-xs font-semibold text-amber-700 hover:underline"
          >
            Upload in Settings →
          </a>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-slate-400">Loading consent status…</p>
      ) : consents.length === 0 ? (
        <p className="text-sm text-slate-400">No consent captured yet.</p>
      ) : (
        <ul className="space-y-2 mb-4">
          {consents.map((c) => (
            <li
              key={c.consent_for ?? "primary"}
              className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-sm"
            >
              <span className="font-medium text-slate-700 capitalize">
                {(c.consent_for ?? "primary") === "co_borrower"
                  ? "Co-borrower"
                  : "Customer"}
                {c.sign_method ? (
                  <span className="ml-1 text-xs text-slate-400">
                    ({c.sign_method})
                  </span>
                ) : null}
              </span>
              <span className="flex items-center gap-2">
                {(c.signed_consent_url || c.generated_pdf_url) ? (
                  <a
                    href={(c.signed_consent_url || c.generated_pdf_url) as string}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs font-medium text-[color:var(--color-brand-sky)] hover:underline"
                  >
                    View
                  </a>
                ) : null}
                <span
                  className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_STYLE(
                    c.consent_status,
                  )}`}
                >
                  {c.consent_status ?? "none"}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {banner ? (
        <p className="mb-3 rounded-md bg-slate-50 border border-slate-200 px-3 py-2 text-xs text-slate-600">
          {banner}
        </p>
      ) : null}

      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
        <p className="mb-2 text-xs font-semibold text-slate-700">
          Take consent again
        </p>
        <div className="grid grid-cols-3 gap-2 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">Applicant</span>
            <select
              value={consentFor}
              onChange={(e) => setConsentFor(e.target.value as "customer" | "borrower")}
              className="rounded-md border border-slate-300 px-2 py-1.5"
            >
              <option value="customer">Customer</option>
              <option value="borrower">Co-borrower</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">Method</span>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value as "esign" | "manual")}
              className="rounded-md border border-slate-300 px-2 py-1.5"
            >
              <option value="esign">E-sign (Digio)</option>
              <option value="manual">Manual (sign)</option>
            </select>
          </label>
        </div>

        {/* Both methods sign the NBFC's own consent template. Manual = the
            applicant wet-signs it (admin forwards it to the dealer). */}
        {method === "manual" ? (
          <label className="mt-2 flex flex-col gap-1 text-xs">
            <span className="text-slate-500">Note to admin (optional)</span>
            <textarea
              value={manualNote}
              onChange={(e) => setManualNote(e.target.value)}
              rows={2}
              placeholder="Any instructions for the admin / dealer…"
              className="rounded-md border border-slate-300 px-2 py-1.5"
            />
          </label>
        ) : null}

        {!template ? (
          <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-700">
            Upload your consent document in{" "}
            <a href="/nbfc/settings" className="font-semibold underline">
              Settings
            </a>{" "}
            to take consent.
          </p>
        ) : null}

        <button
          type="button"
          onClick={method === "manual" ? sendManual : send}
          disabled={busy || !template}
          className="mt-2 rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
        >
          {busy
            ? "Sending…"
            : method === "manual"
              ? "Send for manual signing"
              : "Send e-sign link"}
        </button>
      </div>
    </section>
  );
}
