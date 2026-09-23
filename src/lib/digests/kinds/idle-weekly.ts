/**
 * Weekly Idle Leads digest (review R-15, Requirement #6 point 4) — Monday
 * morning: how many leads each person has been sitting on for more than 7
 * working days, so a rising number is visible to their manager too.
 *
 * Every figure comes from listNeedsAttention() (src/lib/leads/needsAttention.ts)
 * — the same query as the /admin/reports/needs-attention page the mail links
 * to — with the threshold pinned at 7 working days for everyone (the #6
 * wording: "count of leads idle over 7 days"). Idle means no call, visit or
 * status change (E-300). Non-responsive leads (R-16) are counted in their own
 * column and kept out of the idle figures.
 *
 * It is an as-of-now snapshot, not a period count, so `istDay` only labels the
 * mail. Ships OFF with no recipients, like the other sales mails.
 *
 * `db` (via listNeedsAttention) is imported inside collect — listing the
 * registry must not require DATABASE_URL (see kyc-review.ts).
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
    hint: "Total leads idle over 7 working days, and over 14.",
    group: "backlog",
  },
  {
    key: "by_holder",
    label: "By person",
    hint: "Per person holding leads: idle over 7 days, over 14 days, the oldest, and non-responsive.",
    group: "backlog",
  },
];

// A snapshot of now: the covered day only labels the mail, so it is not read.
async function collect(): Promise<{ ok: boolean; figures: DigestFigures; error?: string }> {
  try {
    const { summarizeNeedsAttention } = await import("@/lib/leads/needsAttention");
    // Totals in SQL over every lead — never from a capped list.
    const holders = await summarizeNeedsAttention({ minDays: 7 });
    const list = holders
      .map((h) => ({
        name: h.holder_name ?? h.holder_id,
        role: (h.holder_role ?? "").replace(/_/g, " "),
        over7: h.idle,
        over14: h.idle_over_14,
        oldest: h.oldest_days,
        dead: h.non_responsive,
      }))
      .sort((x, y) => y.over7 - x.over7 || x.name.localeCompare(y.name));
    const over7 = list.reduce((s, a) => s + a.over7, 0);
    const over14 = list.reduce((s, a) => s + a.over14, 0);

    const table: DigestTable = {
      key: "by_holder",
      title: "Idle leads by person (as of this morning)",
      columns: ["Held by", "Role", "Idle > 7 working days", "Idle > 14 working days", "Oldest (days)", "Non-responsive"],
      rows: list.map((a) => [a.name, a.role, a.over7, a.over14, a.oldest, a.dead]),
      empty: "No lead has been idle for more than 7 working days.",
    };

    return {
      ok: true,
      figures: {
        activity: [],
        backlog: [
          { key: "summary", label: "Leads idle over 7 working days", value: over7 },
          { key: "summary", label: "Leads idle over 14 working days", value: over14 },
        ],
        tables: [table],
      },
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[digest:idle_weekly] build failed:", error);
    return { ok: false, figures: { activity: [], backlog: [] }, error };
  }
}

/** The table is the detail; the page it links to has every lead. */
async function collectDetail(): Promise<{ ok: boolean; detail: DigestDetail; error?: string }> {
  return { ok: true, detail: {} };
}

export const idleWeeklyDigest: DigestKindDescriptor = {
  id: "idle_weekly",
  label: "Weekly Idle Leads",
  description:
    "One mail every Monday morning: how many leads each person has held for more than 7 " +
    "working days with no call, visit or status change, how many for more than 14, and " +
    "who has non-responsive numbers. Nothing is sent until recipients are added here.",
  settingsKey: "idle_weekly_digest",
  settingsHref: "/admin/settings/idle-weekly",
  ctaHref: "/admin/reports/needs-attention",
  ctaLabel: "Open Needs Attention",
  sections: SECTIONS,
  slots: ["morning"],
  // Monday. Weekly on purpose: a daily count of the same slow-moving backlog
  // would be read once and then filtered to a folder.
  weekdays: [1],
  defaults: { enabled: false, recipients: [] },
  subject: () => `iTarang Weekly Idle Leads`,
  collect,
  collectDetail,
};
