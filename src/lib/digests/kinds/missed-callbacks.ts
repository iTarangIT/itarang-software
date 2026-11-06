/**
 * ID 212 (decided 4 Nov, Kartik) — a SEPARATE morning email of the callbacks
 * missed the day before, so someone senior sees every one even if the
 * 30-minute bell / WhatsApp went unread. Not inside My day or the Sales Head
 * email.
 *
 * "Missed" is the callback loop's own escalation rule (callbackLoop.ts),
 * applied to the covered day from the callbacks themselves: a sales callback
 * with an owner, due on that day (IST), with no call or visit on the lead from
 * 15 minutes before the agreed time to 30 minutes after it. Worked out from
 * lead_callbacks rather than from escalated_at, which is cleared when a
 * callback is re-armed. Each row says what happened since: called later,
 * still open, or closed (done, expired, cancelled).
 *
 * Covered days: the previous day; on Monday, Saturday and Sunday (the mail
 * goes Monday to Saturday). Sent to the Sales Heads and every manager with a
 * current reporting line; ships OFF until an Admin switches it on.
 *
 * `db` is imported inside collect — listing the registry must not require
 * DATABASE_URL (see kyc-review.ts).
 */

import type { DigestDetail, DigestFigures, DigestKindDescriptor, DigestSection, DigestTable } from "../types";

const SECTIONS: DigestSection[] = [
    { key: "summary", label: "Headline", hint: "How many callbacks were missed, and how many are still not done.", group: "backlog" },
    {
        key: "missed",
        label: "Missed callbacks",
        hint: "Each missed callback: dealer, the agreed time, who owned it, their manager, and what happened since.",
        group: "backlog",
    },
];

/** "2026-11-05" ± n days. Pure. */
function shift(day: string, n: number): string {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

/** The IST days this morning's mail covers: yesterday, or Sat + Sun on a Monday. Pure. */
export function missedWindow(istDay: string): { from: string; to: string } {
    const to = shift(istDay, -1);
    const weekday = new Date(`${istDay}T00:00:00Z`).getUTCDay(); // 1 = Monday
    return { from: weekday === 1 ? shift(istDay, -2) : to, to };
}

/** What happened to a missed callback since. Pure. */
export function sinceText(r: { status: string; called_after: string | null; completed_at: string | null }, fmt: (iso: string) => string): string {
    if (r.called_after) return `Called later, ${fmt(r.called_after)}`;
    if (r.status === "open" || r.status === "dialing") return "Still not done";
    if (r.status === "expired") return "Closed: expired (no call within 3 working days)";
    if (r.status === "cancelled") return "Closed: cancelled";
    if (r.status === "done") return r.completed_at ? `Marked done, ${fmt(r.completed_at)}` : "Marked done";
    return r.status;
}

const istFmt = (iso: string) =>
    new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

type Row = {
    lead_id: string;
    dealer: string | null;
    due_at: string;
    kind: string | null;
    status: string;
    completed_at: string | null;
    owner_id: string | null;
    owner_name: string | null;
    called_after: string | null;
};

/** lead_callbacks.kind (E-362) in words; a database without the column reads 'sales'. */
const KIND_WORDS: Record<string, string> = {
    sales: "Callback the dealer agreed to",
    complaint: "Complaint",
    qualified: "Qualified, no time agreed",
};

async function collect(istDay: string): Promise<{ ok: boolean; figures: DigestFigures; error?: string }> {
    try {
        const [{ db }, { sql }, { currentTeamOf }] = await Promise.all([
            import("@/lib/db"),
            import("drizzle-orm"),
            import("@/lib/users/team"),
        ]);
        const probe = (await db.execute(sql`
            SELECT to_regclass('public.lead_callbacks') IS NOT NULL AS ok
        `)) as unknown as Array<{ ok: boolean }>;
        const { from, to } = missedWindow(istDay);
        const rows: Row[] = probe[0]?.ok
            ? ((await db.execute(sql`
                SELECT lc.lead_id,
                       (SELECT COALESCE(dl.shop_name, dl.dealer_name, dl.phone) FROM dealer_leads dl WHERE dl.id = lc.lead_id) AS dealer,
                       lc.due_at::text AS due_at, to_jsonb(lc) ->> 'kind' AS kind, lc.status,
                       lc.completed_at::text AS completed_at,
                       lc.assigned_user_id::text AS owner_id, u.name AS owner_name,
                       (SELECT MIN(t.performed_at)::text FROM lead_touchpoints t
                         WHERE t.dealer_lead_id = lc.lead_id
                           AND t.touchpoint_type IN ('inside_sales_call', 'visit')
                           AND t.performed_at > lc.due_at + interval '30 minutes') AS called_after
                  FROM lead_callbacks lc
                  LEFT JOIN users u ON u.id::text = lc.assigned_user_id::text
                 WHERE lc.owner_type = 'sales'
                   AND lc.assigned_user_id IS NOT NULL
                   AND (lc.due_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${from}::date AND ${to}::date
                   AND lc.due_at < now() - interval '30 minutes'
                   AND NOT EXISTS (
                       SELECT 1 FROM lead_touchpoints t
                        WHERE t.dealer_lead_id = lc.lead_id
                          AND t.touchpoint_type IN ('inside_sales_call', 'visit')
                          AND t.performed_at BETWEEN lc.due_at - interval '15 minutes' AND lc.due_at + interval '30 minutes')
                 ORDER BY lc.due_at
            `)) as unknown as Row[])
            : [];

        const team = await currentTeamOf();
        const managerIds = [...new Set(rows.map((r) => (r.owner_id ? team.get(r.owner_id) : undefined)).filter((x): x is string => !!x))];
        const managers = new Map<string, string>();
        if (managerIds.length) {
            const found = (await db.execute(sql`
                SELECT id::text AS id, name FROM users WHERE id::text IN (${sql.join(managerIds.map((m) => sql`${m}`), sql`, `)})
            `)) as unknown as Array<{ id: string; name: string | null }>;
            for (const m of found) managers.set(m.id, m.name ?? m.id);
        }

        const appUrl = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "https://crm.itarang.com").replace(/\/+$/, "");
        const notDone = rows.filter((r) => !r.called_after && (r.status === "open" || r.status === "dialing")).length;
        const days = from === to ? from : `${from} – ${to}`;
        const table: DigestTable = {
            key: "missed",
            title: `Callbacks missed (${days}): no call within 30 minutes of the agreed time`,
            columns: ["Dealer", "Agreed for (IST)", "Owner", "Manager", "Type", "Since then"],
            rows: rows.map((r) => [
                r.dealer ?? r.lead_id,
                istFmt(r.due_at),
                r.owner_name ?? "—",
                (r.owner_id && managers.get(team.get(r.owner_id) ?? "")) || "—",
                KIND_WORDS[r.kind ?? "sales"] ?? (r.kind ?? "Callback"),
                sinceText(r, istFmt),
            ]),
            rowLinks: rows.map((r) => `${appUrl}/leads?lead=${encodeURIComponent(r.lead_id)}`),
            empty: "No callback was missed. Every one had a call within 30 minutes of the agreed time.",
        };
        return {
            ok: true,
            figures: {
                activity: [],
                backlog: [
                    { key: "summary", label: "Callbacks missed", value: rows.length },
                    { key: "summary", label: "of which still not done this morning", value: notDone },
                ],
                tables: [table],
                coveredDay: to,
            },
        };
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.error("[digest:missed_callbacks] build failed:", error);
        return { ok: false, figures: { activity: [], backlog: [] }, error };
    }
}

