"use client";

/**
 * NbfcReviewDocumentsSection — read-only listing of every Step 2 compliance
 * document for an NBFC, rendered on the CEO approval / review page.
 *
 * For each of the canonical 11 doc slugs we show the label, a status pill
 * (Uploaded / Verified / Rejected / Not uploaded), and a View link when an
 * uploaded row exists. The View link opens the PDF / image in a new tab —
 * the middleware now excludes `.pdf` so the file loads directly from
 * `public/nbfc-uploads/...`.
 *
 * E-111 — each row also renders a FlagButton so the CEO can flag a
 * specific document for correction/re-upload.
 */
import { FileText, CheckCircle2, XCircle, Eye } from "lucide-react";
import { NBFC_DOC_SLUGS } from "./nbfc-doc-slugs";
import NbfcFlagButton from "./NbfcFlagButton";

export interface ComplianceDocRow {
  id: number;
  document_type: string;
  file_url: string;
  status: string;
  rejection_reason: string | null;
  expiry_date: string | null;
  created_at: string | Date | null;
}

interface Props {
  docs: ComplianceDocRow[];
}

function StatusPill({ status }: { status: string }) {
  if (status === "verified") {
    return (
      <span className="status-pill-success inline-flex items-center gap-1">
        <CheckCircle2 className="w-3 h-3" />
        Verified
      </span>
    );
  }
  if (status === "rejected") {
    return (
      <span className="status-pill-danger inline-flex items-center gap-1">
        <XCircle className="w-3 h-3" />
        Rejected
      </span>
    );
  }
  if (status === "pending_review") {
    return <span className="status-pill-info">Uploaded</span>;
  }
  return <span className="status-pill-neutral">{status}</span>;
}

export default function NbfcReviewDocumentsSection({ docs }: Props) {
  // Latest row per slug — same convention as the admin upload panel.
  const latestBySlug = new Map<string, ComplianceDocRow>();
  for (const d of docs) {
    const prev = latestBySlug.get(d.document_type);
    if (
      !prev ||
      new Date(d.created_at ?? 0) >= new Date(prev.created_at ?? 0)
    ) {
      latestBySlug.set(d.document_type, d);
    }
  }

  const uploadedCount = NBFC_DOC_SLUGS.filter(
    (s) => latestBySlug.has(s.slug) && latestBySlug.get(s.slug)?.status !== "rejected",
  ).length;
  const requiredCount = NBFC_DOC_SLUGS.filter((s) => s.required).length;

  return (
    <section className="card-iTarang p-6 md:p-7 space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="section-label">Compliance Documents · BRD §6.0.4</p>
          <h2 className="text-lg font-semibold text-[color:var(--color-brand-navy)] mt-1">
            Step 2 — RBI DL Directions 2025 evidence
          </h2>
          <p className="text-xs text-[color:var(--color-ink-muted)] mt-0.5">
            {uploadedCount} of {requiredCount} mandatory uploaded.
          </p>
        </div>
      </header>

      <div className="space-y-2">
        {NBFC_DOC_SLUGS.map((slug) => {
          const row = latestBySlug.get(slug.slug);
          return (
            <div
              key={slug.slug}
              className="rounded-xl border border-[color:var(--color-border)] px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3"
            >
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
                  {row?.status === "rejected" && row.rejection_reason && (
                    <p className="text-xs text-[color:var(--color-danger)] mt-0.5">
                      Rejected: {row.rejection_reason}
                    </p>
                  )}
                  {row?.expiry_date && (
                    <p className="text-[11px] text-[color:var(--color-ink-muted)] mt-0.5">
                      Expires {row.expiry_date}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0 flex-wrap">
                {row ? (
                  <StatusPill status={row.status} />
                ) : (
                  <span className="status-pill-neutral text-[10px]">
                    Not uploaded
                  </span>
                )}
                {row && row.status !== "rejected" && (
                  <a
                    href={row.file_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-ghost text-xs inline-flex items-center gap-1"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    View
                  </a>
                )}
                <NbfcFlagButton
                  kind="compliance_doc"
                  targetKey={slug.slug}
                  targetRefId={row?.id}
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
