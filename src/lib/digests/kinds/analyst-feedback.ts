/**
 * AI Analyst review (251 item 9, 10 Nov change list) — Monday 09:00 mail to the weekly
 * review owner (Kartik): last week's thumbs-down answers, how many still wait on the
 * "Analyst review" page (E-380 analyst_feedback), and who flagged what. The page it links
 * to is where each one is closed.
 *
 * "Last week" = the seven IST days before the Monday the mail is built for (Mon–Sun).
 * Ships OFF with no recipients, like the other mails: add Kartik under Admin › Settings ›
 * Email reports › AI Analyst review.
 *
 * `db` is imported inside collect — listing the registry must not require DATABASE_URL.
 */

import type { DigestDetail, DigestFigures, DigestKindDescriptor, DigestSection, DigestTable } from "../types";

const SECTIONS: DigestSection[] = [
  {
    key: "summary",
    label: "Headline",
    hint: "Thumbs-down and thumbs-up answers given last week (Mon–Sun, IST).",
    group: "activity",
  },
  {
    key: "waiting",
    label: "Waiting for review",
    hint: "Thumbs-down answers from any week not yet closed on the Analyst review page.",
    group: "backlog",
  },
  {
    key: "flagged",
    label: "Flagged answers",
    hint: "Each thumbs-down from last week: who asked, when, the question and their note.",
    group: "activity",
  },
];

function shift(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The Mon–Sun week before `istDay` (the mail's own day); for a mid-week resend, the 7 days before it. */
export function lastWeek(istDay: string): { from: string; to: string } {
  return { from: shift(istDay, -7), to: shift(istDay, -1) };
}

async function collect(istDay: string): Promise<{ ok: boolean; figures: DigestFigures; error?: string }> {
  try {
    const [{ db }, { sql }, { hasFeedbackTable }] = await Promise.all([
      import("@/lib/db"),
      import("drizzle-orm"),
      import("@/lib/analyst/feedbackStore"),
    ]);
    if (!(await hasFeedbackTable())) {
      return { ok: false, figures: { activity: [], backlog: [] }, error: "analyst_feedback is missing (E-380 not applied)" };
    }
    const { from, to } = lastWeek(istDay);
    const totals = (await db.execute(sql`
      SELECT count(*) FILTER (WHERE rating = 'down')::int AS down,
             count(*) FILTER (WHERE rating = 'up')::int   AS up
        FROM analyst_feedback
       WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${from}::date AND ${to}::date
    `)) as unknown as Array<{ down: number; up: number }>;
    const waiting = (await db.execute(sql`
      SELECT count(*)::int AS n FROM analyst_feedback WHERE rating = 'down' AND status = 'new'
    `)) as unknown as Array<{ n: number }>;
    const flagged = (await db.execute(sql`
      SELECT to_char(f.created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon, HH12:MI am') AS at,
             COALESCE(u.name, u.email, f.user_id) AS who,
             left(regexp_replace(COALESCE(f.question, ''), '[[:space:]]+', ' ', 'g'), 160) AS question,
             left(COALESCE(f.comment, ''), 160) AS note,
             CASE f.status WHEN 'reviewed' THEN 'Reviewed' ELSE 'Waiting' END AS status
        FROM analyst_feedback f
        LEFT JOIN users u ON u.id::text = f.user_id
       WHERE f.rating = 'down'
         AND (f.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${from}::date AND ${to}::date
       ORDER BY f.created_at DESC
       LIMIT 50
    `)) as unknown as Array<{ at: string; who: string; question: string; note: string; status: string }>;

    const table: DigestTable = {
      key: "flagged",
      title: `Thumbs-down answers, ${from} to ${to} (IST)`,
      columns: ["When", "Asked by", "Question", "Their note", "Review"],
      rows: flagged.map((r) => [r.at, r.who, r.question, r.note || "—", r.status]),
      empty: "No answer was marked wrong last week.",
    };

    return {
      ok: true,
      figures: {
        activity: [
          { key: "summary", label: "Thumbs-down last week", value: totals[0]?.down ?? 0 },
          { key: "summary", label: "Thumbs-up last week", value: totals[0]?.up ?? 0 },
        ],
        backlog: [{ key: "waiting", label: "Thumbs-down still waiting for review (all weeks)", value: waiting[0]?.n ?? 0 }],
        tables: [table],
      },
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[digest:analyst_feedback] build failed:", error);
    return { ok: false, figures: { activity: [], backlog: [] }, error };
  }
}

/** The table is the detail; the review page has the question, answer and SQL. */
async function collectDetail(): Promise<{ ok: boolean; detail: DigestDetail; error?: string }> {
  return { ok: true, detail: {} };
}

export const analystFeedbackDigest: DigestKindDescriptor = {
  id: "analyst_feedback",
  label: "AI Analyst review",
  description:
    "One mail every Monday at 09:00: last week's thumbs-down answers from the AI Analyst (who asked, " +
    "the question and their note) and how many still wait on the Analyst review page. Meant for " +
    "the weekly review owner. Nothing is sent until recipients are added here.",
  settingsKey: "analyst_feedback_digest",
  settingsHref: "/admin/settings/analyst-feedback",
  ctaHref: "/ceo/analyst/feedback",
  ctaLabel: "Open Analyst review",
  sections: SECTIONS,
  slots: ["morning"],
  weekdays: [1],
  defaults: { enabled: false, recipients: [] },
  subject: () => `iTarang AI Analyst review: last week's flagged answers`,
  collect,
  collectDetail,
};
