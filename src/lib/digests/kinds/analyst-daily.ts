/**
 * AI Analyst morning questions (251 item 23) — one mail per person at 09:00 IST with fresh
 * answers to the questions they asked to have emailed ("Email me this every morning", the
 * envelope under an answer; E-385 analyst_daily_questions, at most 5 each).
 *
 * Personal: only people with a live morning question are mailed, each with their own
 * questions, each person claimed on their own (digest_person_runs, E-353). Each question is
 * asked afresh on the agent with the same rules as on screen (src/lib/analyst/askOnce.ts).
 * A person whose every question failed is retried by the ticker; one failed question among
 * several is reported in the mail instead.
 *
 * On by default: nobody gets it until they press the envelope themselves. The settings
 * screen can switch it off for everyone or move the time.
 *
 * Imports are inside the functions — listing the registry must not need DATABASE_URL or the
 * agent's credentials.
 */

import type {
  DigestDetail,
  DigestFigures,
  DigestKindDescriptor,
  DigestPerson,
  DigestSection,
  DigestTable,
} from "../types";

const SECTIONS: DigestSection[] = [
  {
    key: "answers",
    label: "Your questions, answered this morning",
    hint: "Each morning question asked afresh on the AI Analyst: its answer and the table it returned.",
    group: "activity",
  },
  {
    key: "list",
    label: "Questions on your morning list",
    hint: "How many questions this person has asked to have emailed each morning.",
    group: "backlog",
  },
];

/** Who can use the AI Analyst (lib/analyst/access.ts ANALYST_ROLES). */
const ROLES = ["ceo", "sales_head", "admin"] as const;

const MAX_ROWS = 30;
const MAX_ANSWER_CHARS = 1500;

/** The answer as plain text for the mail: markdown marks out, one paragraph. */
export function plainAnswer(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\*\*|__|`/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > MAX_ANSWER_CHARS ? `${plain.slice(0, MAX_ANSWER_CHARS - 1)}…` : plain;
}

/** A result cell as mail text. */
export function cellText(value: unknown): string | number {
  if (value == null) return "—";
  if (typeof value === "number") return Number.isFinite(value) ? value : "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 119)}…` : value;
  const json = JSON.stringify(value);
  return json.length > 120 ? `${json.slice(0, 119)}…` : json;
}

function istNow(): { day: string; label: string } {
  const now = new Date();
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
  const label = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(now);
  return { day, label };
}

async function people(): Promise<DigestPerson[]> {
  const { hasDailyTable, dailyPeople } = await import("@/lib/analyst/dailyStore");
  if (!(await hasDailyTable())) return [];
  return dailyPeople(ROLES);
}

async function collectFor(
  _istDay: string,
  person: DigestPerson,
): Promise<{ ok: boolean; figures: DigestFigures; error?: string }> {
  const empty: DigestFigures = { activity: [], backlog: [] };
  try {
    const [{ listDaily }, { askOnce }, { analystConfigured }] = await Promise.all([
      import("@/lib/analyst/dailyStore"),
      import("@/lib/analyst/askOnce"),
      import("@/lib/analyst/client"),
    ]);
    if (!analystConfigured()) return { ok: false, figures: empty, error: "the AI Analyst is not configured on this server" };
    const questions = await listDaily(person.id);
    if (questions.length === 0) return { ok: false, figures: empty, error: "no morning questions any more" };

    const now = istNow();
    // At most five, asked side by side: one slow answer must not hold the others.
    const asked = await Promise.all(
      questions.map((q) =>
        askOnce({ connectionId: q.connection_id, threadId: `crm.daily.${q.id}.${now.day}`, question: q.question }).catch(
          (err: unknown) => ({
            answer: "",
            columns: [] as string[],
            rows: [] as unknown[][],
            truncated: false,
            runId: null,
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
      ),
    );

    const answered = asked.filter((a) => !a.error).length;
    if (answered === 0) {
      return { ok: false, figures: empty, error: `no question could be answered: ${asked[0]?.error ?? "unknown"}` };
    }

    const tables: DigestTable[] = questions.map((q, i) => {
      const a = asked[i];
      if (a.error) {
        return {
          key: "answers",
          title: q.question,
          columns: [],
          rows: [],
          empty: `Not answered this morning: ${a.error}. It will be asked again tomorrow.`,
        };
      }
      const rows = a.rows.slice(0, MAX_ROWS).map((row) => (Array.isArray(row) ? row : [row]).map(cellText));
      const more = a.rows.length > MAX_ROWS || a.truncated;
      return {
        key: "answers",
        title: q.question,
        note: plainAnswer(a.answer) || undefined,
        columns: a.columns,
        rows,
        textColumns: Math.max(1, Math.min(2, a.columns.length)),
        empty: a.columns.length ? "The query returned no rows." : "No table with this answer.",
        legend: more ? [`First ${MAX_ROWS} rows shown — open the AI Analyst and ask it for the whole list.`] : undefined,
      };
    });

    return {
      ok: true,
      figures: {
        headline: [
          `Answered fresh at ${now.label} IST. To stop one, open the AI Analyst and use the envelope at the top.`,
        ],
        activity: [{ key: "answers", label: "Questions answered this morning", value: answered }],
        backlog: [{ key: "list", label: "Questions on your morning list", value: questions.length }],
        tables,
        wide: tables.some((t) => t.columns.length > 4),
        // The Sales Head has the AI Analyst under their own menu.
        ctaHref: person.role === "sales_head" ? "/sales-head/analyst" : "/ceo/analyst",
      },
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[digest:analyst_daily] ${person.id} failed:`, error);
    return { ok: false, figures: empty, error };
  }
}

/** Settings-screen preview: what the mail is, without asking the agent anything. */
async function collect(): Promise<{ ok: boolean; figures: DigestFigures; error?: string }> {
  try {
    const list = await people();
    return {
      ok: true,
      figures: {
        headline: ["Each person gets their own mail with fresh answers to their own morning questions."],
        activity: [{ key: "answers", label: "People with a morning question", value: list.length }],
        backlog: [{ key: "list", label: "People who will be mailed tomorrow", value: list.length }],
      },
    };
  } catch (err) {
    return { ok: false, figures: { activity: [], backlog: [] }, error: err instanceof Error ? err.message : String(err) };
  }
}

async function collectDetail(): Promise<{ ok: boolean; detail: DigestDetail; error?: string }> {
  return { ok: true, detail: {} };
}

export const analystDailyDigest: DigestKindDescriptor = {
  id: "analyst_daily",
  label: "AI Analyst morning questions",
  description:
    "Every morning, each person who pressed \"Email me this every morning\" under an AI Analyst answer " +
    "gets that question answered afresh (up to five questions each). Nobody is mailed until they " +
    "ask for it themselves; switching this off here stops it for everyone.",
  settingsKey: "analyst_daily_digest",
  settingsHref: "/admin/settings/analyst-daily",
  ctaHref: "/ceo/analyst",
  ctaLabel: "Open AI Analyst",
  sections: SECTIONS,
  slots: ["morning"],
  defaults: { enabled: true, recipients: [] },
  perRecipient: { resolve: () => people(), collect: collectFor },
  subject: () => `iTarang AI Analyst: your morning questions`,
  collect,
  collectDetail,
};
