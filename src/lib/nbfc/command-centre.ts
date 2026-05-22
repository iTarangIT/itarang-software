/**
 * Portfolio Command Centre compute layer (BRD §6.1.3 — extends E-026/E-027).
 *
 * Powers the redesigned /nbfc/portfolio dashboard: KPI block with honest
 * trend deltas, a unified alert feed, regional risk, weekly stats and recent
 * actions. Decoupled from the HTTP/auth layer (mirrors portfolio-summary.ts)
 * so it can be unit-tested directly.
 *
 * IoT independence: the alert feed reads `telemetry_alerts`, a CRM-Postgres
 * table populated by the ingestion job — NOT the IoT VPS. This module never
 * imports getIotSql(), so the Command Centre renders fully even when the IoT
 * VPS tunnel is down.
 *
 * Known data constraint: `nbfc_risk_alerts.loan_sanction_id` is `uuid` while
 * `loan_sanctions.id` is `varchar` with non-uuid values — so a risk alert
 * can rarely resolve to a borrower name/city (the `::text` join below mostly
 * yields NULL). Telemetry alerts join cleanly via `vehicleno` and carry the
 * named feed rows. See docs/nbfc-partner-dashboard-plan.md §open-questions.
 */
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  emiSchedules,
  leads,
  loanSanctions,
  nbfcBorrowerActions,
  nbfcImmobilisationActions,
  nbfcLoans,
  nbfcRecoveryPipeline,
  nbfcRiskAlerts,
  telemetryAlerts,
} from "@/lib/db/schema";
import {
  computePortfolioSummary,
  startOfCurrentMonthIST,
  type PortfolioSummary,
} from "./portfolio-summary";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface KpiDelta {
  /** Pre-formatted, e.g. "+4 QoQ" or "−0.80pp MoM". */
  text: string;
  /** Whether the movement is favourable for this metric. */
  tone: "good" | "bad" | "neutral";
}

export interface CommandCentreKpis {
  active_loans: { value: number; delta: KpiDelta | null };
  at_risk: { value: number; pct_of_book: number };
  delinquency_rate: { value: number; delta: KpiDelta | null };
  recovery_in_motion: { count: number; amount_inr: number };
}

export type AlertSeverity = "critical" | "warning" | "info";

export interface AlertFeedItem {
  source: "risk" | "telemetry";
  id: string;
  severity: AlertSeverity;
  title: string;
  detail: string | null;
  battery_serial: string | null;
  borrower_name: string | null;
  city: string | null;
  loan_sanction_id: string | null;
  created_at: string;
}

export interface RegionalRiskRow {
  city: string;
  loan_count: number;
  at_risk_count: number;
  at_risk_pct: number;
}

export interface WeeklyStats {
  emis_settled: number;
  new_risk_alerts: number;
  recovery_added: number;
  immobilisations_executed: number;
}

export interface RecentActionCount {
  action_type: string;
  label: string;
  count: number;
}

export interface NavCounts {
  risk_alerts_open: number;
  leads_total: number;
  recovery_open: number;
}

export interface CommandCentreData {
  kpis: CommandCentreKpis;
  navCounts: NavCounts;
  alertFeed: AlertFeedItem[];
  weekly: WeeklyStats;
  regional: RegionalRiskRow[];
  recentActions: RecentActionCount[];
  /** Sub-block failures — the page degrades that section, not the whole load. */
  errors: string[];
  computed_at: string;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const QUARTER_MS = 90 * 24 * 60 * 60 * 1000;

/** Fallback summary used when computePortfolioSummary() fails — see settle(). */
const EMPTY_PORTFOLIO_SUMMARY: PortfolioSummary = {
  total_active_loans: 0,
  portfolio_value: 0,
  avg_emi: 0,
  disbursement_this_month: 0,
  delinquency_rate: 0,
  avg_portfolio_cds: 0,
  recovery_value_locked: 0,
  computed_at: new Date(0).toISOString(),
};

// -----------------------------------------------------------------------------
// Orchestrator
// -----------------------------------------------------------------------------

export async function computeCommandCentre(
  tenantId: string,
): Promise<CommandCentreData> {
  const errors: string[] = [];
  const settle = async <T>(name: string, p: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await p;
    } catch (e) {
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      return fallback;
    }
  };

