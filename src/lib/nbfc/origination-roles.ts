/**
 * BRD Addendum V0.2 §7.2 — NBFC origination-side RBAC.
 *
 * Five origination roles (extensible). Post-sanction roles (loan monitoring,
 * asset health, immobilisation) belong to Monitor/Recover and are out of scope
 * here — they remain the legacy telemetry-portal roles still present on some
 * nbfc_users rows, which the E-133 role CHECK keeps valid (added NOT VALID).
 *
 * "Roles are permissions": one user may hold several. Step ownership (who is
 * notified + accountable) is separate and lives in nbfc_step_owners.
 */
export const NBFC_ORIGINATION_ROLES = [
  "nbfc_admin",
  "credit_underwriting",
  "fi_coordinator",
  "operations",
  "viewer",
] as const;

export type NbfcOriginationRole = (typeof NBFC_ORIGINATION_ROLES)[number];

export const NBFC_ROLE_LABELS: Record<NbfcOriginationRole, string> = {
  nbfc_admin: "NBFC Admin",
  credit_underwriting: "Credit / Underwriting",
  fi_coordinator: "FI Coordinator",
  operations: "Operations",
  viewer: "Viewer",
};

/** Origination steps that can carry a default + city-wise owner (§7.2). */
export const NBFC_OWNER_STEPS = ["fi", "vkyc", "enach"] as const;
export type NbfcOwnerStep = (typeof NBFC_OWNER_STEPS)[number];

export const NBFC_STEP_LABELS: Record<NbfcOwnerStep, string> = {
  fi: "Field Investigation",
  vkyc: "Active Video KYC",
  enach: "E-NACH",
};
