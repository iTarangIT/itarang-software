/**
 * NBFC onboarding progress derivation.
 *
 * The wizard has five steps (Master → Documents → LSP → Approval → Activation)
 * but `nbfc` has no `current_step` column — progress is fully derivable from
 * existing lifecycle signals:
 *   - Master: row exists (caller wouldn't be asking otherwise).
 *   - Documents: admin has *progressed past* the step — i.e. an LSP
 *     agreement row exists (`lspAgreementId` set) or has been signed. Mere
 *     uploads don't count: an admin who uploaded some/all docs but never
 *     initiated the LSP is still "on Step 2" and should land back there on
 *     Resume/Review (not be pushed forward to the LSP form). `hasDocuments`
 *     is kept on the signals interface for future read-only callers; it is
 *     intentionally unused by the activeStep calculation.
 *   - LSP: `nbfc.lsp_agreement_id` set OR a terminal `nbfc_lsp_agreements`
 *     row (COMPLETED / SIGNED). Initiating the LSP collapses both Documents
 *     and LSP into "done" in one transition — the admin's hand-off to CEO.
 *   - Approval: `nbfc.approved_at` stamped, or `status ∈ {approved, active}`.
 *   - Activation: `nbfc.activated_at` stamped, or `status === 'active'`.
 *
 * `activeStep` = the first step that isn't done. This is the "next step to
 * fill", matching the wizard ribbon's existing convention on every NBFC
 * subpage. Both the drafts list (Step column) and the review page (step
 * ribbon) call this so they can't drift.
 */
import type { StepKey } from "@/components/layout/PageShell";

const STEP_ORDER: ReadonlyArray<{ key: StepKey; label: string }> = [
  { key: "master", label: "Master" },
  { key: "documents", label: "Documents" },
  { key: "lsp", label: "Agreement" },
  { key: "approval", label: "Approval" },
  { key: "activation", label: "Activation" },
];

export interface NbfcProgressSignals {
  status: string;
  lspAgreementId: number | null;
  approvedAt: Date | string | null;
  activatedAt: Date | string | null;
  hasDocuments: boolean;
  lspSigned: boolean;
}

export interface NbfcProgress {
  doneSteps: StepKey[];
  activeStep: StepKey;
  currentStepNumber: number;
  currentStepLabel: string;
}

function isApproved(signals: NbfcProgressSignals): boolean {
  if (signals.approvedAt) return true;
  return signals.status === "approved" || signals.status === "active";
}

function isActivated(signals: NbfcProgressSignals): boolean {
  if (signals.activatedAt) return true;
  return signals.status === "active";
}

function isLspDone(signals: NbfcProgressSignals): boolean {
  return signals.lspSigned || signals.lspAgreementId != null;
}

/**
 * Map the wizard's active step to the page that owns it. Used by the
 * drafts list so the "Review" link drops the user on the page where they
 * actually need to do work (e.g. Documents step → /documents upload page),
 * instead of always going to /review (which is the CEO sign-off page and
 * only makes sense once the row reaches Step 4).
 */
export function getStepResumeUrl(step: StepKey, nbfcId: number): string {
  switch (step) {
    case "master":
      return `/admin/nbfc/${nbfcId}/edit`;
    case "documents":
      return `/admin/nbfc/${nbfcId}/documents`;
    case "lsp":
      return `/admin/nbfc/${nbfcId}/lsp-agreement`;
    case "approval":
    case "activation":
      return `/admin/nbfc/${nbfcId}/review`;
  }
}

/**
 * Step-ribbon href resolver. Currently a thin wrapper over
 * `getStepResumeUrl` — every step is accessible at any time. Kept as a
 * dedicated entry point so per-step gates can be reintroduced later
 * without touching every caller's `hrefForStep` prop.
 */
export function getStepNavHref(
  step: StepKey,
  nbfcId: number,
  _nbfcStatus: string | null | undefined,
): string | null {
  return getStepResumeUrl(step, nbfcId);
}

export function computeNbfcProgress(
  signals: NbfcProgressSignals,
): NbfcProgress {
  const stepDone: Record<StepKey, boolean> = {
    master: true,
    // Documents is "done" once the admin has progressed past it — i.e.
    // initiated/signed the LSP. Pure upload activity keeps the admin on
    // Step 2 so Resume/Review lands them back on /documents (current state),
    // not on the LSP form they haven't started yet.
    documents: isLspDone(signals),
    lsp: isLspDone(signals),
    approval: isApproved(signals),
    activation: isActivated(signals),
  };

  const doneSteps: StepKey[] = [];
  let activeIndex = STEP_ORDER.length - 1;
  for (let i = 0; i < STEP_ORDER.length; i++) {
    const key = STEP_ORDER[i].key;
    if (stepDone[key]) {
      doneSteps.push(key);
    } else {
      activeIndex = i;
      break;
    }
  }

  const active = STEP_ORDER[activeIndex];
  return {
    doneSteps,
    activeStep: active.key,
    currentStepNumber: activeIndex + 1,
    currentStepLabel: active.label,
  };
}
