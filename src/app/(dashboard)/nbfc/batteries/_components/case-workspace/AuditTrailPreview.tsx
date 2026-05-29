"use client";

interface Props {
  batteryCode: string;
  actionLabel: string;
  reason: string;
  requesterName?: string;
  approverChain?: string[];
  includesBorrowerNotice?: boolean;
}

export function AuditTrailPreview({
  batteryCode,
  actionLabel,
  reason,
  requesterName = "current user",
  approverChain = [],
  includesBorrowerNotice = false,
}: Props) {
  const parts = [
    "timestamp",
    batteryCode,
    actionLabel,
    reason || "(no reason)",
    `requested by ${requesterName}`,
    approverChain.length > 0
      ? `approver chain: ${approverChain.join(" → ")}`
      : "single approval",
    includesBorrowerNotice ? "borrower-notice record" : null,
  ].filter(Boolean) as string[];

  return (
    <div
      data-testid="audit-trail-preview"
      className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-3"
    >
      <p className="text-[10px] font-bold uppercase tracking-widest text-[color:var(--color-ink-muted)]">
        🗒 Audit trail preview
      </p>
      <p className="mt-1 text-xs text-[color:var(--color-ink)]">
        Will log: {parts.join(" · ")}
      </p>
    </div>
  );
}

export default AuditTrailPreview;