  // Resolved once, threaded into every sub-block. Each prefetch runs through
  // settle() too, so one failed query degrades its dependent sections instead
  // of rejecting the whole endpoint with a 500.
  const activeRows = await settle(
    "activeLoans",
    getActiveLoanRows(tenantId),
    [] as { id: string; city: string | null }[],
  );
  const activeIds = activeRows.map((r) => r.id);
  const summary = await settle(
    "portfolioSummary",
    computePortfolioSummary(tenantId),
    EMPTY_PORTFOLIO_SUMMARY,
  );
  const atRiskIds = await settle(
    "atRiskIds",
    computeAtRiskIds(tenantId, activeIds),
    new Set<string>(),
  );

  const [kpis, navCounts, alertFeed, weekly, recentActions] = await Promise.all([
    settle(
      "kpis",
      computeKpiBlock(tenantId, atRiskIds, summary),
      defaultKpis(summary, atRiskIds),
    ),
    settle("navCounts", computeNavCounts(tenantId, activeIds.length), {
      risk_alerts_open: 0,
      leads_total: activeIds.length,
      recovery_open: 0,
    }),
    settle("alertFeed", computeAlertFeed(tenantId), [] as AlertFeedItem[]),
    settle("weekly", computeWeeklyStats(tenantId, activeIds), {
      emis_settled: 0,
      new_risk_alerts: 0,
      recovery_added: 0,
      immobilisations_executed: 0,
    }),
    settle("recentActions", computeRecentActions(tenantId), [] as RecentActionCount[]),
  ]);

  const regional = computeRegionalRisk(activeRows, atRiskIds);

  return {
    kpis,
    navCounts,
    alertFeed,
    weekly,
    regional,
    recentActions,
    errors,
    computed_at: new Date().toISOString(),
  };
}

// -----------------------------------------------------------------------------
// Active book + at-risk set
// -----------------------------------------------------------------------------

/** Active loans for the tenant, each with its borrower city (via lead). */
async function getActiveLoanRows(
  tenantId: string,
): Promise<{ id: string; city: string | null }[]> {
  return db
    .select({ id: loanSanctions.id, city: leads.city })
    .from(loanSanctions)
    .leftJoin(leads, eq(leads.id, loanSanctions.lead_id))
    .where(
      and(
        eq(loanSanctions.nbfc_id, tenantId),
        eq(loanSanctions.status, "disbursed"),
        isNull(loanSanctions.closed_at),
      ),
    );
}

/**
 * Loan ids considered "at risk": delinquent (an EMI >30 days overdue) OR
 * carrying an open critical/warning telemetry alert. Risk alerts cannot
 * contribute — their uuid loan_sanction_id cannot map to a varchar loan id.
 */
async function computeAtRiskIds(
  tenantId: string,
  activeIds: string[],
): Promise<Set<string>> {
  const set = new Set<string>();
  if (activeIds.length === 0) return set;
  const activeSet = new Set(activeIds);

  const overdue = await db
    .selectDistinct({ loan_sanction_id: emiSchedules.loan_sanction_id })
    .from(emiSchedules)
    .where(
      and(
        inArray(emiSchedules.loan_sanction_id, activeIds),
        inArray(emiSchedules.status, ["overdue", "missed"]),
        sql`COALESCE(${emiSchedules.days_overdue}, 0) > 30`,
      ),
    );
  for (const r of overdue) if (activeSet.has(r.loan_sanction_id)) set.add(r.loan_sanction_id);

  const flagged = await db
    .selectDistinct({ loan_id: nbfcLoans.loan_application_id })
    .from(telemetryAlerts)
    .innerJoin(nbfcLoans, eq(nbfcLoans.vehicleno, telemetryAlerts.serial_number))
    .where(
      and(
        eq(nbfcLoans.tenant_id, tenantId),
        isNull(telemetryAlerts.resolved_at),
        inArray(telemetryAlerts.severity, ["critical", "warning"]),
      ),
    );
  for (const r of flagged) if (activeSet.has(r.loan_id)) set.add(r.loan_id);

  return set;
}

// -----------------------------------------------------------------------------
// KPI block
// -----------------------------------------------------------------------------

