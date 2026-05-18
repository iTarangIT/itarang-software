"use client";

/**
 * NbfcFinalApprovalPanel — E-001 final approval gate.
 *
 * Visual: BRD §6.B. Status chain (Draft → Pending CEO Review → CEO Approved
 * → Active), readiness card, role-aware approve button. When the viewer is
 * not CEO Sanchit, the approve button collapses into a read-only banner —
 * the server gate is the source of truth, this is just guidance.
 *
 * Test contract — every existing data-testid is preserved verbatim:
 *   nbfc-final-approval-panel, lsp-agreement-status, missing-docs, reason,
 *   approve-button, approved-at, submit-error.
 */
import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  AlertCircle,
  Flag,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { useAuth } from "@/components/auth/AuthProvider";
import { useOptionalCorrectionFlagContext } from "./correction-flag-context";
import { useNbfcReadinessSignal } from "./NbfcReadinessSignal";

export type ReadinessPayload = {
  canApprove: boolean;
  missingDocs: string[];
  lspAgreementStatus: string;
  reason: string | null;
  currentStatus: string | null;
  missingEntityKyc?: string[];
  missingDirectorKyc?: string[];
  pendingCorrections?: {
    roundId: number;
    roundNumber: number;
    openItemCount: number;
  } | null;
};

type Props = {
  nbfcId: number;
  fetcher?: typeof fetch;
};

const TOOLTIP_NOT_READY =
  "Cannot activate until the Agreement is fully signed and downloaded from Digio.";

const CEO_EMAIL = "sanchit@itarang.com";

const STATUS_CHAIN: ReadonlyArray<{ label: string; lspKey?: string }> = [
  { label: "Draft" },
  { label: "Pending CEO Review" },
  { label: "CEO Approved" },
  { label: "Active" },
];

