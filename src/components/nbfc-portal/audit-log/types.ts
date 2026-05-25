/**
 * Shared types for the NBFC portal audit-log UI.
 * Mirrors the response shape of GET /api/nbfc/audit-log.
 */
export const ACTION_CODES = [
  "payment_reminder",
  "field_visit",
  "immobilisation",
  "battery_immobilisation",
  "loan_restructuring",
  "flag_for_recovery",
  "bulk_immobilisation",
  "pii_data_access",
  "audit_log_export",
  "risk_rule_threshold_change",
  "risk_score_run",
] as const;

export type ActionCode = (typeof ACTION_CODES)[number];

export const ACTION_LABELS: Record<string, string> = {
  payment_reminder: "Payment reminder",
  field_visit: "Field visit",
  immobilisation: "Immobilisation",
  battery_immobilisation: "Battery immobilisation (IoT)",
  loan_restructuring: "Loan restructuring",
  flag_for_recovery: "Flag for recovery",
  bulk_immobilisation: "Bulk immobilisation",
  pii_data_access: "PII access",
  audit_log_export: "Audit log export",
  risk_rule_threshold_change: "Risk rule threshold change",
  risk_score_run: "Risk score run",
};

export const STATUS_FILTERS = [
  { value: "", label: "All" },
  { value: "executed", label: "Executed" },
  { value: "approved", label: "Approved" },
  { value: "auto_approved", label: "Auto approved" },
  { value: "pending_dual_approval", label: "Pending approval" },
  { value: "rejected", label: "Rejected" },
] as const;

export interface AuditLogEntity {
  type: "loan" | "battery" | "lead" | "system";
  id: string | null;
  label: string | null;
}

export interface AuditLogUser {
  id: string | null;
  name: string | null;
  role: string | null;
}

export interface AuditLogRow {
  id: string;
  source: "audit_log" | "borrower_action" | "immobilisation_action";
  timestamp: string | null;
  entity: AuditLogEntity;
  action: string;
  action_label: string;
  reason_code: string | null;
  reason_text: string | null;
  requested_by: AuditLogUser;
  approved_by: AuditLogUser | null;
  status: string;
  before_state: unknown;
  after_state: unknown;
  borrower_notified_at: string | null;
  payload: unknown;
}

export interface AuditLogResponse {
  ok: boolean;
  items: AuditLogRow[];
  page: number;
  page_size: number;
  total: number;
  requesters: AuditLogUser[];
}

export interface AuditLogFiltersState {
  from: string;
  to: string;
  action: string;
  status: string;
  requestedBy: string;
  entityId: string;
}

export const EMPTY_FILTERS: AuditLogFiltersState = {
  from: "",
  to: "",
  action: "",
  status: "",
  requestedBy: "",
  entityId: "",
};

export function buildQueryString(
  filters: AuditLogFiltersState,
  extras: Record<string, string | number | undefined> = {},
): string {
  const sp = new URLSearchParams();
  if (filters.from) sp.set("from", filters.from);
  if (filters.to) sp.set("to", filters.to);
  if (filters.action) sp.set("action", filters.action);
  if (filters.status) sp.set("status", filters.status);
  if (filters.requestedBy) sp.set("requestedBy", filters.requestedBy);
  if (filters.entityId) sp.set("entityId", filters.entityId);
  for (const [k, v] of Object.entries(extras)) {
    if (v === undefined || v === "") continue;
    sp.set(k, String(v));
  }
  return sp.toString();
}

export function statusTone(status: string): {
  bg: string;
  text: string;
  dot: string;
  label: string;
} {
  const v = status.toLowerCase();
  if (v === "executed" || v === "approved" || v === "auto_approved") {
    return {
      bg: "bg-emerald-50",
      text: "text-emerald-700",
      dot: "bg-emerald-500",
      label: v === "auto_approved" ? "Auto-approved" : v === "executed" ? "Executed" : "Approved",
    };
  }
  if (v.startsWith("pending")) {
    return {
      bg: "bg-amber-50",
      text: "text-amber-800",
      dot: "bg-amber-500",
      label: "Pending",
    };
  }
  if (v === "rejected" || v === "expired") {
    return {
      bg: "bg-red-50",
      text: "text-red-700",
      dot: "bg-red-500",
      label: v === "expired" ? "Expired" : "Rejected",
    };
  }
  if (v === "logged") {
    return {
      bg: "bg-slate-100",
      text: "text-slate-700",
      dot: "bg-slate-400",
      label: "Logged",
    };
  }
  return {
    bg: "bg-slate-100",
    text: "text-slate-600",
    dot: "bg-slate-400",
    label: status.replace(/_/g, " "),
  };
}

export function entityTone(type: AuditLogEntity["type"]): { bg: string; text: string; label: string } {
  if (type === "loan") return { bg: "bg-sky-50", text: "text-sky-700", label: "Loan" };
  if (type === "battery") return { bg: "bg-indigo-50", text: "text-indigo-700", label: "Battery" };
  if (type === "lead") return { bg: "bg-violet-50", text: "text-violet-700", label: "Lead" };
  return { bg: "bg-slate-100", text: "text-slate-600", label: "System" };
}
