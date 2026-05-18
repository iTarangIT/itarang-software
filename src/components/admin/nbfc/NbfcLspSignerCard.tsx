"use client";

/**
 * NbfcLspSignerCard — single signer row used by NbfcLspAgreementPanel.
 *
 * The card collects four mandatory fields per signer (full name, email,
 * designation, identity document upload) and is rendered in two color
 * variants:
 *   - "nbfc"    → blue left accent, "NBFC Signatory" pill
 *   - "itarang" → teal left accent, "iTarang Signatory" pill
 *
 * Identity-document upload is handled inline here: the file is POSTed to
 * /api/admin/nbfc/{nbfcId}/lsp-agreement/signer-identity/upload, the
 * returned fileUrl is written back into the parent form via the
 * `setValue` callback, and the size is tracked for the receipt + the
 * Initiate request body. The card never persists anything on its own —
 * persistence happens on the form's final submit.
 */

import { useRef, useState, type ChangeEvent } from "react";
import {
  Trash2,
  Upload,
  CheckCircle2,
  FileText,
  Loader2,
  AlertCircle,
  Eye,
  RefreshCw,
} from "lucide-react";
import type { FieldErrors, UseFormRegister } from "react-hook-form";
import type { LspAgreementFormValues } from "./NbfcLspAgreementPanel";

export type SignerVariant = "nbfc" | "itarang";

export interface NbfcLspSignerCardProps {
  nbfcId: number;
  variant: SignerVariant;
  /** Position in the overall sequential signing order (1-based). */
  signerNumber: number;
  /** Total number of signers, so we can render "Signs first / second / …". */
  totalSigners: number;
  /** RHF path prefix for this row, e.g. "nbfcSigners.0" / "itarangSigners.2". */
  fieldPath: `nbfcSigners.${number}` | `itarangSigners.${number}`;
  register: UseFormRegister<LspAgreementFormValues>;
  errors: FieldErrors<LspAgreementFormValues>;
  /** RHF setValue bound by the parent so the uploader can write the URL/size. */
  onIdentityUploaded: (url: string, size: number) => void;
  /** Current identity-doc URL — null/empty when nothing uploaded yet. */
  identityUrl: string;
  /** Current size in bytes; renders the receipt. */
  identitySize?: number;
  /** Whether the trash button is rendered (only for dynamically-added rows). */
  removable: boolean;
  onRemove: () => void;
}

const ORDER_WORDS = [
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
];

