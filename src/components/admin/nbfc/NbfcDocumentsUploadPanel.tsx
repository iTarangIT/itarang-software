"use client";

/**
 * NbfcDocumentsUploadPanel — Step 2 Compliance Documents upload UI.
 *
 * Admin uploads each mandatory compliance document. Each upload is a
 * 2-step exchange:
 *   1. POST multipart to .../compliance-documents/upload → returns a URL.
 *   2. POST JSON to .../compliance-documents with that URL.
 *
 * Once all 9 mandatory slugs have a non-rejected row, the "Next →" CTA
 * enables and the admin proceeds directly to Step 3 (LSP Agreement).
 */

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  FileText,
  Loader2,
  Upload,
  XCircle,
} from "lucide-react";

type DocStatus = "pending_review" | "verified" | "rejected";

export interface DocRow {
  id: number;
  document_type: string;
  file_url: string;
  status: DocStatus;
  rejection_reason: string | null;
  expiry_date: string | null;
  created_at: string | Date;
}

// Canonical doc slug list lives in a neutral module (not "use client") so
// server components can import the real array, not a client-reference proxy.
// Re-exported here so any caller that previously imported `NBFC_DOC_SLUGS`
// or `DocSlug` from this file's path keeps working.
import { NBFC_DOC_SLUGS, type DocSlug } from "./nbfc-doc-slugs";
export { NBFC_DOC_SLUGS, type DocSlug };

interface Props {
  nbfcId: number;
  status: string;
  initialDocs: DocRow[];
  /**
   * When true (NBFC is approved/active), the panel is fully read-only:
   * file pickers disabled, no Next button. The page renders
   * NbfcReadOnlyBanner above this panel.
   */
  locked?: boolean;
}

interface RowState {
  uploading: boolean;
  error: string | null;
}

