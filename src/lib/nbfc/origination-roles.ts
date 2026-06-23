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

/**
 * Post-sanction Monitor/Recover roles for the two-person battery-immobilisation
 * gate (RBI Digital Lending Directions 2025). Kept separate from the
 * origination roles above: `nbfc_risk_manager` initiates immobilisation on the
 * partner dashboard, `nbfc_risk_head` approves it on the Risk Head dashboard.
 * These are assignable in Settings → Users alongside the origination roles.
 */
export const NBFC_MONITORING_ROLES = [
  "nbfc_risk_manager",
  "nbfc_risk_head",
] as const;

export type NbfcMonitoringRole = (typeof NBFC_MONITORING_ROLES)[number];

/**
 * Every system (non-custom) role a tenant admin may assign in Settings → Users:
 * the origination roles plus the Monitor/Recover roles. Used to validate the
 * invite payload. All are already permitted by the nbfc_users.role CHECK (E-133).
 */
export const NBFC_ASSIGNABLE_SYSTEM_ROLES = [
  ...NBFC_ORIGINATION_ROLES,
  ...NBFC_MONITORING_ROLES,
] as const;

/**
 * Normalises a raw `nbfc_users.role` to the canonical origination role. The NBFC
 * activation flow seeds the primary partner-owner with the legacy role 'admin'
 * (see /api/admin/nbfc/[nbfcId]/activate), but the origination RBAC layer (§7.2)
 * uses 'nbfc_admin' as the admin role across every action gate and the settings
 * page. Map the legacy value here so the account owner is recognised as admin
 * everywhere; absent/unknown roles fall back to the least-privileged 'viewer'.
 */
export function normalizeNbfcRole(role: string | null | undefined): string {
  if (!role) return "viewer";
  return role === "admin" ? "nbfc_admin" : role;
}

export const NBFC_ROLE_LABELS: Record<string, string> = {
  nbfc_admin: "NBFC Admin",
  credit_underwriting: "Credit / Underwriting",
  fi_coordinator: "FI Coordinator",
  operations: "Operations",
  viewer: "Viewer",
  nbfc_risk_manager: "Risk Manager",
  nbfc_risk_head: "Risk Head",
};

/** Origination steps that can carry a default + city-wise owner (§7.2). */
export const NBFC_OWNER_STEPS = ["fi", "vkyc", "enach"] as const;
export type NbfcOwnerStep = (typeof NBFC_OWNER_STEPS)[number];

export const NBFC_STEP_LABELS: Record<NbfcOwnerStep, string> = {
  fi: "Field Investigation",
  vkyc: "Active Video KYC",
  enach: "E-NACH",
};