function orderLabel(position: number): string {
  return ORDER_WORDS[position - 1] ?? `${position}th`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const ACCENT: Record<SignerVariant, string> = {
  nbfc: "var(--color-brand-sky)",
  itarang: "var(--color-brand-teal)",
};

const PARTY_LABEL: Record<SignerVariant, string> = {
  nbfc: "NBFC Signatory",
  itarang: "iTarang Signatory",
};

function getRowErrors(
  errors: FieldErrors<LspAgreementFormValues>,
  fieldPath: NbfcLspSignerCardProps["fieldPath"],
) {
  const [group, idxStr] = fieldPath.split(".") as [
    "nbfcSigners" | "itarangSigners",
    string,
  ];
  const idx = Number(idxStr);
  const row = errors[group]?.[idx];
  return {
    fullName: row?.fullName?.message,
    email: row?.email?.message,
    designation: row?.designation?.message,
    identity: row?.identityDocumentUrl?.message,
  } as const;
}

export default function NbfcLspSignerCard({
  nbfcId,
  variant,
  signerNumber,
  totalSigners,
  fieldPath,
  register,
  errors,
  onIdentityUploaded,
  identityUrl,
  identitySize,
  removable,
  onRemove,
}: NbfcLspSignerCardProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const accent = ACCENT[variant];
  const rowErrors = getRowErrors(errors, fieldPath);

  const orderText =
    signerNumber === totalSigners && totalSigners > 1
      ? `Signs last (${orderLabel(signerNumber)})`
      : `Signs ${orderLabel(signerNumber)}`;

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.currentTarget.files?.[0];
    if (!file) return;
    setUploadError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(
        `/api/admin/nbfc/${nbfcId}/lsp-agreement/signer-identity/upload`,
        { method: "POST", body: fd },
      );
      const body = (await res.json()) as {
        ok?: boolean;
        fileUrl?: string;
        size?: number;
        error?: string;
      };
      if (!res.ok || !body.ok || !body.fileUrl) {
        setUploadError(body.error ?? `Upload failed (${res.status})`);
        return;
      }
      setFileName(file.name);
      onIdentityUploaded(body.fileUrl, body.size ?? file.size);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      // Reset the input so re-selecting the same file fires onChange.
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const hasUpload = !!identityUrl;

  return (
    <div
      className="card-iTarang p-5 md:p-6 border-l-4 transition-shadow hover:shadow-md"
      style={{ borderLeftColor: accent }}
    >
      <div className="flex items-start gap-3 mb-4">
        <div
          className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-semibold"
          style={{ backgroundColor: accent }}
        >
          {signerNumber}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="inline-flex items-center text-[10px] font-semibold tracking-wider uppercase px-2 py-0.5 rounded-full"
              style={{
                backgroundColor: `${accent}1a`,
                color: accent,
              }}
            >
              {PARTY_LABEL[variant]}
            </span>
            <span className="inline-flex items-center text-[10px] font-medium px-2 py-0.5 rounded-full bg-[color:var(--color-bg)] text-[color:var(--color-ink-muted)]">
              {orderText}
            </span>
          </div>
          <p className="text-[11px] text-[color:var(--color-ink-muted)] mt-1">
            Signer {signerNumber} of {totalSigners}
          </p>
        </div>
        {removable && (
          <button
            type="button"
            onClick={onRemove}
            aria-label="Remove signer"
            className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-md text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-danger)] hover:bg-[color:var(--color-danger-bg)] transition-colors"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-[color:var(--color-ink)]">
            Full name
          </span>
          <input
            type="text"
            className="input-itarang"
            {...register(`${fieldPath}.fullName` as const)}
            data-testid={`${fieldPath}-fullName`}
          />
          {rowErrors.fullName && (
            <span className="text-[11px] text-[color:var(--color-danger)]">
              {rowErrors.fullName}
            </span>
          )}
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-[color:var(--color-ink)]">
            Email
          </span>
          <input
            type="email"
            className="input-itarang"
            {...register(`${fieldPath}.email` as const)}
            data-testid={`${fieldPath}-email`}
          />
          {rowErrors.email && (
            <span className="text-[11px] text-[color:var(--color-danger)]">
              {rowErrors.email}
            </span>
          )}
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-[color:var(--color-ink)]">
            Designation
          </span>
          <input
            type="text"
            placeholder="e.g. Director, Authorised Signatory"
            className="input-itarang"
            {...register(`${fieldPath}.designation` as const)}
            data-testid={`${fieldPath}-designation`}
          />
          {rowErrors.designation && (
            <span className="text-[11px] text-[color:var(--color-danger)]">
              {rowErrors.designation}
            </span>
          )}
        </label>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-[color:var(--color-ink)]">
            Identity document
          </span>
          {hasUpload ? (
            // Uploaded — row with View + Change actions (no longer a single
            // clickable button so the View link can live inside it).
            <div
              className="flex items-center gap-3 px-4 py-3 rounded-xl border-2"
              style={{
                borderStyle: "solid",
                borderColor: "var(--color-success)",
                background: "var(--color-success-bg)",
              }}
            >
              <CheckCircle2
                className="w-5 h-5 shrink-0"
                style={{ color: "var(--color-success)" }}
              />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-[color:var(--color-brand-navy)] truncate">
                  {fileName ?? "Identity document uploaded"}
                </p>
                <p className="text-[11px] text-[color:var(--color-ink-muted)]">
                  {identitySize ? formatSize(identitySize) : "Uploaded"}
                </p>
              </div>
              <a
                href={identityUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-ghost text-[11px] inline-flex items-center gap-1 px-2 py-1"
                data-testid={`${fieldPath}-identity-view`}
                aria-label="View identity document"
              >
                <Eye className="w-3.5 h-3.5" />
                View
              </a>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                data-testid={`${fieldPath}-identity-trigger`}
                className="btn-ghost text-[11px] inline-flex items-center gap-1 px-2 py-1"
              >
                {uploading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                Change
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              data-testid={`${fieldPath}-identity-trigger`}
              className="flex items-center gap-3 px-4 py-3 rounded-xl border-2 text-left transition-colors disabled:opacity-60"
              style={{
                borderStyle: "dashed",
                borderColor: "var(--color-border)",
              }}
            >
              {uploading ? (
                <Loader2 className="w-5 h-5 shrink-0 animate-spin text-[color:var(--color-brand-sky)]" />
              ) : (
                <Upload className="w-5 h-5 shrink-0 text-[color:var(--color-ink-muted)]" />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-[color:var(--color-ink)]">
                  {uploading ? "Uploading…" : "Upload identity document"}
                </p>
                <p className="text-[11px] text-[color:var(--color-ink-muted)]">
                  PDF / JPG / PNG · max 5 MB
                </p>
              </div>
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,image/jpeg,image/png"
            className="sr-only"
            onChange={handleFileChange}
            data-testid={`${fieldPath}-identity-input`}
          />
          {(rowErrors.identity || uploadError) && (
            <span
              role="alert"
              className="inline-flex items-center gap-1 text-[11px] text-[color:var(--color-danger)]"
            >
              <AlertCircle className="w-3 h-3" />
              {uploadError ?? rowErrors.identity}
            </span>
          )}
          {/* Hidden registered field carries the uploaded URL into the form. */}
          <input
            type="hidden"
            {...register(`${fieldPath}.identityDocumentUrl` as const)}
          />
        </div>
      </div>
    </div>
  );
}
