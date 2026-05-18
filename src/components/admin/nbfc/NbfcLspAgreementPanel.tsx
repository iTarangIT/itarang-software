"use client";

/**
 * NbfcLspAgreementPanel — Step 3 "Agreement" form (rebuilt under E-109).
 *
 * Visual + behavior spec:
 *   - Two grouped sections: NBFC signatories (blue) + iTarang signatories
 *     (teal). Each card collects Full name, Email, Designation, and a
 *     mandatory identity document (PDF/JPG/PNG ≤ 5 MB).
 *   - Defaults: 1 NBFC signer + 2 iTarang signers. Both groups can grow via
 *     "Add another …" buttons. Dynamically-added cards expose a trash
 *     button; the default rows (NBFC index 0, iTarang index 0/1) do not.
 *   - Numbered avatars reflect the global sequential signing order
 *     ([NBFC...] then [iTarang...]). Removing or adding cards reflows the
 *     numbers + "Signs Nth" pills automatically.
 *   - Submit posts JSON to the existing
 *     /api/admin/nbfc/{nbfcId}/lsp-agreement/initiate route (extended schema
 *     for N signers) and on success routes to /admin/nbfc/{nbfcId}/approval.
 *
 * Form stack: react-hook-form + Zod resolver + useFieldArray.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Loader2,
  AlertCircle,
  Plus,
  Upload,
  CheckCircle2,
  FileText,
  ExternalLink,
  RefreshCw,
  X,
} from "lucide-react";
import NbfcLspSignerCard from "./NbfcLspSignerCard";

const signerSchema = z.object({
  fullName: z.string().min(2, "Full name is required"),
  email: z.string().email("Enter a valid email"),
  designation: z.string().min(2, "Designation is required"),
  identityDocumentUrl: z
    .string()
    .min(1, "Upload an identity document"),
  identityDocumentSize: z.number().int().positive().optional(),
});

const formSchema = z.object({
  nbfcSigners: z.array(signerSchema).min(1),
  itarangSigners: z.array(signerSchema).min(1),
  agreementTemplateUrl: z
    .string()
    .min(1, "Upload the blank agreement template"),
  agreementTemplateSize: z.number().int().positive().optional(),
});

export type LspAgreementFormValues = z.infer<typeof formSchema>;

export interface NbfcMasterSummary {
  legalName: string;
  shortName: string;
  nbfcPublicId: string;
  rbiRegistrationNo: string;
  cin: string;
  gstNumber: string;
  panNumber: string;
}

const EMPTY_SIGNER = {
  fullName: "",
  email: "",
  designation: "",
  identityDocumentUrl: "",
  identityDocumentSize: undefined,
} as const;

const DEFAULT_NBFC_COUNT = 1;
const DEFAULT_ITARANG_COUNT = 1;

export interface InitialAgreementValues {
  nbfcSigners: Array<{
    fullName: string;
    email: string;
    designation: string;
    identityDocumentUrl: string;
    identityDocumentSize?: number;
  }>;
  itarangSigners: Array<{
    fullName: string;
    email: string;
    designation: string;
    identityDocumentUrl: string;
    identityDocumentSize?: number;
  }>;
  agreementTemplateUrl: string;
  agreementTemplateSize?: number;
}

interface Props {
  nbfcId: number;
  master: NbfcMasterSummary;
  /**
   * Pre-fill values when re-entering Step 3 after a CEO correction request.
   * `null` (or empty arrays) renders the default one-empty-row form.
   */
  initialAgreement?: InitialAgreementValues | null;
  /**
   * Read-only mode (NBFC approved/active). When true: every signer
   * input + uploads + Add/Remove + the bottom "Send to CEO" CTA are
   * disabled / hidden. The page renders NbfcReadOnlyBanner above this
   * panel.
   */
  locked?: boolean;
}