function defaultKpis(
  summary: PortfolioSummary,
  atRiskIds: Set<string>,
): CommandCentreKpis {
  const total = summary.total_active_loans;
  return {
    active_loans: { value: total, delta: null },
    at_risk: {
      value: atRiskIds.size,
      pct_of_book: total === 0 ? 0 : round1((atRiskIds.size / total) * 100),
    },
    delinquency_rate: { value: summary.delinquency_rate, delta: null },
    recovery_in_motion: { count: 0, amount_inr: summary.recovery_value_locked },
  };
}

async function computeKpiBlock(
  tenantId: string,
  atRiskIds: Set<string>,
  summary: PortfolioSummary,
): Promise<CommandCentreKpis> {
  const [activeDelta, delinqDelta, recovery] = await Promise.all([
    deltaActiveLoansQoQ(tenantId, summary.total_active_loans),
    deltaDelinquencyMoM(tenantId),
    computeRecoveryInMotion(tenantId),
  ]);
  const total = summary.total_active_loans;
  return {
    active_loans: { value: total, delta: activeDelta },
    at_risk: {
      value: atRiskIds.size,
      pct_of_book: total === 0 ? 0 : round1((atRiskIds.size / total) * 100),
    },
    delinquency_rate: { value: summary.delinquency_rate, delta: delinqDelta },
    recovery_in_motion: recovery,
  };
}

async function computeRecoveryInMotion(
  tenantId: string,
): Promise<{ count: number; amount_inr: number }> {
  const rows = await db
    .select({ v: nbfcRecoveryPipeline.estimated_recovery_value })
    .from(nbfcRecoveryPipeline)
    .where(
      and(
        eq(nbfcRecoveryPipeline.tenant_id, tenantId),
        sql`${nbfcRecoveryPipeline.stage} <> 'resold'`,
      ),
    );
  return {
    count: rows.length,
    amount_inr: rows.reduce((a, r) => a + (r.v != null ? Number(r.v) : 0), 0),
  };
}

/**
 * Active-loans delta vs ~90 days ago. A loan was active as of date D if it was
 * disbursed before D and not closed before D. Returns null when there were no
 * loans a quarter ago (tenant younger than a quarter — no honest baseline).
 */
async function deltaActiveLoansQoQ(
  tenantId: string,
  currentActive: number,
): Promise<KpiDelta | null> {
  const asOf = new Date(Date.now() - QUARTER_MS).toISOString();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(loanSanctions)
    .where(
      and(
        eq(loanSanctions.nbfc_id, tenantId),
        sql`${loanSanctions.disbursed_at} < ${asOf}`,
        or(
          isNull(loanSanctions.closed_at),
          sql`${loanSanctions.closed_at} > ${asOf}`,
        ),
      ),
    );
  const prior = row?.n ?? 0;
  if (prior === 0) return null;
  const diff = currentActive - prior;
  return {
    text: `${signNum(diff)} QoQ`,
    tone: diff > 0 ? "good" : diff < 0 ? "bad" : "neutral",
  };
}

/**
 * Delinquency-rate delta (percentage points) — now vs the start of the
 * current IST month. BOTH endpoints are reconstructed the same way from the
 * immutable emi_schedules ledger: a loan is delinquent as of D if it has an
 * EMI due >30 days before D that was still unpaid as of D. Reconstructing
 * both ends identically keeps the comparison internally consistent (the
 * mutable `status` column cannot be read historically). Returns null when
 * either as-of book was empty.
 */
async function deltaDelinquencyMoM(tenantId: string): Promise<KpiDelta | null> {
  const monthStart = startOfCurrentMonthIST().toISOString();
  const now = new Date().toISOString();

  const rateAsOf = async (asOf: string): Promise<number | null> => {
    const active = await db
      .select({ id: loanSanctions.id })
      .from(loanSanctions)
      .where(
        and(
          eq(loanSanctions.nbfc_id, tenantId),
          sql`${loanSanctions.disbursed_at} < ${asOf}`,
          or(
            isNull(loanSanctions.closed_at),
            sql`${loanSanctions.closed_at} > ${asOf}`,
          ),
        ),
      );
    if (active.length === 0) return null;
    const ids = active.map((r) => r.id);
    const overdue = await db
      .selectDistinct({ id: emiSchedules.loan_sanction_id })
      .from(emiSchedules)
      .where(
        and(
          inArray(emiSchedules.loan_sanction_id, ids),
          sql`${emiSchedules.due_date} < ${asOf}::date`,
          or(
            isNull(emiSchedules.paid_at),
            sql`${emiSchedules.paid_at} > ${asOf}`,
          ),
          sql`(${asOf}::date - ${emiSchedules.due_date}) > 30`,
        ),
      );
    return (overdue.length / active.length) * 100;
  };

  const [current, prior] = await Promise.all([
    rateAsOf(now),
    rateAsOf(monthStart),
  ]);
  if (current === null || prior === null) return null;
  const diff = round2(current - prior);
  return {
    text: `${signNum(diff, 2)}pp MoM`,
    tone: diff < 0 ? "good" : diff > 0 ? "bad" : "neutral",
  };
}

