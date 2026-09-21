/**
 * Targets Pending digest (review R-17, sheet 8, Requirement #15) — every
 * morning: sales targets that were pushed to someone more than 48 hours ago
 * and still not accepted. #15: "unaccepted after 48h → daily email to Admin +
 * Sales Head". Recipients are configured on its settings screen; it ships OFF.
 *
 * A snapshot of now, so `istDay` only labels the mail. When nothing is overdue
 * the mail says so in one line rather than not arriving — silence would be
 * indistinguishable from a broken sender.
 */

import type {
  DigestDetail,
  DigestFigures,
  DigestKindDescriptor,
  DigestSection,
  DigestTable,
} from "../types";

const SECTIONS: DigestSection[] = [
  {
    key: "summary",
    label: "Headline",
    hint: "How many people have targets pushed over 48 hours ago and not accepted.",
    group: "backlog",
  },
  {
    key: "overdue",
    label: "Who",
    hint: "Each person, the month, how many targets, and how long ago they were pushed.",
    group: "backlog",
  },
];

// A snapshot of now: the covered day only labels the mail, so it is not read.
async function collect(): Promise<{ ok: boolean; figures: DigestFigures; error?: string }> {
  try {
    const { overdueAcceptance } = await import("@/lib/targets/service");
    const rows = await overdueAcceptance();
    const table: DigestTable = {
      key: "overdue",
      title: "Targets not accepted within 48 hours",
      columns: ["Person", "Month", "Targets", "Hours since pushed"],
      rows: rows.map((r) => [r.user_name ?? "(unknown user)", r.month.slice(0, 7), r.targets, r.hours]),
      empty: "Everyone has accepted their targets.",
    };
    return {
      ok: true,
      figures: {
        activity: [],
        backlog: [{ key: "summary", label: "People with unaccepted targets (48h+)", value: rows.length }],
        tables: [table],
      },
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[digest:targets_pending] build failed:", error);
    return { ok: false, figures: { activity: [], backlog: [] }, error };
  }
}

async function collectDetail(): Promise<{ ok: boolean; detail: DigestDetail; error?: string }> {
  return { ok: true, detail: {} };
}

export const targetsPendingDigest: DigestKindDescriptor = {
  id: "targets_pending",
  label: "Targets Pending",
  description:
    "One mail every morning listing anyone whose sales targets were pushed more than 48 hours " +
    "ago and are still not accepted. Nothing is sent until recipients are added here — add the " +
    "admins and the sales head.",
  settingsKey: "targets_pending_digest",
  settingsHref: "/admin/settings/targets-pending",
  ctaHref: "/admin/targets",
  ctaLabel: "Open Targets",
  sections: SECTIONS,
  slots: ["morning"],
  defaults: { enabled: false, recipients: [] },
  subject: () => `iTarang Targets Pending Acceptance`,
  collect,
  collectDetail,
};
