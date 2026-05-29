"use client";

/**
 * NbfcReviewAgreementSection — read-only twin-thumbnail preview of the
 * Step 3 agreement, mirroring the admin's Step 3 panel layout:
 *   • Card A — the blank PDF the admin uploaded
 *   • Card B — same PDF with the auto-fill overlay (company, RBI, signers)
 *
 * Clicking either thumbnail opens a modal showing the same content at
 * full size. Card B's modal also surfaces a structured sidebar of the
 * auto-fill values so the CEO can quickly verify what's about to be
 * stamped at signing time.
 *
 * Pure view layer — reuses `AgreementAutofillOverlay` exported from
 * `NbfcLspAgreementPanel.tsx` so the visual stays in sync with the
 * admin's preview.
 */

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  FileText,
  ExternalLink,
  X,
  AlertCircle,
} from "lucide-react";
import type { NbfcMasterSummary } from "./NbfcLspAgreementPanel";
import { AgreementAutofillOverlay } from "./NbfcLspAgreementPanel";
import NbfcFlagButton from "./NbfcFlagButton";
import { AGREEMENT_TEMPLATE_KEY } from "@/lib/nbfc/admin/correction-catalog";

export interface AgreementReviewRow {
  id: number;
  agreement_id: string | null;
  agreement_status: string | null;
  agreement_template_url: string | null;
  agreement_template_size: number | null;
  expires_at: string | Date | null;
}

export interface SignerForOverlay {
  fullName: string;
  email: string;
  designation: string;
  party: "nbfc" | "itarang";
}

interface Props {
  agreement: AgreementReviewRow | null;
  master: NbfcMasterSummary;
  signers: SignerForOverlay[];
  /**
   * True once the CEO has approved the NBFC (`row.status` is `approved` or
   * `active`). Used to relabel the `PENDING_CEO_VERIFICATION` badge as
   * `VERIFIED` after sign-off, since the approve flow doesn't mutate
   * `nbfc_lsp_agreements.agreement_status`.
   */
  nbfcApproved?: boolean;
}

/**
 * The raw `agreement_status` from the DB carries internal lifecycle values
 * (`PENDING_CEO_VERIFICATION`, `COMPLETED`, `SIGNED`). Render a friendlier
 * label, and after CEO sign-off relabel `PENDING_CEO_VERIFICATION` as
 * `VERIFIED` so the badge matches the "Successfully approved" banner.
 */
function displayStatus(
  rawStatus: string | null | undefined,
  nbfcApproved: boolean,
): string {
  if (!rawStatus) return "Ready";
  if (rawStatus === "PENDING_CEO_VERIFICATION") {
    return nbfcApproved ? "VERIFIED" : "PENDING_CEO_VERIFICATION";
  }
  return rawStatus;
}

