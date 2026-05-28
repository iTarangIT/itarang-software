/**
 * NbfcStatusBanner — top-of-page status alert for the CEO approval flow.
 *
 * Renders a colored banner mapped from the NBFC's current status so that
 * any viewer (admin sales-head, CEO, or auditor) opening /approval or
 * /review sees at a glance where the application stands:
 *
 *   pending_admin_review  → blue/info  "Application is under CEO verification"
 *   approved              → green       "Successfully approved on {date}"
 *   active                → green       "NBFC is active"
 *   request_correction    → orange      "Corrections requested by CEO"
 *   rejected              → red         "Application rejected by CEO"
 *   draft / anything else → renders nothing (banner is irrelevant)
 *
 * Pure presentational — accepts the values the server page already has.
 * Visual language matches the in-panel status banners used by
 * NbfcFinalApprovalPanel so the page feels uniform.
 */
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface BannerSpec {
  tone: "info" | "success" | "warning" | "danger";
  Icon: LucideIcon;
  title: string;
  subline: string;
}

function formatDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-IN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function specFor(
  status: string,
  approvedAt: Date | string | null | undefined,
  rejectionReason: string | null | undefined,
  pendingCorrectionCount: number,
): BannerSpec | null {
  const dateStr = formatDate(approvedAt);
  switch (status) {
    case "pending_admin_review":
      return {
        tone: "info",
        Icon: Clock,
        title: "Application is under CEO verification",
        subline:
          "The bundle has been submitted. CEO Sanchit is reviewing master details, compliance documents, signatories, and the agreement template before sign-off.",
      };
    case "approved":
      return {
        tone: "success",
        Icon: CheckCircle2,
        title: dateStr
          ? `Successfully approved on ${dateStr}`
          : "Successfully approved",
        subline:
          "Awaiting activation — portal credentials will be generated for the NBFC next.",
      };
    case "active":
      return {
        tone: "success",
        Icon: ShieldCheck,
        title: "NBFC is active",
        subline:
          "Portal credentials have been issued. The NBFC is visible to dealers in the loan-sanction dropdown.",
      };
    case "request_correction": {
      const title =
        pendingCorrectionCount > 0
          ? `CEO requested ${pendingCorrectionCount} correction${
              pendingCorrectionCount === 1 ? "" : "s"
            }`
          : "Corrections requested by CEO";
      const subline =
        pendingCorrectionCount > 0
          ? "Open the approval page to see every flagged item, fix them in the relevant step, then resubmit for CEO review."
          : (rejectionReason ??
            "Update Steps 1–3 with the requested changes and re-submit.");
      return {
        tone: "warning",
        Icon: AlertCircle,
        title,
        subline,
      };
    }
    case "rejected":
      return {
        tone: "danger",
        Icon: XCircle,
        title: "Application rejected by CEO",
        subline: rejectionReason ?? "See the CEO's notes for details.",
      };
    default:
      return null;
  }
}

const TONE_STYLES: Record<BannerSpec["tone"], {
  bg: string;
  border: string;
  fg: string;
}> = {
  info: {
    bg: "var(--brand-sky-soft, rgba(19, 143, 198, 0.12))",
    border: "var(--color-brand-sky)",
    fg: "var(--color-brand-sky)",
  },
  success: {
    bg: "var(--color-success-bg)",
    border: "var(--color-success)",
    fg: "var(--color-success)",
  },
  warning: {
    bg: "var(--color-warning-bg)",
    border: "var(--color-warning)",
    fg: "var(--color-warning)",
  },
  danger: {
    bg: "var(--color-danger-bg)",
    border: "var(--color-danger)",
    fg: "var(--color-danger)",
  },
};

export interface NbfcStatusBannerProps {
  status: string;
  approvedAt?: Date | string | null;
  rejectionReason?: string | null;
  /** E-111 — when status='request_correction', count of pending items in the
   * latest open round. Drives a more specific banner title. */
  pendingCorrectionCount?: number;
}

export default function NbfcStatusBanner({
  status,
  approvedAt,
  rejectionReason,
  pendingCorrectionCount = 0,
}: NbfcStatusBannerProps) {
  const spec = specFor(
    status,
    approvedAt,
    rejectionReason,
    pendingCorrectionCount,
  );
  if (!spec) return null;

  const tone = TONE_STYLES[spec.tone];
  const { Icon } = spec;

  return (
    <div
      role="status"
      data-testid={`nbfc-status-banner-${status}`}
      className="rounded-2xl p-5 md:p-6 flex items-start gap-4 border-l-4"
      style={{
        background: tone.bg,
        borderLeftColor: tone.border,
        border: `1px solid ${tone.border}`,
        borderLeftWidth: 4,
      }}
    >
      <div
        className="shrink-0 w-11 h-11 rounded-full flex items-center justify-center"
        style={{
          background: "rgba(255,255,255,0.7)",
          color: tone.fg,
        }}
      >
        <Icon className="w-6 h-6" />
      </div>
      <div className="min-w-0 flex-1">
        <h3
          className="text-base md:text-lg font-semibold"
          style={{ color: tone.fg }}
        >
          {spec.title}
        </h3>
        <p
          className="text-sm mt-1 opacity-90"
          style={{ color: "var(--color-ink)" }}
        >
          {spec.subline}
        </p>
      </div>
    </div>
  );
}
