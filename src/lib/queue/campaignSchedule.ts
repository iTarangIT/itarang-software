// E-228 + E-254 — the AI dialer calling window: the PURE half.
//
// Vocabulary, validation and formatting only. This file imports NOTHING with a
// runtime cost and, in particular, nothing that touches the database.
//
// The split is not cosmetic. campaign-detail-view.tsx and campaign-window-picker
// .tsx are client components that need formatWindow / the mode vocabulary, and
// the server half imports `@/lib/db` at module scope — so a single file would
// drag Drizzle and the postgres client into the browser bundle. It is also what
// lets vitest cover this logic at all: the suite is deliberately scoped to
// no-I/O modules, because a module that opens a connection on import does so
// during test collection.
//
// Server-side callers should keep importing from ./campaignWindow, which
// re-exports everything here alongside the SQL predicates.

import { z } from "zod";

// Same seven strings as jobQueue.WEEKDAYS and assignment_config.working_days.
// Matched against lower(to_char(<ts>, 'dy')), which yields mon/tue/….
export const WEEKDAYS = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

// 'now'       — unscheduled. Dial continuously, exactly as before E-228.
// 'single'    — dial inside the window, then pause to 'paused' and stay there.
// 'recurring' — dial inside the window every listed day, auto-resuming.
export const SCHEDULE_MODES = ["now", "single", "recurring"] as const;
export type ScheduleMode = (typeof SCHEDULE_MODES)[number];

export interface CampaignSchedule {
  mode: ScheduleMode;
  window_start?: string | null; // 'HH:MM' IST
  window_end?: string | null; // 'HH:MM' IST
  window_days?: Weekday[] | null; // null = every day
}

// ── validation ─────────────────────────────────────────────────────────────

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// Mirrors ScheduleSchema in src/app/api/scraper/batch/route.ts:37-74 — same
// HH:MM regex, same both-or-neither rule, same zero-length-window rejection.
// Kept as its own schema rather than shared because the mode vocabularies
// deliberately differ (see the E-254 migration header).
export const campaignScheduleSchema = z
  .object({
    mode: z.enum(SCHEDULE_MODES).default("now"),
    window_start: z.string().regex(HHMM, "must be HH:MM").optional().nullable(),
    window_end: z.string().regex(HHMM, "must be HH:MM").optional().nullable(),
    window_days: z.array(z.enum(WEEKDAYS)).min(1).optional().nullable(),
  })
  .superRefine((s, ctx) => {
    if (s.mode === "now") return;
    if (!s.window_start || !s.window_end) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["window_start"],
        message: `window_start and window_end are both required when mode is '${s.mode}'`,
      });
      return;
    }
    if (s.window_start === s.window_end) {
      // Equal bounds are ambiguous: under the wrap-aware predicate they read as
      // a zero-length window, so the campaign would pause immediately and never
      // wake, with nothing to say why. Reject at the door instead.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["window_end"],
        message:
          "window_start and window_end cannot be the same time — that is a zero-length window",
      });
    }
  });

export type ValidatedSchedule = z.infer<typeof campaignScheduleSchema>;

/** The four columns a validated schedule writes. Call sites spread this into an
 *  insert so none of them has to remember the mode↔columns coupling: a 'now'
 *  campaign stores NULL windows, so the row can never lie about itself the way
 *  a stale 09:00-18:00 on a "run now" job would. */
export function scheduleColumns(s: ValidatedSchedule | null | undefined) {
  if (!s || s.mode === "now") {
    return {
      schedule_mode: "now",
      window_start: null,
      window_end: null,
      window_days: null,
    };
  }
  return {
    schedule_mode: s.mode,
    window_start: s.window_start ?? null,
    window_end: s.window_end ?? null,
    // 'single' has no recurrence, so weekdays are meaningless for it. Storing
    // them anyway would make the campaign card claim a Mon–Fri schedule for a
    // run that happens exactly once.
    window_days: s.mode === "recurring" ? (s.window_days ?? null) : null,
  };
}

export const FALLBACK_DEFAULTS: {
  window_start: string;
  window_end: string;
  window_days: Weekday[];
} = {
  window_start: "09:00",
  window_end: "19:00",
  window_days: ["mon", "tue", "wed", "thu", "fri", "sat"],
};

/** '09:00:00' (assignment_config's varchar(8)) -> '09:00' (the window
 *  columns' varchar(5)). Exported because the server half's defaults lookup is
 *  the only caller today, but the narrowing is a property of the vocabulary. */
export function toHHMM(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const hh = m[1].padStart(2, "0");
  return Number(hh) > 23 ? null : `${hh}:${m[2]}`;
}

// ── display ────────────────────────────────────────────────────────────────

const DAY_LABEL: Record<Weekday, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

/** "11:00–15:00 IST · Mon–Sat · Recurring", or null when unscheduled. Shared by
 *  the campaign table and the detail header so the two cannot describe the same
 *  row differently. Mirrors scheduleLabel() in
 *  src/components/scraper/ScraperQueuePanel.tsx. */
export function formatWindow(c: {
  schedule_mode?: string | null;
  window_start?: string | null;
  window_end?: string | null;
  window_days?: unknown;
}): string | null {
  const mode = (c.schedule_mode ?? "now") as ScheduleMode;
  if (mode === "now" || !c.window_start || !c.window_end) return null;

  const parts = [`${c.window_start}–${c.window_end} IST`];
  if (mode === "recurring") {
    const days = Array.isArray(c.window_days)
      ? (c.window_days as string[]).filter((d): d is Weekday =>
          (WEEKDAYS as readonly string[]).includes(d),
        )
      : [];
    parts.push(
      days.length === 0 || days.length === 7 ? "Every day" : compactDays(days),
    );
    parts.push("Recurring");
  } else {
    parts.push("Single run");
  }
  return parts.join(" · ");
}

// "Mon–Sat" for a contiguous run in week order, "Mon, Wed, Fri" otherwise.
function compactDays(days: Weekday[]): string {
  const idx = days.map((d) => WEEKDAYS.indexOf(d)).sort((a, b) => a - b);
  const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  if (contiguous && idx.length > 2) {
    return `${DAY_LABEL[WEEKDAYS[idx[0]]]}–${DAY_LABEL[WEEKDAYS[idx[idx.length - 1]]]}`;
  }
  return idx.map((i) => DAY_LABEL[WEEKDAYS[i]]).join(", ");
}