type PreviewVariant = "blank" | "autofilled";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function NbfcReviewAgreementSection({
  agreement,
  master,
  signers,
  nbfcApproved = false,
}: Props) {
  const [previewOpen, setPreviewOpen] = useState<PreviewVariant | null>(null);
  const templateUrl = agreement?.agreement_template_url ?? "";
  const templateSize = agreement?.agreement_template_size ?? null;
  const fileName =
    templateUrl.split("/").pop() ?? "Agreement template";

  if (!agreement || !templateUrl) {
    return (
      <section className="card-iTarang p-6 md:p-7 space-y-3">
        <header>
          <p className="section-label">Step 3 · Agreement Document</p>
          <h2 className="text-lg font-semibold text-[color:var(--color-brand-navy)] mt-1">
            Agreement template
          </h2>
        </header>
        <div
          className="rounded-xl border border-dashed p-6 flex items-center gap-3 text-sm text-[color:var(--color-ink-muted)]"
          style={{ borderColor: "var(--color-border)" }}
        >
          <AlertCircle className="w-5 h-5 shrink-0" />
          <p>
            No agreement template has been uploaded yet for this NBFC. The
            admin must complete Step 3 before this section is populated.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="card-iTarang p-6 md:p-7 space-y-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <p
            className="section-label"
            style={{ color: "var(--color-brand-sky)" }}
          >
            Step 3 · Agreement Document
          </p>
          <h2 className="text-lg font-semibold text-[color:var(--color-brand-navy)] mt-1">
            Blank template + Auto-filled preview
          </h2>
          <p className="text-xs text-[color:var(--color-ink-muted)] mt-0.5">
            Click either card to inspect the agreement at full size.
            {agreement.agreement_id && (
              <>
                {" · "}
                <span className="font-mono">{agreement.agreement_id}</span>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          <span
            className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-full"
            style={{
              background: "var(--color-success-bg)",
              color: "var(--color-success)",
            }}
          >
            <CheckCircle2 className="w-3 h-3" />
            {displayStatus(agreement.agreement_status, nbfcApproved)}
          </span>
          <NbfcFlagButton
            kind="agreement_template"
            targetKey={AGREEMENT_TEMPLATE_KEY}
            targetRefId={agreement.id}
          />
        </div>
      </header>

      <div className="flex flex-wrap gap-4">
        {/* Card A — Blank */}
        <button
          type="button"
          onClick={() => setPreviewOpen("blank")}
          className="group relative rounded-xl overflow-hidden border-2 text-left transition-shadow hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-sky)]"
          style={{
            width: 288,
            height: 384,
            borderColor: "var(--color-success)",
            background: "var(--color-surface)",
          }}
        >
          <div
            className="px-3 py-2 text-[11px] font-semibold flex items-center justify-between"
            style={{
              background: "var(--color-success-bg)",
              color: "var(--color-success)",
            }}
          >
            <span className="inline-flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" />
              Blank template
            </span>
            <span className="text-[10px] font-medium opacity-80">
              {templateSize ? formatBytes(templateSize) : ""}
            </span>
          </div>
          <iframe
            src={`${templateUrl}#toolbar=0&navpanes=0&view=FitH`}
            title={`Blank agreement: ${fileName}`}
            className="w-full block bg-[color:var(--color-bg)] pointer-events-none"
            style={{ height: 312, border: 0 }}
            tabIndex={-1}
          />
          <div
            className="absolute bottom-0 left-0 right-0 px-3 py-1.5 text-[10px] font-medium text-white flex items-center justify-between"
            style={{ background: "rgba(0,0,0,0.55)" }}
          >
            <span className="truncate">{fileName}</span>
            <span className="ml-2 opacity-80 group-hover:opacity-100">
              Click to expand →
            </span>
          </div>
        </button>

        {/* Card B — Same PDF with auto-fill overlay */}
        <button
          type="button"
          onClick={() => setPreviewOpen("autofilled")}
          className="group relative rounded-xl overflow-hidden border-2 text-left transition-shadow hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-sky)]"
          style={{
            width: 288,
            height: 384,
            borderColor: "var(--color-brand-sky)",
            background: "var(--color-surface)",
          }}
        >
          <div
            className="px-3 py-2 text-[11px] font-semibold flex items-center justify-between"
            style={{
              background: "var(--brand-sky-soft, rgba(19,143,198,0.12))",
              color: "var(--color-brand-sky)",
            }}
          >
            <span className="inline-flex items-center gap-1">
              <FileText className="w-3 h-3" />
              Auto-filled details
            </span>
            <span className="text-[10px] font-medium opacity-80">
              {signers.length} signer{signers.length === 1 ? "" : "s"}
            </span>
          </div>
          <div
            className="relative bg-white pointer-events-none"
            style={{ height: 312 }}
          >
            <iframe
              src={`${templateUrl}#toolbar=0&navpanes=0&view=FitH`}
              title="Auto-filled agreement preview"
              className="w-full h-full block"
              style={{ border: 0 }}
              tabIndex={-1}
            />
            <AgreementAutofillOverlay
              master={master}
              signers={signers}
              compact
            />
          </div>
          <div
            className="absolute bottom-0 left-0 right-0 px-3 py-1.5 text-[10px] font-medium text-white flex items-center justify-between"
            style={{ background: "rgba(0,0,0,0.55)" }}
          >
            <span className="truncate">
              Same template · with admin's data stamped on it
            </span>
            <span className="ml-2 opacity-80 group-hover:opacity-100">
              Click to expand →
            </span>
          </div>
        </button>
      </div>

      {previewOpen && (
        <ReadOnlyAgreementModal
          variant={previewOpen}
          templateUrl={templateUrl}
          fileName={fileName}
          master={master}
          signers={signers}
          onClose={() => setPreviewOpen(null)}
        />
      )}
    </section>
  );
}

function ReadOnlyAgreementModal({
  variant,
  templateUrl,
  fileName,
  master,
  signers,
  onClose,
}: {
  variant: PreviewVariant;
  templateUrl: string;
  fileName: string;
  master: NbfcMasterSummary;
  signers: SignerForOverlay[];
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const title =
    variant === "blank"
      ? `Blank template — ${fileName}`
      : "Auto-filled agreement preview";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: "rgba(0,0,0,0.45)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="rounded-2xl overflow-hidden bg-white shadow-2xl flex flex-col"
        style={{ width: "min(70vw, 1100px)", height: "min(85vh, 900px)" }}
      >
        <header className="flex items-center justify-between gap-3 px-5 py-3 border-b border-[color:var(--color-border)]">
          <p className="text-sm font-semibold text-[color:var(--color-brand-navy)] truncate">
            {title}
          </p>
          <div className="flex items-center gap-2">
            <a
              href={templateUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-ghost text-xs inline-flex items-center gap-1"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Open in new tab
            </a>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close preview"
              className="btn-ghost inline-flex items-center justify-center w-8 h-8 p-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </header>
        <div className="flex-1 overflow-hidden bg-[color:var(--color-bg)] relative">
          <iframe
            src={`${templateUrl}#view=FitH`}
            title={fileName}
            className="w-full h-full block"
            style={{ border: 0 }}
          />
          {variant === "autofilled" && (
            <AgreementAutofillOverlay master={master} signers={signers} />
          )}
        </div>
      </div>
    </div>
  );
}
