/**
 * NBFC Daily report — 23 Nov 2026 (Battery Pool, task 11).
 *
 * Every evening at 21:00 IST: the loan files of the day across the NBFC
 * workflow — received by the lenders, accepted (credit check approved or an
 * offer made), rejected, sanctioned and disbursed — with a city-wise table,
 * plus a per-NBFC table for iTarang.
 *
 * Who (one mail per person, each with their own scope):
 *   • iTarang admins and sales heads → every NBFC;
 *   • each NBFC's admin logins (nbfc_users.role = 'nbfc_admin') → only the
 *     files of their own NBFC.
 * The role switches on the settings screen turn each group on or off. A
 * WhatsApp summary goes to the person's mobile (users.phone) after the mail,
 * unless the "WhatsApp copy" tick-box is off.
 *
 * `db` is imported inside the functions — listing the registry must not
 * require DATABASE_URL (see kyc-review.ts).
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
  { key: "summary", label: "Day totals", hint: "Files received, accepted, rejected, sanctioned and disbursed today.", group: "activity" },
  { key: "city", label: "City-wise table", hint: "The same figures split by the customer's city.", group: "activity" },
  { key: "nbfc", label: "NBFC-wise table (iTarang only)", hint: "The same figures split by lender.", group: "activity" },
  { key: "pending", label: "Still with the lenders", hint: "Files a lender has not decided yet, right now.", group: "backlog" },
  { key: "whatsapp", label: "WhatsApp copy", hint: "Also send a short summary on WhatsApp to each person's mobile.", group: "backlog" },
];

const ROLE_SWITCHES = [
  { key: "admin", label: "iTarang admins (all NBFCs)" },
  { key: "sales_head", label: "Sales heads (all NBFCs)" },
  { key: "nbfc_admin", label: "NBFC admins (their own NBFC only)" },
];

/** One row of the day: per city (or per NBFC). Pure shape. */
export type DayRow = {
  group: string;
  received: number;
  accepted: number;
  rejected: number;
  sanctioned: number;
  disbursed: number;
  disbursedAmount: number;
};

export function totalOf(rows: DayRow[]): DayRow {
  return rows.reduce(
    (t, r) => ({
      group: "Total",
      received: t.received + r.received,
      accepted: t.accepted + r.accepted,
      rejected: t.rejected + r.rejected,
      sanctioned: t.sanctioned + r.sanctioned,
      disbursed: t.disbursed + r.disbursed,
      disbursedAmount: t.disbursedAmount + r.disbursedAmount,
    }),
    { group: "Total", received: 0, accepted: 0, rejected: 0, sanctioned: 0, disbursed: 0, disbursedAmount: 0 },
  );
}

export const inrText = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/** The WhatsApp text for one person. Pure. */
export function whatsappSummary(p: { day: string; scope: string; total: DayRow; topCities: DayRow[]; pending: number }): string {
  const t = p.total;
  const lines = [
    `*iTarang NBFC Daily — ${p.day}*`,
    p.scope,
    "",
    `Files received: ${t.received}`,
    `Accepted: ${t.accepted}`,
    `Rejected: ${t.rejected}`,
    `Sanctioned: ${t.sanctioned}`,
    `Disbursed: ${t.disbursed}${t.disbursedAmount ? ` (${inrText(t.disbursedAmount)})` : ""}`,
    `Still with lenders now: ${p.pending}`,
  ];
  if (p.topCities.length) {
    lines.push("", "*City-wise (received / accepted / disbursed)*");
    for (const c of p.topCities) lines.push(`${c.group}: ${c.received} / ${c.accepted} / ${c.disbursed}`);
  }
  return lines.join("\n");
}

type Scope = { all: true } | { all: false; tenantIds: string[]; names: string[] };

/** iTarang people see everything; an NBFC admin sees their tenant(s). */
async function scopeFor(person: DigestPerson): Promise<Scope> {
  if (person.role !== "nbfc_admin") return { all: true };
  const [{ db }, { sql }] = await Promise.all([import("@/lib/db"), import("drizzle-orm")]);
  const rows = (await db.execute(sql`
    SELECT nu.tenant_id::text AS tenant_id, COALESCE(n.short_name, n.legal_name, '') AS name
      FROM nbfc_users nu
      LEFT JOIN nbfc n ON n.tenant_id = nu.tenant_id
     WHERE nu.user_id::text = ${person.id} AND nu.role = 'nbfc_admin'
  `)) as unknown as Array<{ tenant_id: string; name: string }>;
  return { all: false, tenantIds: [...new Set(rows.map((r) => r.tenant_id))], names: [...new Set(rows.map((r) => r.name).filter(Boolean))] };
}

