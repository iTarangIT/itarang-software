"use client";

import { useState } from "react";

// E-205 — the NBFC's own DPDP consent-template PDF. Uploaded once here, reused
// across all leads for the Acquire e-sign/OTP consent flow. Only nbfc_admin can
// change it; everyone can view the current one.

interface ConsentTemplate {
  url: string;
  size: number | null;
}

function fmtSize(bytes: number | null): string {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ConsentTemplateSection({
  initialTemplate,
  canEdit,
}: {
  initialTemplate: ConsentTemplate | null;
  canEdit: boolean;
}) {
  const [template, setTemplate] = useState<ConsentTemplate | null>(initialTemplate);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const upload = async () => {
    if (!file) {
      setErr("Choose a PDF to upload first.");
      return;
    }
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/nbfc/settings/consent-template", {
        method: "POST",
        body: form,
      });
      const json = await res.json();
      if (json.ok) {
        setTemplate(json.template);
        setFile(null);
        setMsg("Consent template saved. It will be used for e-sign and OTP consent on all leads.");
      } else {
        setErr(json.error ?? "Upload failed");
      }
    } catch {
      setErr("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch("/api/nbfc/settings/consent-template", {
        method: "DELETE",
      });
      const json = await res.json();
      if (json.ok) {
        setTemplate(null);
        setMsg("Consent template removed.");
      } else {
        setErr(json.error ?? "Could not remove the template");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
      <h2 className="text-sm font-bold uppercase tracking-widest text-slate-500 mb-1">
        Consent document
      </h2>
      <p className="text-xs text-slate-500 mb-4">
        Upload your standard DPDP consent PDF. It is reused for every lead — the
        customer / co-borrower e-signs or OTP-consents to this document from the
        Acquire workspace. (Manual uploads are still done per lead.)
      </p>

      {template ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 dark:border-slate-800 px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-emerald-50 text-emerald-600">
              <svg className="h-4.5 w-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <path d="M14 2v6h6" />
              </svg>
            </span>
            <div>
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                Current consent template
              </p>
              <p className="text-xs text-slate-500">
                PDF{template.size ? ` · ${fmtSize(template.size)}` : ""}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={template.url}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              View
            </a>
            {canEdit ? (
              <button
                type="button"
                onClick={remove}
                disabled={busy}
                className="rounded-md border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 disabled:opacity-50"
              >
                Remove
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">
          No consent template uploaded yet. E-sign and OTP consent are disabled
          until you upload one.
        </p>
      )}

      {canEdit ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <input
            type="file"
            accept="application/pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-xs file:mr-2 file:rounded file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-xs file:font-semibold"
          />
          <button
            type="button"
            onClick={upload}
            disabled={busy || !file}
            className="rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            {busy ? "Uploading…" : template ? "Replace template" : "Upload & save"}
          </button>
        </div>
      ) : (
        <p className="mt-3 text-xs text-slate-400">
          Only an NBFC admin can change the consent template.
        </p>
      )}

      {msg ? (
        <p className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          {msg}
        </p>
      ) : null}
      {err ? (
        <p className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {err}
        </p>
      ) : null}
    </section>
  );
}