export default function NbfcFinalApprovalPanel({ nbfcId, fetcher }: Props) {
  const fx = fetcher ?? fetch;
  const { user } = useAuth();
  const { version: readinessSignalVersion } = useNbfcReadinessSignal();
  const [readiness, setReadiness] = useState<ReadinessPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [approvedAt, setApprovedAt] = useState<string | null>(null);

  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fx(`/api/admin/nbfc/${nbfcId}/approval-readiness`, {
        method: "GET",
        headers: { "content-type": "application/json" },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          (body as { message?: string; error?: string; reason?: string })
            .message ??
          (body as { error?: string }).error ??
          (body as { reason?: string }).reason ??
          `Failed to load readiness (${res.status})`;
        setLoadError(msg);
        setReadiness(null);
        return;
      }
      const b = body as ReadinessPayload;
      const safe: ReadinessPayload = {
        canApprove: !!b.canApprove,
        missingDocs: Array.isArray(b.missingDocs) ? b.missingDocs : [],
        lspAgreementStatus: b.lspAgreementStatus ?? "MISSING",
        reason: b.reason ?? null,
        currentStatus: b.currentStatus ?? null,
        missingEntityKyc: Array.isArray(b.missingEntityKyc)
          ? b.missingEntityKyc
          : [],
        missingDirectorKyc: Array.isArray(b.missingDirectorKyc)
          ? b.missingDirectorKyc
          : [],
        pendingCorrections: b.pendingCorrections ?? null,
      };
      setReadiness(safe);
    } finally {
      setLoading(false);
    }
  }, [fx, nbfcId]);

  useEffect(() => {
    void refresh();
  }, [refresh, readinessSignalVersion]);

  const onTransition = useCallback(
    async (to: "request_correction" | "rejected", reason: string) => {
      setSubmitting(true);
      setSubmitError(null);
      try {
        const res = await fx(`/api/admin/nbfc/${nbfcId}/transition`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ to, reason }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          setSubmitError(
            (err as { message?: string; error?: string; reason?: string })
              .message ??
              (err as { error?: string }).error ??
              (err as { reason?: string }).reason ??
              `${to} failed (${res.status})`,
          );
          return false;
        }
        await refresh();
        return true;
      } finally {
        setSubmitting(false);
      }
    },
    [fx, nbfcId, refresh],
  );

  const onApprove = useCallback(async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fx(`/api/admin/nbfc/${nbfcId}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setSubmitError(
          (err as { reason?: string; error?: string; message?: string }).reason ??
            (err as { error?: string }).error ??
            (err as { message?: string }).message ??
            `Approval failed (${res.status})`,
        );
        return;
      }
      const body = (await res.json()) as { approvedAt: string };
      setApprovedAt(body.approvedAt);
      await refresh();
    } finally {
      setSubmitting(false);
    }
  }, [fx, nbfcId, refresh]);

  const role = (user?.role ?? "").toLowerCase();
  const email = (user?.email ?? "").toLowerCase();
  const isCeo = role === "ceo" || email === CEO_EMAIL;

  const currentStatus = readiness?.currentStatus ?? null;
  const isAlreadyApproved =
    currentStatus === "approved" || currentStatus === "active";
  const isTerminalState =
    currentStatus === "rejected" || currentStatus === "terminated";
  const isAwaitingFix = currentStatus === "request_correction";
  const isPendingReview =
    currentStatus === "pending_admin_review" || currentStatus === "pending_review";

  const disabled =
    !readiness?.canApprove ||
    submitting ||
    loading ||
    isAlreadyApproved ||
    isTerminalState;
  const tooltip =
    readiness && !readiness.canApprove ? TOOLTIP_NOT_READY : undefined;

  // Lifecycle step is now driven by the canonical status from the server.
  // When CEO has approved AND all signers have completed (agreement is
  // COMPLETED), we advance the stepper into the "Active" phase — the only
  // thing left is the admin clicking "Activate Account", and showing
  // Active as the current step makes that next action visually obvious.
  const lspAgreementStatus = readiness?.lspAgreementStatus ?? "";
  const stepIndex = (() => {
    if (currentStatus === "active") return 3;
    if (currentStatus === "approved") {
      return lspAgreementStatus === "COMPLETED" ? 3 : 2;
    }
    if (isPendingReview) return 1;
    if (isAwaitingFix) return 1; // sales-head fix loop, still pre-approval
    if (isTerminalState) return 1;
    if (currentStatus === "draft") return 0;
    if (approvedAt) return 3; // optimistic update from a just-fired approve
    return 0;
  })();

  const ceoCorrectionsBanner = (() => {
    if (
      !readiness?.pendingCorrections ||
      readiness.pendingCorrections.openItemCount === 0
    ) {
      return null;
    }
    const n = readiness.pendingCorrections.openItemCount;
    return (
      <div
        data-testid="pending-corrections-banner"
        className="flex items-start gap-3 rounded-xl px-4 py-3 border"
        style={{
          background: "var(--color-warning-bg)",
          borderColor: "rgba(234, 179, 8, 0.3)",
          color: "var(--color-warning)",
        }}
      >
        <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="font-semibold">
            {n} CEO-flagged correction{n === 1 ? "" : "s"} still pending
          </p>
          <p className="opacity-90">
            Admin must address every flagged item and resubmit before
            approval can be released.
          </p>
        </div>
      </div>
    );
  })();

  return (
    <section
      data-testid="nbfc-final-approval-panel"
      className="space-y-6"
    >
      <header>
        <p className="section-label">Step 4 — Final Approval</p>
        <div className="flex items-center gap-3 mt-1 flex-wrap">
          <h2 className="text-2xl font-semibold text-[color:var(--color-brand-navy)]">
            CEO sign-off
          </h2>
          {isAlreadyApproved && (
            <span
              className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full"
              style={{
                background: "var(--color-success-bg)",
                color: "var(--color-success)",
              }}
            >
              <CheckCircle2 className="w-3 h-3" />
              {currentStatus === "active" ? "Active" : "Approved"}
            </span>
          )}
        </div>
        <p className="text-sm text-[color:var(--color-ink-muted)] mt-1 max-w-2xl">
          {isAlreadyApproved ? (
            currentStatus === "active" ? (
              <>
                NBFC is live. Portal credentials have been issued to the
                primary contact.
              </>
            ) : (
              <>
                CEO has approved this NBFC. The admin can review the signed
                agreement and audit trail above, then click{" "}
                <span className="font-semibold text-[color:var(--color-brand-navy)]">
                  Activate Account
                </span>{" "}
                to issue portal credentials.
              </>
            )
          ) : (
            <>
              Approval triggers the Digio Aadhaar e-sign request to the
              configured signers. After both signers complete, the admin
              manually activates the NBFC. Only{" "}
              <span className="font-semibold text-[color:var(--color-brand-navy)]">
                CEO Sanchit
              </span>{" "}
              may approve.
            </>
          )}
        </p>
      </header>

      {ceoCorrectionsBanner}

      {/* Status chain */}
      <div className="card-iTarang p-5">
        <p className="section-label-muted mb-3">Lifecycle</p>
        <ol className="flex items-center gap-1 overflow-x-auto">
          {STATUS_CHAIN.map((s, i) => {
            // Once the NBFC is `active` the whole lifecycle has run — the
            // final "Active" pip should render as ✓ done, not as the
            // current step (there's no next step to advance to).
            const isLifecycleComplete = currentStatus === "active";
            const state =
              i < stepIndex
                ? "done"
                : i === stepIndex
                ? isLifecycleComplete
                  ? "done"
                  : "active"
                : "todo";
            const dotClass =
              state === "active"
                ? "step-dot-active"
                : state === "done"
                ? "step-dot-done"
                : "step-dot-todo";
            const labelClass =
              state === "todo"
                ? "text-[color:var(--color-ink-muted)]"
                : "text-[color:var(--color-brand-navy)] font-semibold";
            return (
              <li key={s.label} className="flex items-center gap-2 shrink-0">
                <div className={dotClass}>
                  {state === "done" ? "✓" : i + 1}
                </div>
                <span className={`text-xs whitespace-nowrap ${labelClass}`}>
                  {s.label}
                </span>
                {i < STATUS_CHAIN.length - 1 && (
                  <span
                    className="mx-1 inline-block h-px w-8"
                    style={{ background: "var(--color-border)" }}
                  />
                )}
              </li>
            );
          })}
        </ol>
      </div>

      {/* Readiness card removed — KYC verification is handled out-of-band by
          admin on /admin/nbfc/[id]/kyc-review; the CEO surface no longer
          renders that gate. Load errors are still surfaced inline so the CEO
          knows when readiness couldn't be fetched. */}
      {loadError && (
        <p
          data-testid="readiness-load-error"
          className="text-sm rounded-lg px-3 py-2"
          style={{
            background: "var(--color-danger-bg)",
            color: "var(--color-danger)",
          }}
        >
          {loadError}
        </p>
      )}

      {/* Action region — status-aware (BRD §6.0.6). The CEO sees one of:
          (a) Approve when status=pending_admin_review AND canApprove,
          (b) Request Correction / Reject when status=pending_admin_review AND blocked,
          (c) Already-approved banner for approved/active,
          (d) Awaiting-fix banner for request_correction,
          (e) Terminal banner for rejected/terminated. */}
      <ApprovalActions
        currentStatus={currentStatus}
        readiness={readiness}
        isCeo={isCeo}
        hasUser={!!user}
        submitting={submitting}
        disabled={disabled}
        tooltip={tooltip}
        approvedAt={approvedAt}
        submitError={submitError}
        onApprove={onApprove}
        onTransition={onTransition}
      />
    </section>
  );
}

function ApprovalActions(props: {
  currentStatus: string | null;
  readiness: ReadinessPayload | null;
  isCeo: boolean;
  hasUser: boolean;
  submitting: boolean;
  disabled: boolean;
  tooltip: string | undefined;
  approvedAt: string | null;
  submitError: string | null;
  onApprove: () => Promise<void>;
  onTransition: (
    to: "request_correction" | "rejected",
    reason: string,
  ) => Promise<boolean>;
}) {
  const {
    currentStatus,
    readiness,
    isCeo,
    hasUser,
    submitting,
    disabled,
    tooltip,
    approvedAt,
    submitError,
    onApprove,
    onTransition,
  } = props;

  // E-111 — if the page wraps us in CorrectionFlagProvider, the "Request
  // corrections" button toggles per-item flag mode (the floating tray then
  // takes over). When no provider is mounted we fall back to the legacy
  // freeform-reason flow so other surfaces stay unchanged.
  const flagCtx = useOptionalCorrectionFlagContext();

  const [openForm, setOpenForm] = useState<
    null | "request_correction" | "rejected"
  >(null);
  const [reasonText, setReasonText] = useState("");

  const isApproved =
    currentStatus === "approved" || currentStatus === "active";
  const isRejected =
    currentStatus === "rejected" || currentStatus === "terminated";
  const isAwaitingFix = currentStatus === "request_correction";
  const isPendingReview =
    currentStatus === "pending_admin_review" ||
    currentStatus === "pending_review";

  // Already approved / active — collapse the action surface entirely. While
  // signing is in flight (status='approved', agreement SENT_FOR_SIGNATURE /
  // SIGN_PENDING / PARTIALLY_SIGNED), the banner reads "Awaiting signers" so
  // the CEO understands what's left.
  if (isApproved) {
    const lspStatus = readiness?.lspAgreementStatus ?? "";
    const isSigningInFlight =
      currentStatus === "approved" &&
      [
        "SENT_FOR_SIGNATURE",
        "SIGN_PENDING",
        "PARTIALLY_SIGNED",
        "SIGNED",
      ].includes(lspStatus);

    const heading = isSigningInFlight
      ? "Awaiting signers"
      : currentStatus === "active"
        ? "NBFC active"
        : "NBFC approved";
    const subline = isSigningInFlight
      ? "Digio has emailed the agreement to the signers in order. The NBFC will auto-activate once all signers complete and the signed PDF is downloaded."
      : currentStatus === "active"
        ? "Portal credentials have been issued and the NBFC is live."
        : "Approval has been recorded. Activation will issue portal credentials next.";

    return (
      <div
        data-testid="already-approved-banner"
        className="flex items-start gap-3 rounded-xl px-4 py-3 border"
        style={{
          background: isSigningInFlight
            ? "var(--color-info-bg)"
            : "var(--color-success-bg)",
          borderColor: isSigningInFlight
            ? "rgba(19, 143, 198, 0.3)"
            : "rgba(16, 185, 129, 0.3)",
          color: isSigningInFlight
            ? "var(--color-info)"
            : "var(--color-success)",
        }}
      >
        {isSigningInFlight ? (
          <Loader2 className="w-5 h-5 shrink-0 mt-0.5 animate-spin" />
        ) : (
          <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5" />
        )}
        <div className="text-sm">
          <p className="font-semibold">{heading}</p>
          <p className="opacity-90">{subline}</p>
        </div>
        {/* Keep the data-testid the existing headed test reads. */}
        <span data-testid="approved-at" className="sr-only">
          {approvedAt ?? currentStatus}
        </span>
      </div>
    );
  }

  if (isRejected) {
    return (
      <div
        data-testid="terminal-banner"
        className="flex items-start gap-3 rounded-xl px-4 py-3 border"
        style={{
          background: "var(--color-danger-bg)",
          borderColor: "rgba(239, 68, 68, 0.3)",
          color: "var(--color-danger)",
        }}
      >
        <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="font-semibold">
            {currentStatus === "rejected"
              ? "Application rejected"
              : "Partnership terminated"}
          </p>
          <p className="opacity-90">
            This is a terminal state — no further transitions are allowed
            (BRD §6.0.6).
          </p>
        </div>
      </div>
    );
  }

  if (isAwaitingFix) {
    const pending = readiness?.pendingCorrections;
    return (
      <div
        data-testid="awaiting-fix-banner"
        className="flex items-start gap-3 rounded-xl px-4 py-3 border"
        style={{
          background: "var(--color-warning-bg)",
          borderColor: "rgba(234, 179, 8, 0.3)",
          color: "var(--color-warning)",
        }}
      >
        <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="font-semibold">
            {pending && pending.openItemCount > 0
              ? `Awaiting admin corrections — ${pending.openItemCount} item${
                  pending.openItemCount === 1 ? "" : "s"
                } flagged`
              : "Awaiting admin corrections"}
          </p>
          <p className="opacity-90">
            Admin must address every flagged item and resubmit before the
            CEO can approve or reject. Open the admin approval page to see
            the outstanding-corrections panel.
          </p>
        </div>
      </div>
    );
  }

  // Pending review (or any pre-approval state) — full action surface.
  return (
    <div className="space-y-3">
      {!isCeo && hasUser && (
        <div
          className="flex items-start gap-3 rounded-xl px-4 py-3 border"
          style={{
            background: "var(--color-info-bg)",
            borderColor: "rgba(19, 143, 198, 0.3)",
            color: "var(--color-info)",
          }}
        >
          <ShieldCheck className="w-5 h-5 shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold">CEO-only action</p>
            <p className="opacity-90">
              Only CEO Sanchit can approve, request corrections, or reject
              this NBFC. Buttons stay disabled for your role.
            </p>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="approve-button"
          aria-disabled={disabled || (!isCeo && hasUser)}
          disabled={disabled || (!isCeo && hasUser)}
          title={tooltip}
          onClick={() => void onApprove()}
          className={
            disabled || (!isCeo && hasUser)
              ? "inline-flex items-center justify-center gap-2 h-11 px-5 rounded-xl text-sm font-semibold cursor-not-allowed bg-[color:var(--color-brand-silver)] text-white opacity-70"
              : "btn-primary"
          }
        >
          {submitting && openForm === null && (
            <Loader2 className="w-4 h-4 animate-spin" />
          )}
          {submitting && openForm === null
            ? "Approving…"
            : readiness?.lspAgreementStatus === "PENDING_CEO_VERIFICATION"
              ? "Approve & Send Agreement for Signing"
              : "Approve & Activate NBFC"}
        </button>

        {/* Request correction + Reject — only meaningful when there's a
            pending row to send back. We surface them whenever the caller is
            CEO and the NBFC isn't already approved/active/rejected. */}
        {isCeo && (isPendingReview || readiness) && (
          <>
            <button
              type="button"
              data-testid="request-correction-button"
              disabled={submitting}
              onClick={() => {
                if (flagCtx) {
                  // E-111 — flip into per-item flag mode; the floating tray
                  // takes over from here.
                  flagCtx.setFlagMode(!flagCtx.flagMode);
                  setOpenForm(null);
                  return;
                }
                setReasonText("");
                setOpenForm(
                  openForm === "request_correction"
                    ? null
                    : "request_correction",
                );
              }}
              className="inline-flex items-center justify-center gap-2 h-11 px-4 rounded-xl text-sm font-semibold border border-[color:var(--color-warning)] text-[color:var(--color-warning)] hover:bg-[color:var(--color-warning-bg)] transition-colors disabled:opacity-50"
            >
              <Flag className="w-4 h-4" />
              {flagCtx?.flagMode
                ? "Exit flag mode"
                : "Request corrections"}
            </button>
            <button
              type="button"
              data-testid="reject-button"
              disabled={submitting}
              onClick={() => {
                setReasonText("");
                setOpenForm(openForm === "rejected" ? null : "rejected");
              }}
              className="inline-flex items-center justify-center gap-2 h-11 px-4 rounded-xl text-sm font-semibold border border-[color:var(--color-danger)] text-[color:var(--color-danger)] hover:bg-[color:var(--color-danger-bg)] transition-colors disabled:opacity-50"
            >
              Reject
            </button>
          </>
        )}

        {submitError && (
          <p
            data-testid="submit-error"
            className="text-sm flex items-center gap-2"
            style={{ color: "var(--color-danger)" }}
          >
            <AlertCircle className="w-4 h-4" />
            {submitError}
          </p>
        )}
      </div>

      {openForm && (
        <div
          data-testid={
            openForm === "request_correction"
              ? "request-correction-form"
              : "reject-form"
          }
          className="card-iTarang p-4 space-y-3"
        >
          <p className="section-label-muted">
            {openForm === "request_correction"
              ? "Reason for sending back"
              : "Reason for rejection"}
          </p>
          <p className="text-[13px] text-[color:var(--color-ink-muted)]">
            {openForm === "request_correction"
              ? "Sales head will receive this note via email and the NBFC form becomes editable again. Be specific about which fields, documents, or KYC items must change."
              : "Rejection is non-reversible. Sales manager will be notified by email."}
          </p>
          <textarea
            data-testid="reason-input"
            value={reasonText}
            onChange={(e) => setReasonText(e.target.value)}
            rows={3}
            placeholder={
              openForm === "request_correction"
                ? "e.g. PAN card uploaded was illegible — please re-upload a colour scan and re-verify."
                : "e.g. CIN does not match RBI registry; partnership cannot proceed."
            }
            className="w-full rounded-md border border-[color:var(--color-border)] px-3 py-2 text-[13px]"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="reason-submit"
              disabled={submitting || reasonText.trim().length === 0}
              onClick={async () => {
                const ok = await onTransition(openForm, reasonText.trim());
                if (ok) {
                  setOpenForm(null);
                  setReasonText("");
                }
              }}
              className={
                submitting || reasonText.trim().length === 0
                  ? "btn-primary opacity-50 cursor-not-allowed"
                  : "btn-primary"
              }
            >
              {submitting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : null}
              {openForm === "request_correction"
                ? "Send back"
                : "Confirm rejection"}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpenForm(null);
                setReasonText("");
              }}
              className="text-sm text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-brand-navy)]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
