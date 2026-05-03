"use client";

/**
 * AuditLogPreview
 *
 * Renders the "Will log: …" disclosure card before the admin confirms a
 * borrower-impacting action (locker disable, EMI extension, etc).
 *
 * BRD ref: Section 6.4.2 — Audit Log Entry Preview. The seven disclosed
 * fields must match what the audit_logs writer will actually persist:
 *   timestamp · IMEI · action · reason · requested_by · approver ·
 *   borrower_notice_record
 *
 * The component is intentionally pure-presentational: callers POST to
 * /api/nbfc/audit-log/preview, pass the resulting `will_log` object in, and
 * own the Confirm/Cancel buttons. That keeps this card reusable across the
 * collections page, the dual-approval modal, and the borrower-notice flow.
 */
import * as React from "react";

export interface WillLog {
  timestamp: string;
  imei: string | null;
  action: string;
  reason: string;
  requested_by: { user_id: string; display_name: string };
  approver: { user_id: string | null; display_name: string | null };
  borrower_notice_record: { id: string | null; channel: string | null };
}

export interface AuditLogPreviewProps {
  willLog: WillLog;
  className?: string;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-right font-mono text-foreground break-all">{value}</span>
    </div>
  );
}

export function AuditLogPreview({ willLog, className }: AuditLogPreviewProps) {
  return (
    <div
      className={
        "rounded-md border border-amber-300 bg-amber-50 p-4 " + (className ?? "")
      }
      data-testid="audit-log-preview"
      role="region"
      aria-label="Audit log entry preview"
    >
      <div className="mb-2 text-sm font-semibold text-amber-900">
        Will log (audit_logs):
      </div>
      <div className="divide-y divide-amber-200">
        <Row label="timestamp" value={willLog.timestamp} />
        <Row label="IMEI" value={willLog.imei ?? "—"} />
        <Row label="action" value={willLog.action} />
        <Row label="reason" value={willLog.reason} />
        <Row
          label="requested_by"
          value={`${willLog.requested_by.display_name} (${willLog.requested_by.user_id})`}
        />
        <Row
          label="approver"
          value={
            willLog.approver.user_id
              ? `${willLog.approver.display_name ?? "?"} (${willLog.approver.user_id})`
              : "—"
          }
        />
        <Row
          label="borrower_notice_record"
          value={
            willLog.borrower_notice_record.id
              ? `${willLog.borrower_notice_record.id}${
                  willLog.borrower_notice_record.channel
                    ? ` · ${willLog.borrower_notice_record.channel}`
                    : ""
                }`
              : "—"
          }
        />
      </div>
      <p className="mt-3 text-xs text-amber-800">
        This entry is written to <code>audit_logs</code> only after you confirm.
      </p>
    </div>
  );
}

export default AuditLogPreview;