export default function NbfcDocumentsUploadPanel({
  nbfcId,
  status,
  initialDocs,
  locked = false,
}: Props) {
  const router = useRouter();
  const [docs, setDocs] = useState<DocRow[]>(initialDocs);
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

  // E-111 — admin needs to re-upload while CEO has flagged items; widen the
  // edit gate to include request_correction. The status-machine still
  // controls when corrections can be SUBMITTED back to CEO review.
  // `locked` overrides everything — once the NBFC is approved/active no
  // re-upload is allowed regardless of status.
  const isEditable =
    !locked && (status === "draft" || status === "request_correction");

  // Latest row per slug (newest wins) — drives the badge.
  const latestBySlug = useMemo(() => {
    const map = new Map<string, DocRow>();
    for (const d of docs) {
      const prev = map.get(d.document_type);
      if (!prev || new Date(d.created_at) >= new Date(prev.created_at)) {
        map.set(d.document_type, d);
      }
    }
    return map;
  }, [docs]);

  const requiredSlugs = NBFC_DOC_SLUGS.filter((s) => s.required);
  const uploadedRequiredCount = requiredSlugs.filter((s) => {
    const r = latestBySlug.get(s.slug);
    return r && r.status !== "rejected";
  }).length;
  const allRequiredUploaded = uploadedRequiredCount === requiredSlugs.length;
  const canProceed = isEditable && allRequiredUploaded;

  function setRowError(slug: string, err: string | null) {
    setRowState((s) => ({ ...s, [slug]: { uploading: false, error: err } }));
  }

  async function handleUpload(slug: DocSlug, file: File) {
    setRowState((s) => ({
      ...s,
      [slug.slug]: { uploading: true, error: null },
    }));

    // For rbi_cor we need an expiry date. The simplest UX without inventing a
    // modal: prompt() once when the slug needs it and the user hasn't supplied
    // one. Replaceable with a proper date input in a follow-up polish task.
    let expiryDate: string | null = null;
    if (slug.needsExpiry) {
      const raw = window.prompt(
        "RBI CoR expiry date (YYYY-MM-DD):",
        new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10),
      );
      if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        setRowError(slug.slug, "Expiry date required (YYYY-MM-DD).");
        return;
      }
      expiryDate = raw;
    }

    try {
      // Step 1: upload the bytes.
      const fd = new FormData();
      fd.append("documentType", slug.slug);
      fd.append("file", file);

      const uploadRes = await fetch(
        `/api/admin/nbfc/${nbfcId}/compliance-documents/upload`,
        { method: "POST", body: fd },
      );
      const uploadJson = await uploadRes.json().catch(() => ({}));
      if (!uploadRes.ok || !uploadJson.fileUrl) {
        setRowError(slug.slug, uploadJson.error ?? `Upload failed (${uploadRes.status})`);
        return;
      }

      // Step 2: register the row.
      const registerRes = await fetch(
        `/api/admin/nbfc/${nbfcId}/compliance-documents`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            documentType: slug.slug,
            fileUrl: uploadJson.fileUrl,
            expiryDate: expiryDate ?? undefined,
          }),
        },
      );
      const registerJson = await registerRes.json().catch(() => ({}));
      if (!registerRes.ok || !registerJson.id) {
        // If the server returned Zod issues, surface them — the bare
        // "UNPROCESSABLE: validation failed" string isn't actionable.
        const issues = Array.isArray(registerJson.issues)
          ? registerJson.issues
              .map((it: { path?: unknown[]; message?: string }) => {
                const path = Array.isArray(it.path) ? it.path.join(".") : "";
                return path ? `${path}: ${it.message}` : it.message;
              })
              .filter(Boolean)
              .join("; ")
          : "";
        setRowError(
          slug.slug,
          issues ||
            registerJson.error ||
            `Register failed (${registerRes.status})`,
        );
        return;
      }

      const newRow: DocRow = {
        id: registerJson.id,
        document_type: registerJson.document_type,
        file_url: registerJson.file_url,
        status: registerJson.status as DocStatus,
        rejection_reason: null,
        expiry_date: registerJson.expiry_date ?? null,
        created_at: registerJson.created_at ?? new Date().toISOString(),
      };
      setDocs((d) => [...d, newRow]);
      setRowError(slug.slug, null);
      const ref = fileInputs.current[slug.slug];
      if (ref) ref.value = "";
    } catch (err) {
      setRowError(slug.slug, err instanceof Error ? err.message : String(err));
    }
  }

  function handleNext() {
    router.push(`/admin/nbfc/${nbfcId}/lsp-agreement`);
  }

  return (
    // Locked mode: <fieldset disabled> propagates `disabled` to every
    // nested form control (file pickers, Reupload + Next buttons), but
    // does NOT affect <a> tags — so "View uploaded document" links
    // stay clickable, which is exactly the read-only review experience
    // we want for both admin and CEO post-approval.
    <fieldset
      disabled={locked}
      className={
        locked
          ? "block opacity-80 border-0 p-0 m-0 space-y-6"
          : "contents"
      }
    >
    <div className="space-y-6">
      <section className="card-iTarang p-6 md:p-7 space-y-5">
        <header className="space-y-1">
          <p className="section-label">Compliance · BRD §6.0.4</p>
          <h2 className="text-lg font-semibold text-[color:var(--color-brand-navy)]">
            Upload the {requiredSlugs.length} mandatory documents
          </h2>
          <p className="text-xs text-[color:var(--color-ink-muted)]">
            {uploadedRequiredCount} of {requiredSlugs.length} mandatory uploaded. Once all are uploaded, continue to the Agreement.
          </p>
        </header>

        <div className="space-y-3">
          {NBFC_DOC_SLUGS.map((slug) => {
            const row = latestBySlug.get(slug.slug);
            const state = rowState[slug.slug];
            return (
              <DocSlugRow
                key={slug.slug}
                slug={slug}
                row={row}
                uploading={state?.uploading ?? false}
                error={state?.error ?? null}
                disabled={!isEditable}
                onFileChosen={(file) => {
                  void handleUpload(slug, file);
                }}
                fileInputRef={(el) => {
                  fileInputs.current[slug.slug] = el;
                }}
              />
            );
          })}
        </div>
      </section>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-2 border-t border-[color:var(--color-border)]">
        <p className="text-xs text-[color:var(--color-ink-muted)] max-w-md">
          Once all {requiredSlugs.length} mandatory docs are uploaded, continue to Step 3 to initiate the Agreement.
        </p>
        <div className="flex flex-wrap gap-2 justify-end">
          <a
            href={`/admin/nbfc/${nbfcId}/edit`}
            className="btn-ghost"
          >
            Back to master
          </a>
          <button
            type="button"
            onClick={handleNext}
            disabled={!canProceed}
            className="btn-primary"
            aria-label="Next: Agreement"
          >
            Next →
          </button>
        </div>
      </div>
    </div>
    </fieldset>
  );
}

