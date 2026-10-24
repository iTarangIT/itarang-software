/**
 * Weekly Idle Leads digest (review R-15, Requirement #6 point 4) — Monday
 * morning: how many leads each person has been sitting on past their idle
 * limit, so a rising number is visible to their manager too.
 *
 * Every figure comes from summarizeNeedsAttention() (src/lib/leads/needsAttention.ts)
 * — the same query as the /admin/reports/needs-attention page the mail links
 * to, with the SAME per-role limits (ID 192 point 3 / ID 85 Decision 6):
 * inside sales from idle_cc working days (default 5), ASMs from idle_asm
 * (default 7); the second band is stale_critical (default 14). All three are
 * Admin › Time limits settings, read when the mail is built. Idle means no
 * work (call, visit or status change, E-300), no follow-up passed and no
 * handover in that many working days (FOLLOW_UP_AGEING_BASIS,
 * followUpAgeing.ts); a follow-up still ahead keeps a lead off the list.
 * Non-responsive leads (R-16) have their own column and are not idle. A
 * follow-up more than 30 days ahead is IGNORED (Kartik, 15 Oct), so those
 * leads are already inside "Idle past their limit": they are shown only as
 * "of which N with a follow-up over 30 days ahead" — never as a separate
 * count a reader could add on top (ID 192, 18 Oct rework 1).
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
    hint: "Leads idle past the limit (inside sales and ASM limits from Admin › Time limits), and past the critical limit.",
    group: "backlog",
  },
  {
    key: "by_holder",
    label: "By person",
    hint: "Per person holding leads: idle past their limit (of which with a follow-up over 30 days ahead), past the critical limit, the oldest, and non-responsive.",
    group: "backlog",
  },
];

// A snapshot of now: the covered day only labels the mail, so it is not read.
async function collect(): Promise<{ ok: boolean; figures: DigestFigures; error?: string }> {
  try {
    const [{ summarizeNeedsAttention }, { getTimeLimits }, { idleLimitLabel, staleCriticalShort }] = await Promise.all([
      import("@/lib/leads/needsAttention"),
      import("@/lib/timeLimits/store"),
      import("@/lib/timeLimits/labels"),
    ]);
    // Totals in SQL over every lead — never from a capped list. No minDays:
    // each holder is judged by their own role's limit, as on the page.
    const [holders, limits] = await Promise.all([summarizeNeedsAttention(), getTimeLimits()]);
    // ID 85 #5: each holder's critical count uses their role's band (summarizeNeedsAttention).
    const critical = staleCriticalShort(limits);
    const list = holders
      .map((h) => ({
        name: h.holder_name ?? h.holder_id,
        role: (h.holder_role ?? "").replace(/_/g, " "),
        idle: h.idle,
        critical: h.idle_over_14,
        oldest: h.oldest_days,
        dead: h.non_responsive,
        parked: h.parked,
      }))
      .filter((a) => a.idle || a.dead || a.parked)
      .sort((x, y) => y.idle - x.idle || x.name.localeCompare(y.name));
    const idle = list.reduce((s, a) => s + a.idle, 0);
    const crit = list.reduce((s, a) => s + a.critical, 0);
    const parked = list.reduce((s, a) => s + a.parked, 0);
    const limitLabel = idleLimitLabel(limits);

    const table: DigestTable = {
      key: "by_holder",
      title: `Idle leads by person (as of this morning) — ${limitLabel}`,
      columns: [
        "Held by",
        "Role",
        "Idle past their limit",
        "of which with a follow-up over 30 days ahead",
        `Idle ${critical}+ working days`,
        "Oldest (working days)",
        "Non-responsive",
      ],
      rows: list.map((a) => [a.name, a.role, a.idle, a.parked, a.critical, a.oldest, a.dead]),
      empty: `No lead is past its idle limit (${limitLabel}).`,
    };

    return {
      ok: true,
      figures: {
        activity: [],
        backlog: [
          { key: "summary", label: `Leads idle past the limit (${limitLabel})`, value: idle },
          { key: "summary", label: `Leads idle ${critical} or more working days`, value: crit },
          // Already inside the idle figure above — worded so nobody adds it on top.
          { key: "summary", label: "of which with a follow-up over 30 days ahead", value: parked },
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
    "One mail every Monday morning: how many leads each person has held past their idle " +
    "limit (inside sales and ASM limits from Admin › Time limits) with no work, follow-up or " +
    "handover, of which how many carry a follow-up over 30 days ahead, how many are past the " +
    "critical limit and who has non-responsive numbers. Nothing is sent until recipients are added here.",
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