export default function NbfcLspAgreementPanel({
  nbfcId,
  master,
  initialAgreement,
  locked = false,
}: Props) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitErrorPg, setSubmitErrorPg] = useState<{
    code?: string;
    constraint?: string;
  } | null>(null);

  const initialNbfcSigners =
    initialAgreement?.nbfcSigners && initialAgreement.nbfcSigners.length > 0
      ? initialAgreement.nbfcSigners.map((s) => ({ ...EMPTY_SIGNER, ...s }))
      : Array.from({ length: DEFAULT_NBFC_COUNT }, () => ({ ...EMPTY_SIGNER }));

  const initialItarangSigners =
    initialAgreement?.itarangSigners &&
    initialAgreement.itarangSigners.length > 0
      ? initialAgreement.itarangSigners.map((s) => ({ ...EMPTY_SIGNER, ...s }))
      : Array.from({ length: DEFAULT_ITARANG_COUNT }, () => ({
          ...EMPTY_SIGNER,
        }));

  const {
    register,
    control,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<LspAgreementFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      nbfcSigners: initialNbfcSigners,
      itarangSigners: initialItarangSigners,
      agreementTemplateUrl: initialAgreement?.agreementTemplateUrl ?? "",
      agreementTemplateSize: initialAgreement?.agreementTemplateSize,
    },
    mode: "onSubmit",
  });

  const nbfcGroup = useFieldArray({ control, name: "nbfcSigners" });
  const itarangGroup = useFieldArray({ control, name: "itarangSigners" });

  const nbfcWatch = watch("nbfcSigners");
  const itarangWatch = watch("itarangSigners");
  const templateUrl = watch("agreementTemplateUrl");
  const totalSigners = nbfcGroup.fields.length + itarangGroup.fields.length;

  // Real-time submit gate — the button enables only when *at least one*
  // NBFC signer is fully filled (name + email + designation + identity doc),
  // *at least one* iTarang signer is fully filled, AND the agreement
  // template is uploaded. We compute manually (rather than relying on RHF's
  // isValid) so we don't have to switch to mode:"onChange" — which would
  // flash inline errors on every keystroke before the user even blurs.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const isSignerComplete = (s: {
    fullName?: string;
    email?: string;
    designation?: string;
    identityDocumentUrl?: string;
  }) =>
    (s.fullName?.trim().length ?? 0) >= 2 &&
    !!s.email &&
    EMAIL_RE.test(s.email) &&
    (s.designation?.trim().length ?? 0) >= 2 &&
    !!s.identityDocumentUrl;

  const hasValidNbfc = (nbfcWatch ?? []).some(isSignerComplete);
  const hasValidItarang = (itarangWatch ?? []).some(isSignerComplete);
  const hasTemplate = !!templateUrl;
  const canSubmit = hasValidNbfc && hasValidItarang && hasTemplate;

  async function onSubmit(values: LspAgreementFormValues) {
    // Read-only safety net — the UI hides the submit button when locked,
    // but a stray Enter-key submit must also be a no-op.
    if (locked) return;
    setSubmitting(true);
    setSubmitError(null);
    setSubmitErrorPg(null);
    try {
      const res = await fetch(
        `/api/admin/nbfc/${nbfcId}/lsp-agreement/initiate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        message?: string;
        reason?: string;
        driverMessage?: string;
        pg?: {
          code?: string;
          message?: string;
          detail?: string;
          hint?: string;
          constraint?: string;
        } | null;
      };
      if (!res.ok || body.ok === false) {
        setSubmitError(
          body.reason ??
            body.pg?.message ??
            body.message ??
            body.error ??
            `Initiation failed (${res.status})`,
        );
        if (body.pg?.code) {
          setSubmitErrorPg({
            code: body.pg.code,
            constraint: body.pg.constraint,
          });
        }
        setSubmitting(false);
        return;
      }
      router.push(`/admin/nbfc/${nbfcId}/approval`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="space-y-8"
      data-testid="lsp-agreement-form"
    >
      {/* Locked mode: <fieldset disabled> propagates `disabled` to every
          nested form control (signer inputs, file pickers, Add/Send
          buttons), but does NOT affect <a> tags — so identity-document
          "View" links and the agreement-template preview links stay
          clickable, which is the read-only review experience we want. */}
      <fieldset
        disabled={locked}
        className={
          locked
            ? "block opacity-80 border-0 p-0 m-0 space-y-8"
            : "contents"
        }
      >
      <div>
        <p className="section-label">Agreement</p>
        <h2 className="text-2xl font-semibold text-[color:var(--color-brand-navy)] mt-1">
          Sequential signing via Digio
        </h2>
        <p className="text-sm text-[color:var(--color-ink-muted)] mt-1 max-w-2xl">
          Signers are notified in order — every NBFC signatory first, then
          every iTarang signatory. Designation and a scanned identity document
          are mandatory per signer for the compliance audit trail; identity
          documents stay in iTarang's records and are not sent to Digio.
        </p>
      </div>

      {/* NBFC signers */}
      <section className="space-y-4">
        <header className="flex items-center justify-between gap-3">
          <div>
            <p
              className="section-label"
              style={{ color: "var(--color-brand-sky)" }}
            >
              NBFC Signatories
            </p>
            <p className="text-xs text-[color:var(--color-ink-muted)] mt-0.5">
              At least one is required. Add more if multiple NBFC signatories
              must sign.
            </p>
          </div>
        </header>
        <div className="space-y-4">
          {nbfcGroup.fields.map((field, idx) => {
            const signerNumber = idx + 1;
            return (
              <NbfcLspSignerCard
                key={field.id}
                nbfcId={nbfcId}
                variant="nbfc"
                signerNumber={signerNumber}
                totalSigners={totalSigners}
                fieldPath={`nbfcSigners.${idx}` as const}
                register={register}
                errors={errors}
                identityUrl={nbfcWatch?.[idx]?.identityDocumentUrl ?? ""}
                identitySize={nbfcWatch?.[idx]?.identityDocumentSize}
                onIdentityUploaded={(url, size) => {
                  setValue(`nbfcSigners.${idx}.identityDocumentUrl`, url, {
                    shouldValidate: true,
                    shouldDirty: true,
                  });
                  setValue(`nbfcSigners.${idx}.identityDocumentSize`, size, {
                    shouldDirty: true,
                  });
                }}
                removable={idx >= DEFAULT_NBFC_COUNT}
                onRemove={() => nbfcGroup.remove(idx)}
              />
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => nbfcGroup.append({ ...EMPTY_SIGNER })}
          className="btn-ghost inline-flex items-center gap-1.5 text-sm"
          data-testid="add-nbfc-signer"
        >
          <Plus className="w-4 h-4" />
          Add another NBFC signatory
        </button>
      </section>

      {/* iTarang signers */}
      <section className="space-y-4">
        <header className="flex items-center justify-between gap-3">
          <div>
            <p
              className="section-label"
              style={{ color: "var(--color-brand-teal)" }}
            >
              iTarang Signatories
            </p>
            <p className="text-xs text-[color:var(--color-ink-muted)] mt-0.5">
              At least one iTarang authorised signatory is required. Add more
              if multiple signatures are needed.
            </p>
          </div>
        </header>
        <div className="space-y-4">
          {itarangGroup.fields.map((field, idx) => {
            const signerNumber = nbfcGroup.fields.length + idx + 1;
            return (
              <NbfcLspSignerCard
                key={field.id}
                nbfcId={nbfcId}
                variant="itarang"
                signerNumber={signerNumber}
                totalSigners={totalSigners}
                fieldPath={`itarangSigners.${idx}` as const}
                register={register}
                errors={errors}
                identityUrl={itarangWatch?.[idx]?.identityDocumentUrl ?? ""}
                identitySize={itarangWatch?.[idx]?.identityDocumentSize}
                onIdentityUploaded={(url, size) => {
                  setValue(
                    `itarangSigners.${idx}.identityDocumentUrl`,
                    url,
                    { shouldValidate: true, shouldDirty: true },
                  );
                  setValue(
                    `itarangSigners.${idx}.identityDocumentSize`,
                    size,
                    { shouldDirty: true },
                  );
                }}
                removable={idx >= DEFAULT_ITARANG_COUNT}
                onRemove={() => itarangGroup.remove(idx)}
              />
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => itarangGroup.append({ ...EMPTY_SIGNER })}
          className="btn-ghost inline-flex items-center gap-1.5 text-sm"
          data-testid="add-itarang-signer"
        >
          <Plus className="w-4 h-4" />
          Add another iTarang signatory
        </button>
      </section>

      {/* Agreement template upload */}
      <AgreementTemplateUpload
        nbfcId={nbfcId}
        master={master}
        nbfcSigners={nbfcWatch ?? []}
        itarangSigners={itarangWatch ?? []}
        templateUrl={watch("agreementTemplateUrl") ?? ""}
        templateSize={watch("agreementTemplateSize")}
        error={errors.agreementTemplateUrl?.message}
        onUploaded={(url, size) => {
          setValue("agreementTemplateUrl", url, {
            shouldValidate: true,
            shouldDirty: true,
          });
          setValue("agreementTemplateSize", size, { shouldDirty: true });
        }}
        register={register}
      />

      {submitError && (
        <div
          role="alert"
          data-testid="initiate-error"
          className="flex items-start gap-3 rounded-xl px-4 py-3 border"
          style={{
            background: "var(--color-danger-bg)",
            borderColor: "rgba(192, 57, 43, 0.3)",
            color: "var(--color-danger)",
          }}
        >
          <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
          <div className="text-sm min-w-0 flex-1">
            <p className="font-semibold">Couldn't send to CEO</p>
            <p className="opacity-90 break-words">{submitError}</p>
            {submitErrorPg?.code && (
              <p className="text-[11px] mt-1 font-mono opacity-80">
                Postgres {submitErrorPg.code}
                {submitErrorPg.constraint
                  ? ` · ${submitErrorPg.constraint}`
                  : ""}
              </p>
            )}
          </div>
        </div>
      )}

      {!locked && (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-2 border-t border-[color:var(--color-border)]">
          <div className="text-xs max-w-md space-y-1">
            <p className="text-[color:var(--color-ink-muted)]">
              On submit, the bundle is sent to the CEO for verification. Digio
              signing is triggered only after CEO approval.
            </p>
            {!canSubmit && (
              <p className="text-[color:var(--color-warning)] font-medium">
                {!hasValidNbfc
                  ? "Add one NBFC signatory with all fields + identity document."
                  : !hasValidItarang
                    ? "Add one iTarang signatory with all fields + identity document."
                    : !hasTemplate
                      ? "Upload the blank agreement template."
                      : ""}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2 justify-end">
            <a
              href={`/admin/nbfc/${nbfcId}/documents`}
              className="btn-ghost"
            >
              Back
            </a>
            <button
              type="submit"
              disabled={submitting || !canSubmit}
              aria-disabled={submitting || !canSubmit}
              className="btn-primary"
              data-testid="send-to-ceo-button"
            >
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              {submitting ? "Sending…" : "Send to CEO for Verification"}
            </button>
          </div>
        </div>
      )}
      </fieldset>
    </form>
  );
}

/**
 * AgreementTemplateUpload — single-file uploader for the blank/template
 * PDF the admin attaches at Step 3. Lives in the same module as the panel
 * because it consumes the same RHF context. PDF only, ≤ 15 MB.
 *
 * Uploaded state: two 3"×4" thumbnail cards side-by-side — Card A previews
 * the uploaded PDF, Card B previews the auto-filled details (signers +
 * NBFC master). Clicking either card opens AgreementPreviewModal with
 * the same content at full size.
 */
type PreviewVariant = "blank" | "autofilled";

interface SignerLike {
  fullName?: string;
  email?: string;
  designation?: string;
  identityDocumentUrl?: string;
  identityDocumentSize?: number;
}

function AgreementTemplateUpload({
  nbfcId,
  master,
  nbfcSigners,
  itarangSigners,
  templateUrl,
  templateSize,
  error,
  onUploaded,
  register,
}: {
  nbfcId: number;
  master: NbfcMasterSummary;
  nbfcSigners: SignerLike[];
  itarangSigners: SignerLike[];
  templateUrl: string;
  templateSize?: number;
  error?: string;
  onUploaded: (url: string, size: number) => void;
  register: ReturnType<typeof useForm<LspAgreementFormValues>>["register"];
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState<PreviewVariant | null>(null);

  const allSigners = [
    ...nbfcSigners.map((s) => ({ ...s, party: "nbfc" as const })),
    ...itarangSigners.map((s) => ({ ...s, party: "itarang" as const })),
  ];

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.currentTarget.files?.[0];
    if (!file) return;
    setUploadError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(
        `/api/admin/nbfc/${nbfcId}/lsp-agreement/agreement-template/upload`,
        { method: "POST", body: fd },
      );
      const body = (await res.json().catch(() => ({}))) as {
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
      onUploaded(body.fileUrl, body.size ?? file.size);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  const hasUpload = !!templateUrl;
  const displayName =
    fileName ??
    (hasUpload ? templateUrl.split("/").pop() ?? "Agreement template" : "");

  return (
    <section className="space-y-3">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p
            className="section-label"
            style={{ color: "var(--color-brand-sky)" }}
          >
            Agreement Document
          </p>
          <p className="text-xs text-[color:var(--color-ink-muted)] mt-0.5 max-w-2xl">
            Upload the blank agreement template (PDF, max 15 MB). It should
            contain the unfilled fields — signatory name, designation, date,
            company name, RBI registration number, etc. — that signers will
            complete in Digio.
          </p>
        </div>
        {hasUpload && (
          <span
            className="shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-full"
            style={{
              background: "var(--color-success-bg)",
              color: "var(--color-success)",
            }}
          >
            <CheckCircle2 className="w-3 h-3" />
            Ready
          </span>
        )}
      </header>

      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        className="sr-only"
        onChange={onFileChange}
        data-testid="agreement-template-input"
      />
      <input type="hidden" {...register("agreementTemplateUrl")} />

      {!hasUpload ? (
        // ─── Empty state: large, inviting drop zone ──────────────────────
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          data-testid="agreement-template-trigger"
          className="group w-full flex flex-col items-center justify-center gap-3 px-6 py-12 rounded-2xl border-2 border-dashed text-center transition-all disabled:opacity-60 hover:border-[color:var(--color-brand-sky)] hover:bg-[var(--brand-sky-soft,rgba(19,143,198,0.05))]"
          style={{
            borderColor: "var(--color-border)",
          }}
        >
          <div
            className="w-14 h-14 rounded-full flex items-center justify-center transition-colors group-hover:scale-105"
            style={{
              background: "var(--brand-sky-soft, rgba(19, 143, 198, 0.08))",
              color: "var(--color-brand-sky)",
            }}
          >
            {uploading ? (
              <Loader2 className="w-7 h-7 animate-spin" />
            ) : (
              <Upload className="w-7 h-7" />
            )}
          </div>
          <div>
            <p className="text-base font-semibold text-[color:var(--color-brand-navy)]">
              {uploading
                ? "Uploading agreement…"
                : "Drop your blank agreement here"}
            </p>
            <p className="text-xs text-[color:var(--color-ink-muted)] mt-1">
              or <span className="underline">click to browse</span> · PDF only ·
              max 15 MB
            </p>
          </div>
        </button>
      ) : (
        // ─── Uploaded state: side-by-side 3"×4" thumbnail cards ──────────
        <div className="space-y-3">
          <div className="flex flex-wrap gap-4">
            {/* Card A — Blank uploaded PDF thumbnail. Rendered as a
                clickable div (not <button>) so it remains interactive
                even when the surrounding <fieldset disabled> locks the
                form post-approval — viewing the document is always
                allowed; only mutations are locked. */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => setPreviewOpen("blank")}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setPreviewOpen("blank");
                }
              }}
              data-testid="agreement-blank-card"
              className="group relative rounded-xl overflow-hidden border-2 text-left transition-shadow hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-sky)] cursor-pointer"
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
                title={`Blank agreement preview: ${displayName}`}
                className="w-full block bg-[color:var(--color-bg)] pointer-events-none"
                style={{ height: 312, border: 0 }}
                tabIndex={-1}
              />
              <div
                className="absolute bottom-0 left-0 right-0 px-3 py-1.5 text-[10px] font-medium text-white flex items-center justify-between"
                style={{ background: "rgba(0,0,0,0.55)" }}
              >
                <span className="truncate">{displayName}</span>
                <span className="ml-2 opacity-80 group-hover:opacity-100">
                  Click to expand →
                </span>
              </div>
            </div>

            {/* Card B — Same PDF with auto-fill overlay. Same rationale
                as Card A: rendered as a div so the locked fieldset
                doesn't block the preview-expand click. */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => setPreviewOpen("autofilled")}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setPreviewOpen("autofilled");
                }
              }}
              data-testid="agreement-autofilled-card"
              className="group relative rounded-xl overflow-hidden border-2 text-left transition-shadow hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-sky)] cursor-pointer"
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
                  {allSigners.length} signer
                  {allSigners.length === 1 ? "" : "s"}
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
                  signers={allSigners}
                  compact
                />
              </div>
              <div
                className="absolute bottom-0 left-0 right-0 px-3 py-1.5 text-[10px] font-medium text-white flex items-center justify-between"
                style={{ background: "rgba(0,0,0,0.55)" }}
              >
                <span className="truncate">
                  Same template · with your data stamped on it
                </span>
                <span className="ml-2 opacity-80 group-hover:opacity-100">
                  Click to expand →
                </span>
              </div>
            </div>
          </div>

          {/* Actions below the cards — Replace + Open in new tab */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
              className="btn-ghost inline-flex items-center gap-1"
              data-testid="agreement-template-trigger"
            >
              {uploading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              Replace template
            </button>
          </div>

          {previewOpen && (
            <AgreementPreviewModal
              variant={previewOpen}
              templateUrl={templateUrl}
              fileName={displayName}
              master={master}
              signers={allSigners}
              onClose={() => setPreviewOpen(null)}
            />
          )}
        </div>
      )}

      {(error || uploadError) && (
        <p
          role="alert"
          className="inline-flex items-center gap-1 text-[11px] text-[color:var(--color-danger)]"
        >
          <AlertCircle className="w-3 h-3" />
          {uploadError ?? error}
        </p>
      )}
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * AgreementAutofillOverlay — translucent strips positioned on top of the
 * blank PDF iframe to indicate the values that will be filled in at signing
 * time. Renders a top header (company + RBI + date) and a bottom signature
 * panel (numbered signers with dotted signature lines). Plus a corner
 * "AUTO-FILLED" watermark badge. The compact prop trims paddings/sizes for
 * thumbnail rendering inside the 288×312 card body; the expanded variant is
 * used inside the modal.
 *
 * Exported so the CEO read-only review can render the same overlay on
 * top of the same PDF.
 */
export function AgreementAutofillOverlay({
  master,
  signers,
  compact = false,
}: {
  master: NbfcMasterSummary;
  signers: Array<SignerLike & { party: "nbfc" | "itarang" }>;
  compact?: boolean;
}) {
  const today = new Date().toLocaleDateString("en-IN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const dash = "—";

  // Show the first ~3 signers in the compact overlay; the rest get a "+N more"
  // chip so the bottom strip stays at a predictable height.
  const visibleSigners = compact ? signers.slice(0, 3) : signers;
  const hiddenCount = compact ? Math.max(0, signers.length - 3) : 0;

  return (
    <>
      {/* Top header strip — company / RBI / date */}
      <div
        className="absolute top-0 left-0 right-0 flex items-center justify-between gap-2 backdrop-blur-[2px]"
        style={{
          background: "rgba(19,143,198,0.92)",
          color: "#fff",
          padding: compact ? "4px 8px" : "10px 16px",
          fontSize: compact ? 9 : 12,
          lineHeight: 1.3,
        }}
      >
        <div className="min-w-0 flex-1">
          <p className="font-semibold truncate">
            {master.legalName || "[NBFC Legal Name]"}
          </p>
          <p className="opacity-90 truncate">
            RBI: {master.rbiRegistrationNo || dash}
          </p>
        </div>
        <div
          className="shrink-0 text-right"
          style={{ fontSize: compact ? 8 : 11 }}
        >
          <p className="opacity-80 uppercase tracking-wider">Date</p>
          <p className="font-semibold">{today}</p>
        </div>
      </div>

      {/* Corner watermark */}
      <div
        className="absolute font-bold uppercase tracking-widest pointer-events-none select-none"
        style={{
          top: compact ? 38 : 70,
          right: compact ? 6 : 18,
          fontSize: compact ? 8 : 14,
          color: "rgba(19,143,198,0.35)",
          transform: "rotate(-12deg)",
          border: "2px solid rgba(19,143,198,0.35)",
          padding: compact ? "2px 4px" : "4px 10px",
          borderRadius: 4,
        }}
      >
        Auto-filled
      </div>

      {/* Bottom signature panel */}
      <div
        className="absolute bottom-7 left-0 right-0 backdrop-blur-[2px]"
        style={{
          background: "rgba(255,255,255,0.92)",
          borderTop: "1px solid rgba(19,143,198,0.35)",
          padding: compact ? "4px 8px 6px" : "10px 18px 14px",
        }}
      >
        <p
          className="font-semibold uppercase tracking-wider mb-1"
          style={{
            fontSize: compact ? 8 : 11,
            color: "var(--color-brand-sky)",
            letterSpacing: "0.1em",
          }}
        >
          Signatories — Sequential
        </p>
        <ol className={compact ? "space-y-0.5" : "space-y-2"}>
          {visibleSigners.length === 0 && (
            <li
              className="italic text-[color:var(--color-ink-muted)]"
              style={{ fontSize: compact ? 9 : 12 }}
            >
              No signatories yet.
            </li>
          )}
          {visibleSigners.map((s, i) => (
            <li
              key={i}
              className="flex items-baseline gap-2"
              style={{ fontSize: compact ? 9 : 12, lineHeight: 1.25 }}
            >
              <span
                className="shrink-0 rounded-full flex items-center justify-center text-white font-bold"
                style={{
                  width: compact ? 12 : 18,
                  height: compact ? 12 : 18,
                  fontSize: compact ? 8 : 11,
                  background:
                    s.party === "nbfc"
                      ? "var(--color-brand-sky)"
                      : "var(--color-brand-teal)",
                }}
              >
                {i + 1}
              </span>
              <span className="flex-1 min-w-0 truncate">
                <span className="font-semibold">{s.fullName || dash}</span>
                <span className="text-[color:var(--color-ink-muted)]">
                  {" "}
                  · {s.designation || dash} ·{" "}
                  {s.party === "nbfc" ? "NBFC" : "iTarang"}
                </span>
              </span>
              <span
                className="shrink-0 italic text-[color:var(--color-ink-muted)]"
                style={{
                  borderBottom: "1px dashed var(--color-brand-silver)",
                  minWidth: compact ? 40 : 80,
                  fontSize: compact ? 8 : 10,
                }}
              >
                &nbsp;sig&nbsp;
              </span>
            </li>
          ))}
        </ol>
        {hiddenCount > 0 && (
          <p
            className="mt-0.5 italic text-[color:var(--color-ink-muted)]"
            style={{ fontSize: 8 }}
          >
            + {hiddenCount} more
          </p>
        )}
      </div>
    </>
  );
}

/**
 * AgreementAutofillSidebar — structured key-value table shown alongside the
 * full-size PDF in the modal so the admin sees both the visual ("on the
 * document") and the structured data ("the actual values being submitted").
 */
function AgreementAutofillSidebar({
  master,
  signers,
}: {
  master: NbfcMasterSummary;
  signers: Array<SignerLike & { party: "nbfc" | "itarang" }>;
}) {
  const today = new Date().toLocaleDateString("en-IN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const dash = "—";

  return (
    <aside className="w-80 shrink-0 border-l border-[color:var(--color-border)] bg-[color:var(--color-bg)] overflow-y-auto">
      <div className="p-4 space-y-4">
        <div>
          <p className="section-label">Auto-fill values</p>
          <h3 className="text-base font-semibold text-[color:var(--color-brand-navy)] mt-1">
            What will be stamped
          </h3>
        </div>

        <dl className="grid grid-cols-1 gap-y-2 text-xs">
          <div>
            <dt className="section-label-muted">Company</dt>
            <dd className="font-semibold text-[color:var(--color-brand-navy)] mt-0.5">
              {master.legalName || dash}
            </dd>
          </div>
          <div className="grid grid-cols-2 gap-x-3">
            <div>
              <dt className="section-label-muted">RBI Reg</dt>
              <dd className="font-mono text-[11px] mt-0.5">
                {master.rbiRegistrationNo || dash}
              </dd>
            </div>
            <div>
              <dt className="section-label-muted">Public ID</dt>
              <dd className="font-mono text-[11px] mt-0.5">
                {master.nbfcPublicId || dash}
              </dd>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-3">
            <div>
              <dt className="section-label-muted">CIN</dt>
              <dd className="font-mono text-[11px] mt-0.5">
                {master.cin || dash}
              </dd>
            </div>
            <div>
              <dt className="section-label-muted">GSTIN</dt>
              <dd className="font-mono text-[11px] mt-0.5">
                {master.gstNumber || dash}
              </dd>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-3">
            <div>
              <dt className="section-label-muted">PAN</dt>
              <dd className="font-mono text-[11px] mt-0.5">
                {master.panNumber || dash}
              </dd>
            </div>
            <div>
              <dt className="section-label-muted">Date</dt>
              <dd className="text-[11px] mt-0.5 font-semibold">{today}</dd>
            </div>
          </div>
        </dl>

        <div>
          <p className="section-label-muted mb-2">
            Signatories ({signers.length})
          </p>
          <ol className="space-y-2">
            {signers.length === 0 && (
              <li className="italic text-[11px] text-[color:var(--color-ink-muted)]">
                No signatories yet.
              </li>
            )}
            {signers.map((s, i) => (
              <li
                key={i}
                className="rounded-lg p-2 bg-[color:var(--color-surface)] border border-[color:var(--color-border)]"
              >
                <div className="flex items-center gap-2">
                  <span
                    className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white"
                    style={{
                      background:
                        s.party === "nbfc"
                          ? "var(--color-brand-sky)"
                          : "var(--color-brand-teal)",
                    }}
                  >
                    {i + 1}
                  </span>
                  <p className="text-xs font-semibold truncate flex-1">
                    {s.fullName || dash}
                  </p>
                </div>
                <p className="text-[11px] text-[color:var(--color-ink-muted)] mt-1 truncate">
                  {s.designation || dash} ·{" "}
                  {s.party === "nbfc" ? "NBFC" : "iTarang"}
                </p>
                {s.email && (
                  <p className="text-[10px] text-[color:var(--color-ink-muted)] truncate">
                    {s.email}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </aside>
  );
}

/**
 * AgreementPreviewModal — full-size view of either the uploaded blank PDF
 * or the auto-filled details document. Closes on Esc / backdrop click /
 * close button.
 */
function AgreementPreviewModal({
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
  signers: Array<SignerLike & { party: "nbfc" | "itarang" }>;
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
            {variant === "blank" && (
              <a
                href={templateUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-ghost text-xs inline-flex items-center gap-1"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Open in new tab
              </a>
            )}
            {/* Close button rendered as a div (not <button>) because
                the modal lives inside the locked <fieldset disabled> on
                read-only NBFCs — a real <button> would be disabled and
                trap the user in the modal. */}
            <div
              role="button"
              tabIndex={0}
              onClick={onClose}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onClose();
                }
              }}
              aria-label="Close preview"
              className="btn-ghost inline-flex items-center justify-center w-8 h-8 p-0 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </div>
          </div>
        </header>
        <div className="flex-1 flex overflow-hidden bg-[color:var(--color-bg)]">
          {variant === "blank" ? (
            <iframe
              src={`${templateUrl}#view=FitH`}
              title={`Agreement template: ${fileName}`}
              className="w-full h-full block"
              style={{ border: 0 }}
            />
          ) : (
            <>
              <div className="relative flex-1 min-w-0">
                <iframe
                  src={`${templateUrl}#view=FitH`}
                  title={`Auto-filled agreement: ${fileName}`}
                  className="w-full h-full block"
                  style={{ border: 0 }}
                />
                <AgreementAutofillOverlay master={master} signers={signers} />
              </div>
              <AgreementAutofillSidebar master={master} signers={signers} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