function DocSlugRow({
  slug,
  row,
  uploading,
  error,
  disabled,
  onFileChosen,
  fileInputRef,
}: {
  slug: DocSlug;
  row: DocRow | undefined;
  uploading: boolean;
  error: string | null;
  disabled: boolean;
  onFileChosen: (file: File) => void;
  fileInputRef: (el: HTMLInputElement | null) => void;
}) {
  const inputId = `nbfc-doc-${slug.slug}`;
  const badge = renderBadge(row);
  const hasUpload = !!row && row.status !== "rejected";
  const verb = hasUpload ? "Reupload" : "Upload";

  return (
    <div className="rounded-xl border border-[color:var(--color-border)] px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
      <div className="flex items-start gap-3 flex-1 min-w-0">
        <FileText
          className="w-5 h-5 shrink-0 mt-0.5"
          style={{ color: "var(--color-brand-sky)" }}
        />
        <div className="min-w-0">
          <p className="text-sm font-medium text-[color:var(--color-brand-navy)] truncate">
            {slug.label}
            {!slug.required && (
              <span className="text-[color:var(--color-ink-muted)] text-xs font-normal ml-2">
                (optional)
              </span>
            )}
          </p>
          {hasUpload && row && (
            <a
              href={row.file_url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium underline text-[color:var(--color-brand-sky)] hover:text-[color:var(--color-brand-navy)]"
            >
              <FileText className="w-3 h-3" />
              View uploaded document
            </a>
          )}
          {row?.status === "rejected" && row.rejection_reason && (
            <p className="text-xs text-[color:var(--color-danger)] mt-0.5">
              Rejected: {row.rejection_reason}
            </p>
          )}
          {error && (
            <p className="text-xs text-[color:var(--color-danger)] mt-0.5">{error}</p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        {badge}
        <label
          htmlFor={inputId}
          className={`btn-ghost text-xs ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
        >
          {uploading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Upload className="w-4 h-4" />
          )}
          {verb}
        </label>
        <input
          id={inputId}
          ref={fileInputRef}
          type="file"
          className="sr-only"
          disabled={disabled || uploading}
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            if (f) onFileChosen(f);
          }}
        />
      </div>
    </div>
  );
}

function renderBadge(row: DocRow | undefined) {
  if (!row) {
    return <span className="status-pill-neutral text-[10px]">Not uploaded</span>;
  }
  if (row.status === "verified") {
    return (
      <span className="status-pill-success text-[10px] inline-flex items-center gap-1">
        <CheckCircle2 className="w-3 h-3" />
        Verified
      </span>
    );
  }
  if (row.status === "rejected") {
    return (
      <span className="status-pill-danger text-[10px] inline-flex items-center gap-1">
        <XCircle className="w-3 h-3" />
        Rejected
      </span>
    );
  }
  return (
    <span className="status-pill-success text-[10px] inline-flex items-center gap-1">
      <CheckCircle2 className="w-3 h-3" />
      Uploaded
    </span>
  );
}
