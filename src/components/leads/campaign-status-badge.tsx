// Status pills for dialer campaigns. CampaignStatusBadge is for the parent
// (running / completed / stopped / failed); CampaignLeadStatusBadge is for
// per-lead status (pending / calling / completed / failed / skipped).
//
// Color scheme cloned from src/components/scraper/ExplorationStatusBadge.tsx
// to stay visually consistent with the scraper-runs UX.

import { Loader2, CheckCircle2, XCircle, Ban, Clock, PhoneCall } from "lucide-react";

type ParentStatus = "running" | "completed" | "stopped" | "failed";
type LeadStatus = "pending" | "calling" | "completed" | "failed" | "skipped";

const PARENT_STYLES: Record<
  ParentStatus,
  { bg: string; text: string; label: string; Icon?: any }
> = {
  running: {
    bg: "bg-amber-100",
    text: "text-amber-800",
    label: "Running",
    Icon: Loader2,
  },
  completed: {
    bg: "bg-emerald-100",
    text: "text-emerald-800",
    label: "Completed",
    Icon: CheckCircle2,
  },
  stopped: {
    bg: "bg-zinc-200",
    text: "text-zinc-700",
    label: "Stopped",
    Icon: Ban,
  },
  failed: {
    bg: "bg-rose-100",
    text: "text-rose-800",
    label: "Failed",
    Icon: XCircle,
  },
};

const LEAD_STYLES: Record<
  LeadStatus,
  { bg: string; text: string; label: string; Icon?: any; animate?: boolean }
> = {
  pending: {
    bg: "bg-gray-100",
    text: "text-gray-600",
    label: "Pending",
    Icon: Clock,
  },
  calling: {
    bg: "bg-emerald-100",
    text: "text-emerald-700",
    label: "Calling",
    Icon: PhoneCall,
    animate: true,
  },
  completed: {
    bg: "bg-blue-100",
    text: "text-blue-700",
    label: "Done",
    Icon: CheckCircle2,
  },
  failed: {
    bg: "bg-rose-100",
    text: "text-rose-700",
    label: "Failed",
    Icon: XCircle,
  },
  skipped: {
    bg: "bg-zinc-100",
    text: "text-zinc-500",
    label: "Skipped",
    Icon: Ban,
  },
};

export function CampaignStatusBadge({ status }: { status: string }) {
  const cfg =
    PARENT_STYLES[(status as ParentStatus) ?? "running"] ?? PARENT_STYLES.running;
  const Icon = cfg.Icon;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${cfg.bg} ${cfg.text}`}
    >
      {Icon ? (
        <Icon
          className={`w-3 h-3 ${status === "running" ? "animate-spin" : ""}`}
        />
      ) : null}
      {cfg.label}
    </span>
  );
}

export function CampaignLeadStatusBadge({ status }: { status: string }) {
  const cfg =
    LEAD_STYLES[(status as LeadStatus) ?? "pending"] ?? LEAD_STYLES.pending;
  const Icon = cfg.Icon;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${cfg.bg} ${cfg.text}`}
    >
      {Icon ? (
        <Icon
          className={`w-3 h-3 ${cfg.animate ? "animate-pulse" : ""}`}
        />
      ) : null}
      {cfg.label}
    </span>
  );
}

// Outcome chip — Bolna/ElevenLabs analysis pushes one of these strings into
// dialer_campaign_leads.call_outcome. Keep the mapping permissive so unknown
// outcomes still render as a neutral chip.
const OUTCOME_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  push_to_crm: {
    bg: "bg-emerald-50",
    text: "text-emerald-700",
    label: "Push to CRM",
  },
  qualified: {
    bg: "bg-emerald-50",
    text: "text-emerald-700",
    label: "Qualified",
  },
  schedule_call: {
    bg: "bg-amber-50",
    text: "text-amber-700",
    label: "Callback",
  },
  callback_requested: {
    bg: "bg-amber-50",
    text: "text-amber-700",
    label: "Callback",
  },
  uninterested: {
    bg: "bg-rose-50",
    text: "text-rose-700",
    label: "Uninterested",
  },
  no_answer: {
    bg: "bg-zinc-100",
    text: "text-zinc-600",
    label: "No answer",
  },
  no_transcript: {
    bg: "bg-zinc-100",
    text: "text-zinc-600",
    label: "No transcript",
  },
};

export function CampaignOutcomeBadge({ outcome }: { outcome: string | null }) {
  if (!outcome) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-zinc-100 text-zinc-500">
        —
      </span>
    );
  }
  const cfg = OUTCOME_STYLES[outcome] ?? {
    bg: "bg-zinc-100",
    text: "text-zinc-600",
    label: outcome.replace(/_/g, " "),
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${cfg.bg} ${cfg.text}`}
    >
      {cfg.label}
    </span>
  );
}