// -----------------------------------------------------------------------------
// Alert feed
// -----------------------------------------------------------------------------

const RISK_TITLES: Record<string, string> = {
  pci_low: "Payment consistency dropped",
  cds_high: "Credit-default score elevated",
  delinquency_spike: "Delinquency spike detected",
};

function titleCase(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function normaliseSeverity(s: string | null | undefined): AlertSeverity {
  const v = (s ?? "").toLowerCase();
  if (v === "critical" || v === "high") return "critical";
  if (v === "warning" || v === "medium") return "warning";
  return "info";
}

function riskDetail(type: string, payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const num = (k: string): number | null =>
    typeof p[k] === "number" ? (p[k] as number) : null;
  if (type === "pci_low") {
    const score = num("pci_score");
    const thr = num("threshold");
    if (score != null) {
      return `PCI ${score.toFixed(2)}${thr != null ? ` vs ${thr.toFixed(2)} threshold` : ""}`;
    }
  }
  if (type === "cds_high") {
    const score = num("cds_score");
    if (score != null) return `CDS ${score}`;
  }
  const days = num("days_overdue");
  if (days != null) return `${days} days overdue`;
  return null;
}

function telemetryDetail(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const parts: string[] = [];
  const n = (k: string): number | null =>
    typeof p[k] === "number" ? (p[k] as number) : null;
  const soc = n("soc_percent");
  if (soc != null) parts.push(`SOC ${soc}%`);
  const soh = n("soh_percent");
  if (soh != null) parts.push(`SOH ${soh}%`);
  const temp = n("temperature_c");
  if (temp != null) parts.push(`${temp}°C`);
  const offline = n("offline_hours");
  if (offline != null) parts.push(`offline ${offline}h`);
  const drift = n("distance_km");
  if (drift != null) parts.push(`${drift} km drift`);
  const drop = n("drop_pct");
  if (drop != null) parts.push(`${drop}% usage drop`);
  return parts.length ? parts.join(" · ") : null;
}

async function computeAlertFeed(
  tenantId: string,
  limit = 60,
): Promise<AlertFeedItem[]> {
  const [riskRows, telRows] = await Promise.all([
    db
      .select({
        id: nbfcRiskAlerts.id,
        type: nbfcRiskAlerts.type,
        severity: nbfcRiskAlerts.severity,
        created_at: nbfcRiskAlerts.created_at,
        payload: nbfcRiskAlerts.payload,
        loan_id: loanSanctions.id,
        owner_name: leads.owner_name,
        business_name: leads.business_name,
        city: leads.city,
      })
      .from(nbfcRiskAlerts)
      // uuid → text cast: loan_sanctions.id is varchar; see module doc-block.
      .leftJoin(
        loanSanctions,
        sql`${loanSanctions.id} = ${nbfcRiskAlerts.loan_sanction_id}::text`,
      )
      .leftJoin(leads, eq(leads.id, loanSanctions.lead_id))
      .where(
        and(
          eq(nbfcRiskAlerts.tenant_id, tenantId),
          isNull(nbfcRiskAlerts.resolved_at),
        ),
      )
      .orderBy(desc(nbfcRiskAlerts.created_at))
      .limit(limit),
    db
      .select({
        id: telemetryAlerts.id,
        rule: telemetryAlerts.rule,
        severity: telemetryAlerts.severity,
        triggered_at: telemetryAlerts.triggered_at,
        payload: telemetryAlerts.payload,
        serial_number: telemetryAlerts.serial_number,
        loan_id: nbfcLoans.loan_application_id,
        owner_name: leads.owner_name,
        business_name: leads.business_name,
        city: leads.city,
      })
      .from(telemetryAlerts)
      .innerJoin(nbfcLoans, eq(nbfcLoans.vehicleno, telemetryAlerts.serial_number))
      .leftJoin(loanSanctions, eq(loanSanctions.id, nbfcLoans.loan_application_id))
      .leftJoin(leads, eq(leads.id, loanSanctions.lead_id))
      .where(
        and(
          eq(nbfcLoans.tenant_id, tenantId),
          isNull(telemetryAlerts.resolved_at),
        ),
      )
      .orderBy(desc(telemetryAlerts.triggered_at))
      .limit(limit),
  ]);

  const items: AlertFeedItem[] = [];

  for (const r of riskRows) {
    items.push({
      source: "risk",
      id: `risk-${r.id}`,
      severity: normaliseSeverity(r.severity),
      title: RISK_TITLES[r.type] ?? titleCase(r.type),
      detail: riskDetail(r.type, r.payload),
      battery_serial: null,
      borrower_name: r.owner_name ?? r.business_name ?? null,
      city: r.city ?? null,
      loan_sanction_id: r.loan_id ?? null,
      created_at: r.created_at.toISOString(),
    });
  }

  // A vehicleno shared by >1 active loan would fan out a telemetry alert —
  // dedupe by the telemetry_alerts row id.
  const seen = new Set<number>();
  for (const r of telRows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    items.push({
      source: "telemetry",
      id: `tel-${r.id}`,
      severity: normaliseSeverity(r.severity),
      title: r.rule,
      detail: telemetryDetail(r.payload),
      battery_serial: r.serial_number,
      borrower_name: r.owner_name ?? r.business_name ?? null,
      city: r.city ?? null,
      loan_sanction_id: r.loan_id ?? null,
      created_at: r.triggered_at.toISOString(),
    });
  }

  items.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return items.slice(0, limit);
}

// -----------------------------------------------------------------------------
// Regional risk
// -----------------------------------------------------------------------------

function computeRegionalRisk(
  activeRows: { id: string; city: string | null }[],
  atRiskIds: Set<string>,
): RegionalRiskRow[] {
  const map = new Map<string, { loans: number; atRisk: number }>();
  for (const r of activeRows) {
    const city = r.city && r.city.trim() ? r.city.trim() : "Unknown";
    const e = map.get(city) ?? { loans: 0, atRisk: 0 };
    e.loans += 1;
    if (atRiskIds.has(r.id)) e.atRisk += 1;
    map.set(city, e);
  }
  let rows: RegionalRiskRow[] = [...map.entries()].map(([city, e]) => ({
    city,
    loan_count: e.loans,
    at_risk_count: e.atRisk,
    at_risk_pct: e.loans === 0 ? 0 : round1((e.atRisk / e.loans) * 100),
  }));
  rows.sort(
    (a, b) => b.at_risk_pct - a.at_risk_pct || b.loan_count - a.loan_count,
  );
  if (rows.length > 8) {
    const top = rows.slice(0, 8);
    const rest = rows.slice(8);
    const loans = rest.reduce((a, r) => a + r.loan_count, 0);
    const atRisk = rest.reduce((a, r) => a + r.at_risk_count, 0);
    top.push({
      city: "Other",
      loan_count: loans,
      at_risk_count: atRisk,
      at_risk_pct: loans === 0 ? 0 : round1((atRisk / loans) * 100),
    });
    rows = top;
  }
  return rows;
}

// -----------------------------------------------------------------------------
// Weekly stats
// -----------------------------------------------------------------------------

async function computeWeeklyStats(
  tenantId: string,
  activeIds: string[],
): Promise<WeeklyStats> {
  const since = new Date(Date.now() - WEEK_MS).toISOString();

  const emisQuery =
    activeIds.length === 0
      ? Promise.resolve([{ n: 0 }])
      : db
          .select({ n: sql<number>`count(*)::int` })
          .from(emiSchedules)
          .where(
            and(
              inArray(emiSchedules.loan_sanction_id, activeIds),
              inArray(emiSchedules.status, ["paid", "paid_late"]),
              sql`${emiSchedules.paid_at} >= ${since}`,
            ),
          );

  const [emis, newAlerts, recovery, immob] = await Promise.all([
    emisQuery,
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(nbfcRiskAlerts)
      .where(
        and(
          eq(nbfcRiskAlerts.tenant_id, tenantId),
          sql`${nbfcRiskAlerts.created_at} >= ${since}`,
        ),
      ),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(nbfcRecoveryPipeline)
      .where(
        and(
          eq(nbfcRecoveryPipeline.tenant_id, tenantId),
          sql`${nbfcRecoveryPipeline.created_at} >= ${since}`,
        ),
      ),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(nbfcImmobilisationActions)
      .where(
        and(
          eq(nbfcImmobilisationActions.tenant_id, tenantId),
          sql`${nbfcImmobilisationActions.executed_at} >= ${since}`,
        ),
      ),
  ]);

  return {
    emis_settled: emis[0]?.n ?? 0,
    new_risk_alerts: newAlerts[0]?.n ?? 0,
    recovery_added: recovery[0]?.n ?? 0,
    immobilisations_executed: immob[0]?.n ?? 0,
  };
}

// -----------------------------------------------------------------------------
// Recent actions
// -----------------------------------------------------------------------------

const ACTION_LABELS: Record<string, string> = {
  payment_reminder: "Payment reminders",
  field_visit: "Field visits",
  loan_restructuring: "Restructuring reviews",
  flag_for_recovery: "Flagged for recovery",
  battery_immobilisation: "Immobilisations",
  bulk_immobilisation: "Bulk immobilisations",
};

async function computeRecentActions(
  tenantId: string,
): Promise<RecentActionCount[]> {
  const since = new Date(Date.now() - WEEK_MS).toISOString();
  const rows = await db
    .select({
      action_type: nbfcBorrowerActions.action_type,
      n: sql<number>`count(*)::int`,
    })
    .from(nbfcBorrowerActions)
    .where(
      and(
        eq(nbfcBorrowerActions.tenant_id, tenantId),
        inArray(nbfcBorrowerActions.status, [
          "approved",
          "executed",
          "auto_approved",
        ]),
        sql`${nbfcBorrowerActions.created_at} >= ${since}`,
      ),
    )
    .groupBy(nbfcBorrowerActions.action_type);

  const counts = new Map(rows.map((r) => [r.action_type, r.n]));
  return Object.keys(ACTION_LABELS).map((type) => ({
    action_type: type,
    label: ACTION_LABELS[type],
    count: counts.get(type) ?? 0,
  }));
}

// -----------------------------------------------------------------------------
// Nav-strip counts
// -----------------------------------------------------------------------------

async function computeNavCounts(
  tenantId: string,
  activeCount: number,
): Promise<NavCounts> {
  const [risk, tel, recovery] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(nbfcRiskAlerts)
      .where(
        and(
          eq(nbfcRiskAlerts.tenant_id, tenantId),
          isNull(nbfcRiskAlerts.resolved_at),
        ),
      ),
    db
      .select({ n: sql<number>`count(distinct ${telemetryAlerts.id})::int` })
      .from(telemetryAlerts)
      .innerJoin(
        nbfcLoans,
        eq(nbfcLoans.vehicleno, telemetryAlerts.serial_number),
      )
      .where(
        and(
          eq(nbfcLoans.tenant_id, tenantId),
          isNull(telemetryAlerts.resolved_at),
        ),
      ),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(nbfcRecoveryPipeline)
      .where(
        and(
          eq(nbfcRecoveryPipeline.tenant_id, tenantId),
          sql`${nbfcRecoveryPipeline.stage} <> 'resold'`,
        ),
      ),
  ]);
  return {
    risk_alerts_open: (risk[0]?.n ?? 0) + (tel[0]?.n ?? 0),
    leads_total: activeCount,
    recovery_open: recovery[0]?.n ?? 0,
  };
}

// -----------------------------------------------------------------------------
// Small numeric helpers
// -----------------------------------------------------------------------------

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
/** "+4" / "−4" / "0" — uses a real minus glyph for negatives. */
function signNum(n: number, decimals = 0): string {
  const abs = Math.abs(n).toFixed(decimals);
  if (n > 0) return `+${abs}`;
  if (n < 0) return `−${abs}`;
  return abs;
}