type Agg = { city: string; nbfc: string; kind: "received" | "accepted" | "rejected" | "sanctioned" | "disbursed"; n: number; amount: number };

/** Every event of the IST day, grouped by city + NBFC. */
async function dayEvents(istDay: string, scope: Scope): Promise<Agg[]> {
  const [{ db }, { sql }] = await Promise.all([import("@/lib/db"), import("drizzle-orm")]);
  if (!scope.all && scope.tenantIds.length === 0) return [];
  const tenantFilter = (col: ReturnType<typeof sql>) =>
    scope.all ? sql`TRUE` : sql`${col} IN (${sql.join(scope.tenantIds.map((t) => sql`${t}`), sql`, `)})`;
  const day = sql`${istDay}::date`;
  const rows = (await db.execute(sql`
    WITH a AS (
      SELECT a.id, a.lead_id, a.tenant_id::text AS tenant_id, a.status, a.assigned_at, a.decided_at,
             COALESCE(NULLIF(trim(l.city), ''), 'Unknown') AS city,
             COALESCE(n.short_name, n.legal_name, 'NBFC') AS nbfc
        FROM nbfc_lead_assignments a
        JOIN leads l ON l.id = a.lead_id
        LEFT JOIN nbfc n ON n.id = a.nbfc_id
       WHERE ${tenantFilter(sql`a.tenant_id::text`)}
    ),
    accepted AS (
      SELECT DISTINCT a.id FROM a
        JOIN nbfc_cibil_reviews r ON r.assignment_id = a.id
       WHERE r.status = 'approved' AND (r.decided_at AT TIME ZONE 'Asia/Kolkata')::date = ${day}
      UNION
      SELECT DISTINCT a.id FROM a
        JOIN nbfc_financing_offers o ON o.assignment_id = a.id
       WHERE (o.created_at AT TIME ZONE 'Asia/Kolkata')::date = ${day}
    )
    SELECT city, nbfc, 'received' AS kind, COUNT(*)::int AS n, 0::numeric AS amount
      FROM a WHERE (a.assigned_at AT TIME ZONE 'Asia/Kolkata')::date = ${day} GROUP BY city, nbfc
    UNION ALL
    SELECT a.city, a.nbfc, 'accepted', COUNT(*)::int, 0 FROM a JOIN accepted x ON x.id = a.id GROUP BY a.city, a.nbfc
    UNION ALL
    SELECT city, nbfc, 'rejected', COUNT(*)::int, 0
      FROM a WHERE a.status = 'declined' AND (a.decided_at AT TIME ZONE 'Asia/Kolkata')::date = ${day} GROUP BY city, nbfc
    UNION ALL
    SELECT COALESCE(NULLIF(trim(l.city), ''), 'Unknown'), COALESCE(n.short_name, n.legal_name, 'NBFC'), 'sanctioned', COUNT(*)::int, 0
      FROM loan_sanctions s JOIN leads l ON l.id = s.lead_id LEFT JOIN nbfc n ON n.tenant_id = s.nbfc_id
     WHERE s.nbfc_id IS NOT NULL AND ${tenantFilter(sql`s.nbfc_id::text`)}
       AND (s.sanctioned_at AT TIME ZONE 'Asia/Kolkata')::date = ${day}
     GROUP BY 1, 2
    UNION ALL
    SELECT COALESCE(NULLIF(trim(l.city), ''), 'Unknown'), COALESCE(n.short_name, n.legal_name, 'NBFC'), 'disbursed', COUNT(*)::int,
           COALESCE(SUM(COALESCE(s.disbursement_amount, s.loan_amount)), 0)
      FROM loan_sanctions s JOIN leads l ON l.id = s.lead_id LEFT JOIN nbfc n ON n.tenant_id = s.nbfc_id
     WHERE s.nbfc_id IS NOT NULL AND ${tenantFilter(sql`s.nbfc_id::text`)}
       AND (s.disbursed_at AT TIME ZONE 'Asia/Kolkata')::date = ${day}
     GROUP BY 1, 2
  `)) as unknown as Array<{ city: string; nbfc: string; kind: Agg["kind"]; n: number; amount: string | number }>;
  return rows.map((r) => ({ city: r.city, nbfc: r.nbfc, kind: r.kind, n: Number(r.n) || 0, amount: Number(r.amount) || 0 }));
}

