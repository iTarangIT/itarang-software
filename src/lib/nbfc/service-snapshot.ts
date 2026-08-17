/**
 * E-133 / Addendum V0.2 §7.4 — freeze an NBFC's service-opt-in toggles at the
 * moment a lead binds to it, so a later config edit cannot retroactively change
 * an in-flight lead. Endpoint URLs and integration secrets are intentionally NOT
 * snapshotted — only the behavioural toggles that decide which tracks run —
 * because credentials must stay live-read and rotatable.
 *
 * Extracted from submit-product-selection when E-241 added a second writer of
 * nbfc_lead_assignments (reselect-financing). Two copies of this would drift the
 * first time a toggle is added, and a lead routed by the second path would then
 * carry a snapshot missing the field every reader expects.
 */
import type { nbfcServiceConfig } from "@/lib/db/schema";

type ServiceConfigRow = typeof nbfcServiceConfig.$inferSelect;

export function buildServiceSnapshot(
  cfg: ServiceConfigRow | undefined,
  capturedAt: Date,
) {
  return {
    fi_enabled: cfg?.fi_enabled ?? false,
    vkyc_enabled: cfg?.vkyc_enabled ?? false,
    vkyc_mode: cfg?.vkyc_mode ?? null,
    enach_enabled: cfg?.enach_enabled ?? false,
    enach_handoff_method: cfg?.enach_handoff_method ?? null,
    doc_agreement_method: cfg?.doc_agreement_method ?? null,
    // E-166 — which e-sign provider this lead's agreement uses (snapshotted;
    // credentials are read live). NULL ⇒ iTarang's global Digio account.
    esign_provider: cfg?.esign_provider ?? null,
    store_sanction_letter: cfg?.store_sanction_letter ?? false,
    store_loan_agreement: cfg?.store_loan_agreement ?? false,
    track_completion_gate: cfg?.track_completion_gate ?? true,
    track_failure_halts: cfg?.track_failure_halts ?? false,
    captured_at: capturedAt.toISOString(),
  };
}
