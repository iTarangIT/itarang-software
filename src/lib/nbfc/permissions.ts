/**
 * NBFC Custom RBAC — the 32-permission catalogue (BRD Addendum V0.3.1 §15.8 +
 * Appendix A) and the default permission set for each of the five system roles.
 *
 * Design (non-breaking, additive over the legacy role strings):
 *   • Permissions are the FINE-grained unit. `actor.can(permission)` is the new
 *     gate; the existing coarse `actor.role !== "..."` checks keep working
 *     because every actor still carries a `role` and the default map below
 *     reproduces exactly what each system role could already do.
 *   • System roles are CODE defaults (this file) — not seeded into the DB, so
 *     there is nothing to migrate or drift. Custom roles are DB-backed
 *     (`nbfc_roles` + `nbfc_role_permissions`, E-162) and a user opts into one
 *     via `nbfc_users.role_id`; until then they run on their `role` default.
 *
 * `offer.approve_deviation` (Appendix A, CEO column) is intentionally NOT here:
 * it is the platform-level iTarang CEO gate (§13.3.4, shipped in E-161), not an
 * NBFC custom-role permission. That is why the NBFC catalogue is 32, not 33.
 */
import type { NbfcOriginationRole } from "@/lib/nbfc/origination-roles";

export interface PermissionDef {
  key: string;
  label: string;
}
export interface PermissionGroup {
  key: string;
  label: string;
  permissions: PermissionDef[];
}

export const NBFC_PERMISSION_GROUPS: PermissionGroup[] = [
  {
    key: "lead",
    label: "Lead access",
    permissions: [
      { key: "lead.view_pipeline", label: "View all leads in pipeline" },
      { key: "lead.view_detail", label: "View per-lead detail (all sections)" },
      { key: "lead.view_activity", label: "Open Activity log" },
      { key: "audit.view_logs", label: "View audit logs" },
    ],
  },
  {
    key: "fi",
    label: "Field Investigation",
    permissions: [
      { key: "fi.assign", label: "Assign FI to an agent" },
      { key: "fi.dispatch", label: "Trigger FI form link dispatch" },
      { key: "fi.review", label: "Review FI submission → Pass/Fail/Re-inspect" },
      { key: "fi.reopen", label: "Reopen a closed FI decision" },
      { key: "fi.manage_agents", label: "Manage FI Agent directory" },
    ],
  },
  {
    key: "vkyc",
    label: "Video KYC",
    permissions: [
      { key: "vkyc.trigger", label: "Trigger VKYC / record VKYC outcome" },
      { key: "vkyc.edit_metadata", label: "Edit VKYC metadata (ref, notes)" },
      { key: "vkyc.flip_outcome", label: "Flip VKYC outcome (Pass↔Fail)" },
      { key: "vkyc.review", label: "Review VKYC review-state outcomes" },
      { key: "vkyc.reopen", label: "Reopen an auto-failed VKYC" },
    ],
  },
  {
    key: "enach",
    label: "E-NACH",
    permissions: [
      { key: "enach.register", label: "Trigger Register E-NACH" },
      { key: "enach.record_manual", label: "Record E-NACH result manually" },
      { key: "enach.waive", label: "Mark E-NACH Not Required (per-lead waiver)" },
    ],
  },
  {
    key: "offer",
    label: "Financing conditions",
    permissions: [
      { key: "offer.draft", label: "Draft a financing offer" },
      { key: "offer.submit", label: "Submit a financing offer (in-band)" },
      { key: "offer.withdraw", label: "Withdraw a submitted offer" },
      { key: "offer.edit_resubmit", label: "Edit & resubmit a submitted offer" },
      { key: "offer.view_decline_reason", label: "View losing-NBFC decline reason category" },
    ],
  },
  {
    key: "settings",
    label: "Settings — Configuration",
    permissions: [
      { key: "settings.wallet", label: "Edit Wallet auto-NACH config / Top-up" },
      { key: "settings.toggle_service", label: "Toggle a service (FI/VKYC/E-NACH) on/off" },
      { key: "settings.service_subpanels", label: "Configure service sub-panels" },
      { key: "settings.notification_channels", label: "Connect / edit Notification Channels" },
      { key: "settings.document_handling", label: "Edit Document Handling Preferences" },
      { key: "settings.track_rules", label: "Edit Track Rules" },
    ],
  },
  {
    key: "users_roles",
    label: "Users & Roles",
    permissions: [
      { key: "users.manage", label: "Add / edit / deactivate NBFC users" },
      { key: "roles.manage", label: "Create / edit / deactivate custom roles" },
      { key: "step_owners.manage", label: "Assign / change step-owners" },
    ],
  },
  {
    key: "reports",
    label: "Reports & oversight",
    permissions: [{ key: "reports.view", label: "View reports / dashboards" }],
  },
];

/** Flat list of every NBFC permission key (the 32-permission catalogue). */
export const NBFC_PERMISSIONS: string[] = NBFC_PERMISSION_GROUPS.flatMap((g) =>
  g.permissions.map((p) => p.key),
);

export const NBFC_PERMISSION_SET = new Set(NBFC_PERMISSIONS);

export function isValidPermission(key: string): boolean {
  return NBFC_PERMISSION_SET.has(key);
}

export function permissionLabel(key: string): string {
  for (const g of NBFC_PERMISSION_GROUPS) {
    const p = g.permissions.find((x) => x.key === key);
    if (p) return p.label;
  }
  return key;
}

const ADMIN_PERMISSIONS = [...NBFC_PERMISSIONS];

/**
 * Default permission set per system role — reproduces exactly what each role
 * could already do (Appendix A matrix), so layering permissions on top of the
 * existing role checks changes nothing for an un-customised tenant.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<NbfcOriginationRole, string[]> = {
  nbfc_admin: ADMIN_PERMISSIONS,
  credit_underwriting: [
    "lead.view_pipeline",
    "lead.view_detail",
    "lead.view_activity",
    "vkyc.trigger",
    "vkyc.edit_metadata",
    "vkyc.review",
    "vkyc.reopen",
    "enach.waive",
    "offer.draft",
    "offer.submit",
    "offer.edit_resubmit",
    "offer.view_decline_reason",
  ],
  fi_coordinator: [
    "lead.view_pipeline",
    "lead.view_detail",
    "lead.view_activity",
    "fi.assign",
    "fi.dispatch",
    "fi.review",
    "fi.manage_agents",
  ],
  operations: [
    "lead.view_pipeline",
    "lead.view_detail",
    "lead.view_activity",
    "vkyc.trigger",
    "vkyc.edit_metadata",
    "vkyc.review",
    "enach.register",
    "enach.record_manual",
  ],
  viewer: ["lead.view_pipeline", "lead.view_detail", "lead.view_activity", "audit.view_logs"],
};

/** The default permission set for a (possibly legacy/normalised) role string. */
export function defaultPermissionsForRole(role: string): string[] {
  return DEFAULT_ROLE_PERMISSIONS[role as NbfcOriginationRole] ?? DEFAULT_ROLE_PERMISSIONS.viewer;
}