async function pendingNow(scope: Scope): Promise<number> {
  const [{ db }, { sql }] = await Promise.all([import("@/lib/db"), import("drizzle-orm")]);
  if (!scope.all && scope.tenantIds.length === 0) return 0;
  const filter = scope.all
    ? sql`TRUE`
    : sql`tenant_id::text IN (${sql.join(scope.tenantIds.map((t) => sql`${t}`), sql`, `)})`;
  const rows = (await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM nbfc_lead_assignments
     WHERE status IN ('pending', 'in_progress', 'offer_submitted') AND deleted_at IS NULL AND ${filter}
  `)) as unknown as Array<{ n: number }>;
  return Number(rows[0]?.n) || 0;
}

/** Fold events into rows keyed by `by`. Pure. */
export function foldRows(events: Agg[], by: "city" | "nbfc"): DayRow[] {
  const map = new Map<string, DayRow>();
  for (const e of events) {
    const g = e[by];
    const row =
      map.get(g) ?? { group: g, received: 0, accepted: 0, rejected: 0, sanctioned: 0, disbursed: 0, disbursedAmount: 0 };
    row[e.kind] += e.n;
    if (e.kind === "disbursed") row.disbursedAmount += e.amount;
    map.set(g, row);
  }
  return [...map.values()].sort((a, b) => b.received - a.received || b.disbursed - a.disbursed || a.group.localeCompare(b.group));
}

const COLUMNS = ["Received", "Accepted", "Rejected", "Sanctioned", "Disbursed", "Disbursed ₹"];
const cells = (r: DayRow) => [r.received, r.accepted, r.rejected, r.sanctioned, r.disbursed, inrText(r.disbursedAmount)];

function dayText(istDay: string): string {
  return new Date(`${istDay}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

async function figuresFor(istDay: string, scope: Scope): Promise<{ ok: boolean; figures: DigestFigures; error?: string }> {
  try {
    const [events, pending] = await Promise.all([dayEvents(istDay, scope), pendingNow(scope)]);
    const byCity = foldRows(events, "city");
    const byNbfc = foldRows(events, "nbfc");
    const t = totalOf(byCity);
    const tables: DigestTable[] = [
      {
        key: "city",
        title: "City-wise",
        columns: ["City", ...COLUMNS],
        rows: [...byCity.map((r) => [r.group, ...cells(r)]), ...(byCity.length > 1 ? [["Total", ...cells(t)]] : [])],
        textColumns: 1,
        empty: "No NBFC file activity today.",
      },
    ];
    if (scope.all) {
      tables.push({
        key: "nbfc",
        title: "NBFC-wise",
        columns: ["NBFC", ...COLUMNS],
        rows: byNbfc.map((r) => [r.group, ...cells(r)]),
        textColumns: 1,
        empty: "No NBFC file activity today.",
      });
    }
    return {
      ok: true,
      figures: {
        headline: [
          `${scope.all ? "All NBFCs" : scope.names.join(", ") || "Your NBFC"} · ${dayText(istDay)}: ${t.received} received, ${t.accepted} accepted, ${t.disbursed} disbursed${
            t.disbursedAmount ? ` (${inrText(t.disbursedAmount)})` : ""
          }.`,
        ],
        activity: [
          { key: "summary", label: "Files received by the lenders", value: t.received },
          { key: "summary", label: "Accepted (credit approved / offer made)", value: t.accepted },
          { key: "summary", label: "Rejected", value: t.rejected },
          { key: "summary", label: "Sanctioned", value: t.sanctioned },
          { key: "summary", label: "Disbursed", value: t.disbursed },
          { key: "summary", label: "Disbursed amount", value: Math.round(t.disbursedAmount), display: inrText(t.disbursedAmount), indent: true },
        ],
        backlog: [{ key: "pending", label: "Files still with the lenders (not decided)", value: pending }],
        tables,
        coveredDay: istDay,
      },
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[digest:nbfc_daily] build failed:", error);
    return { ok: false, figures: { activity: [], backlog: [] }, error };
  }
}

/** iTarang admins + sales heads, and every NBFC admin login — role switches applied. */
async function resolvePeople(settings: { roles: Record<string, boolean> }): Promise<DigestPerson[]> {
  const [{ db }, { sql }] = await Promise.all([import("@/lib/db"), import("drizzle-orm")]);
  const on = (k: string) => settings.roles[k] !== false;
  const out: DigestPerson[] = [];
  const itarangRoles = ["admin", "sales_head"].filter(on);
  if (itarangRoles.length) {
    const rows = (await db.execute(sql`
      SELECT id::text AS id, name, email, role FROM users
       WHERE is_active = TRUE AND email IS NOT NULL AND trim(email) <> ''
         AND role IN (${sql.join(itarangRoles.map((r) => sql`${r}`), sql`, `)})
    `)) as unknown as DigestPerson[];
    out.push(...rows);
  }
  if (on("nbfc_admin")) {
    const rows = (await db.execute(sql`
      SELECT DISTINCT u.id::text AS id, u.name, u.email, 'nbfc_admin' AS role
        FROM nbfc_users nu JOIN users u ON u.id = nu.user_id
       WHERE nu.role = 'nbfc_admin' AND u.is_active = TRUE AND u.email IS NOT NULL AND trim(u.email) <> ''
    `)) as unknown as DigestPerson[];
    const seen = new Set(out.map((p) => p.id));
    out.push(...rows.filter((p) => !seen.has(p.id)));
  }
  return out;
}

async function afterSend(person: DigestPerson, figures: DigestFigures, settings: { sections: Record<string, boolean> }) {
  if (settings.sections.whatsapp === false) return;
  const total = figures.activity;
  const get = (label: string) => total.find((l) => l.label.startsWith(label))?.value ?? 0;
  const cityTable = figures.tables?.find((t) => t.key === "city");
  const topCities: DayRow[] = (cityTable?.rows ?? [])
    .filter((r) => r[0] !== "Total")
    .slice(0, 5)
    .map((r) => ({
      group: String(r[0]),
      received: Number(r[1]) || 0,
      accepted: Number(r[2]) || 0,
      rejected: Number(r[3]) || 0,
      sanctioned: Number(r[4]) || 0,
      disbursed: Number(r[5]) || 0,
      disbursedAmount: 0,
    }));
  const scope = person.role === "nbfc_admin" ? (figures.headline?.[0]?.split(" · ")[0] ?? "Your NBFC") : "All NBFCs";
  const body = whatsappSummary({
    day: dayText(figures.coveredDay ?? ""),
    scope,
    total: {
      group: "Total",
      received: get("Files received"),
      accepted: get("Accepted"),
      rejected: get("Rejected"),
      sanctioned: get("Sanctioned"),
      disbursed: get("Disbursed"),
      disbursedAmount: get("Disbursed amount"),
    },
    topCities,
    pending: figures.backlog.find((b) => b.key === "pending")?.value ?? 0,
  });
  const { whatsAppUser } = await import("@/lib/whatsapp/staff-notify");
  await whatsAppUser(person.id, body, { customer: scope, ref: "NBFC Daily", what: "the daily NBFC report is ready" });
}

export const nbfcDailyDigest: DigestKindDescriptor = {
  id: "nbfc_daily",
  label: "NBFC Daily Report",
  description:
    "One mail every evening at 21:00: the loan files of the day — received by the lenders, accepted, rejected, " +
    "sanctioned and disbursed — city-wise, and NBFC-wise for iTarang. iTarang admins and sales heads see every NBFC; " +
    "each NBFC's admins see only their own. A short WhatsApp copy goes to each person's mobile.",
  settingsKey: "nbfc_daily_digest",
  settingsHref: "/admin/settings/nbfc-daily",
  ctaHref: "/admin/kyc-review",
  ctaLabel: "Open KYC & NBFC files",
  sections: SECTIONS,
  slots: ["evening"],
  defaults: { enabled: true, recipients: [], roles: { admin: true, sales_head: true, nbfc_admin: true }, eveningHour: 21, eveningMinute: 0 },
  roleSwitches: ROLE_SWITCHES,
  perRecipient: {
    resolve: resolvePeople,
    async collect(istDay, person) {
      const r = await figuresFor(istDay, await scopeFor(person));
      if (r.ok && person.role === "nbfc_admin") r.figures.ctaHref = "/nbfc/acquire";
      return r;
    },
    afterSend,
  },
  subject: ({ dayLabel }) => `iTarang NBFC Daily — ${dayLabel}`,
  async collect(istDay) {
    return figuresFor(istDay, { all: true });
  },
  async collectDetail(): Promise<{ ok: boolean; detail: DigestDetail; error?: string }> {
    return { ok: true, detail: {} };
  },
};