/** The table is the detail. */
async function collectDetail(): Promise<{ ok: boolean; detail: DigestDetail; error?: string }> {
    return { ok: true, detail: {} };
}

/** The Sales Heads and every manager on a current reporting line. */
async function resolveAudience(): Promise<string[]> {
    const [{ db }, { sql }, { currentTeamOf }] = await Promise.all([import("@/lib/db"), import("drizzle-orm"), import("@/lib/users/team")]);
    const managerIds = [...new Set((await currentTeamOf()).values())];
    const rows = (await db.execute(sql`
        SELECT DISTINCT lower(trim(email)) AS email FROM users
         WHERE is_active IS NOT FALSE AND NULLIF(trim(email), '') IS NOT NULL
           AND (lower(role) = 'sales_head'
                ${managerIds.length ? sql`OR id::text IN (${sql.join(managerIds.map((m) => sql`${m}`), sql`, `)})` : sql``})
    `)) as unknown as Array<{ email: string }>;
    return rows.map((r) => r.email);
}

export const missedCallbacksDigest: DigestKindDescriptor = {
    id: "missed_callbacks",
    label: "Missed Callbacks",
    description:
        "One mail every morning (Monday to Saturday): each callback missed the day before — no call within 30 minutes " +
        "of the time agreed with the dealer — with its owner, their manager and what happened since. Monday's mail " +
        "covers Saturday and Sunday. Goes to the Sales Heads and every manager with a reporting line, plus anyone added here.",
    settingsKey: "missed_callbacks_digest",
    settingsHref: "/admin/settings/missed-callbacks",
    ctaHref: "/leads",
    ctaLabel: "Open Leads",
    sections: SECTIONS,
    slots: ["morning"],
    weekdays: [1, 2, 3, 4, 5, 6],
    defaults: { enabled: false, recipients: [] },
    audience: { label: "The Sales Heads and every manager with a reporting line", resolve: resolveAudience },
    subject: ({ dayLabel }) => `iTarang Missed Callbacks — ${dayLabel}`,
    collect,
    collectDetail,
};
