/**
 * /nbfc/batteries — Battery Monitoring (BRD §6.2)
 *
 * Server-rendered fleet table for the current tenant. Joins the local
 * nbfc_loans portfolio (for borrower/loan context) with the VPS vehicle_state
 * table (for SOC/SOH/last_seen/online/lat-lon) and the VPS alerts table
 * (open-alert count per vehicleno). The list renders through the responsive
 * `BatteriesTable`; a row tap opens the per-battery detail drawer.
 *
 * Filters are URL-driven: ?status=online|idle|stale|offline|never &severity=open
 * &risk=high|low_pci &q=<text> &serial=<one to auto-open>.
 */
import Link from "next/link";
import { db } from "@/lib/db";
import { and, eq, inArray } from "drizzle-orm";
import { nbfcLoans, loanFiles, borrowerRiskScores, nbfcRiskRules } from "@/lib/db/schema";
import { getCurrentTenant, requireNbfcAccess } from "@/lib/nbfc/tenant";
import {
  getFleetSummary,
  getVehicleStates,
  getOpenAlerts,
  type VehicleStateRow,
} from "@/lib/db/iot-queries";
import { classifyFreshness } from "@/lib/iot/freshness";
import BatteryRowDrawer from "./_components/BatteryRowDrawer";
import BatteriesTable, { type BatteryRow } from "./_components/BatteriesTable";

export const dynamic = "force-dynamic";

interface SearchParams {
  status?: string;
  severity?: string;
  risk?: string;
  q?: string;
  serial?: string;
}

interface RiskScoreRow {
  cds_score: number | null;
  pci_score: number | null;
  confidence: string | null;
  computed_at: Date | null;
}

interface PortfolioRow {
  loan_application_id: string;
  vehicleno: string;
  current_dpd: number | null;
  outstanding_amount: number | null;
  borrower_name: string | null;
}

const FIELD_LABEL =
  "block text-[10px] font-bold uppercase tracking-widest text-[color:var(--color-ink-muted)] mb-1";
const FIELD_INPUT =
  "border border-[color:var(--color-border)] rounded-lg px-2.5 py-1.5 text-sm bg-[color:var(--color-surface)]";

async function loadCdsBands(): Promise<{ low_mid: number; mid_high: number }> {
  const rows = await db
    .select({
      rule_key: nbfcRiskRules.rule_key,
      current_value: nbfcRiskRules.current_value,
    })
    .from(nbfcRiskRules)
    .where(
      inArray(nbfcRiskRules.rule_key, [
        "cds_low_mid_threshold",
        "cds_mid_high_threshold",
      ]),
    );
  const map = new Map(rows.map((r) => [r.rule_key, Number(r.current_value)]));
  return {
    low_mid: map.get("cds_low_mid_threshold") ?? 40,
    mid_high: map.get("cds_mid_high_threshold") ?? 70,
  };
}

export default async function BatteriesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const tenant = await getCurrentTenant();
  await requireNbfcAccess(tenant.id);
  const params = (await searchParams) ?? {};

  const bands = await loadCdsBands();

  // 1. Portfolio rows — vehicleno + borrower context (left-joined to loan_files).
  const portfolio = (await db
    .select({
      loan_application_id: nbfcLoans.loan_application_id,
      vehicleno: nbfcLoans.vehicleno,
      current_dpd: nbfcLoans.current_dpd,
      outstanding_amount: nbfcLoans.outstanding_amount,
      borrower_name: loanFiles.borrower_name,
    })
    .from(nbfcLoans)
    .leftJoin(
      loanFiles,
      eq(loanFiles.loan_application_id, nbfcLoans.loan_application_id),
    )
    .where(
      and(eq(nbfcLoans.tenant_id, tenant.id), eq(nbfcLoans.is_active, true)),
    )) as Array<{
    loan_application_id: string;
    vehicleno: string | null;
    current_dpd: number | null;
    outstanding_amount: string | null;
    borrower_name: string | null;
  }>;

  const portfolioRows: PortfolioRow[] = portfolio
    .filter((r): r is typeof r & { vehicleno: string } => !!r.vehicleno)
    .map((r) => ({
      loan_application_id: r.loan_application_id,
      vehicleno: r.vehicleno,
      current_dpd: r.current_dpd,
      outstanding_amount:
        r.outstanding_amount != null ? Number(r.outstanding_amount) : null,
      borrower_name: r.borrower_name,
    }));

  const vehiclenos = portfolioRows.map((r) => r.vehicleno);

  // 2a. Borrower risk scores (CDS / PCI / confidence) — BRD §6.1.5.
  const riskRows = await db
    .select({
      loan_sanction_id: borrowerRiskScores.loan_sanction_id,
      cds_score: borrowerRiskScores.cds_score,
      pci_score: borrowerRiskScores.pci_score,
      confidence: borrowerRiskScores.confidence,
      computed_at: borrowerRiskScores.computed_at,
    })
    .from(borrowerRiskScores)
    .where(eq(borrowerRiskScores.tenant_id, tenant.id));

  const riskByLoan = new Map<string, RiskScoreRow>();
  for (const r of riskRows.sort(
    (a, b) =>
      (b.computed_at?.getTime() ?? 0) - (a.computed_at?.getTime() ?? 0),
  )) {
    const key = String(r.loan_sanction_id);
    if (riskByLoan.has(key)) continue;
    riskByLoan.set(key, {
      cds_score: r.cds_score != null ? Number(r.cds_score) : null,
      pci_score: r.pci_score != null ? Number(r.pci_score) : null,
      confidence: r.confidence,
      computed_at: r.computed_at,
    });
  }

  // 2. Live state + open alerts from the VPS — wrapped to degrade if VPS down.
  let summary: Awaited<ReturnType<typeof getFleetSummary>> | null = null;
  let states: VehicleStateRow[] = [];
  let alertsByVehicle = new Map<string, number>();
  let vpsError: string | null = null;
  try {
    [summary, states, alertsByVehicle] = await Promise.all([
      getFleetSummary(vehiclenos),
      getVehicleStates(vehiclenos),
      getOpenAlerts(vehiclenos).then((alerts) => {
        const m = new Map<string, number>();
        for (const a of alerts)
          m.set(a.vehicleno, (m.get(a.vehicleno) ?? 0) + 1);
        return m;
      }),
    ]);
  } catch (e) {
    vpsError = e instanceof Error ? e.message : String(e);
  }

  const stateByVehicle = new Map(states.map((s) => [s.vehicleno, s]));

  // 3. Hydrate + filter.
  const enriched = portfolioRows.map((p) => {
    const s = stateByVehicle.get(p.vehicleno);
    const freshness = classifyFreshness(s?.last_gps_at ?? null);
    const risk = riskByLoan.get(p.loan_application_id);
    return {
      ...p,
      online: s?.online ?? false,
      lat: s?.lat ?? null,
      lon: s?.lon ?? null,
      soc_pct: s?.soc_pct ?? null,
      soh_pct: s?.soh_pct ?? null,
      pack_temp_c: s?.pack_temp_c ?? null,
      last_gps_at: s?.last_gps_at ?? null,
      freshness: freshness.freshness,
      freshness_badge: freshness.badge,
      open_alerts: alertsByVehicle.get(p.vehicleno) ?? 0,
      cds_score: risk?.cds_score ?? null,
      pci_score: risk?.pci_score ?? null,
      confidence: risk?.confidence ?? null,
      risk_computed_at: risk?.computed_at ?? null,
    };
  });

  const statusFilter = params.status?.toLowerCase();
  const severityFilter = params.severity?.toLowerCase();
  const riskFilter = params.risk?.toLowerCase();
  const q = params.q?.toLowerCase().trim() ?? "";

  const filtered = enriched.filter((r) => {
    if (statusFilter && r.freshness !== statusFilter) return false;
    if (severityFilter === "open" && r.open_alerts === 0) return false;
    if (riskFilter === "high") {
      if (r.cds_score == null || r.cds_score < bands.mid_high) return false;
    } else if (riskFilter === "low_pci") {
      if (r.pci_score == null || r.pci_score >= 0.4) return false;
    }
    if (q) {
      const hay =
        `${r.vehicleno} ${r.loan_application_id} ${r.borrower_name ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const tableRows: BatteryRow[] = filtered.map((r) => ({
    vehicleno: r.vehicleno,
    loan_application_id: r.loan_application_id,
    borrower_name: r.borrower_name,
    soc_pct: r.soc_pct,
    soh_pct: r.soh_pct,
    pack_temp_c: r.pack_temp_c,
    cds_score: r.cds_score,
    pci_score: r.pci_score,
    confidence: r.confidence,
    last_seen: r.last_gps_at ? r.last_gps_at.toISOString() : null,
    freshness: r.freshness,
    open_alerts: r.open_alerts,
  }));

  const drawerRow = params.serial
    ? enriched.find((r) => r.vehicleno === params.serial)
    : null;

  // KPI roll-ups for the CDS / PCI cards (BRD §6.1.5).
  const cdsValues = enriched
    .map((r) => r.cds_score)
    .filter((v): v is number => typeof v === "number");
  const avgCds =
    cdsValues.length === 0
      ? null
      : cdsValues.reduce((a, b) => a + b, 0) / cdsValues.length;
  const avgCdsTone =
    avgCds == null
      ? undefined
      : avgCds >= bands.mid_high
        ? "red"
        : avgCds >= bands.low_mid
          ? undefined
          : "green";
  const healthyCount = enriched.filter(
    (r) => r.pci_score != null && r.pci_score > 0.75,
  ).length;

  return (
    <div className="space-y-6">
      <header>
        <p className="section-label-muted">Battery Monitoring</p>
        <h1 className="mt-1 text-2xl font-semibold text-[color:var(--color-brand-navy)]">
          Fleet telemetry — {tenant.display_name}
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-ink-muted)]">
          Live SOC / SOH / GPS for every battery in your portfolio. Tap a row
          for the per-battery detail drawer (history charts, alerts,
          immobiliser state).
        </p>
      </header>

      {vpsError ? (
        <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          IoT VPS unreachable — showing portfolio rows only. ({vpsError})
        </div>
      ) : null}

      {drawerRow ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="section-label-muted">Selected battery</p>
            <Link
              href={`?${new URLSearchParams({
                ...(params.status ? { status: params.status } : {}),
                ...(params.severity ? { severity: params.severity } : {}),
                ...(params.risk ? { risk: params.risk } : {}),
                ...(params.q ? { q: params.q } : {}),
              }).toString()}`}
              scroll={false}
              className="text-xs font-bold uppercase tracking-widest text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-ink)]"
            >
              ✕ Close
            </Link>
          </div>
          <BatteryRowDrawer row={drawerRow} />
        </div>
      ) : null}

      {/* KPI strip */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        <Kpi label="Total" value={summary?.total ?? portfolioRows.length} />
        <Kpi label="Online" value={summary?.online ?? 0} accent="green" />
        <Kpi label="Fresh ≤5m" value={summary?.fresh_5m ?? 0} />
        <Kpi
          label="Avg SOC"
          value={
            summary?.avg_soc != null ? `${summary.avg_soc.toFixed(0)}%` : "—"
          }
        />
        <Kpi label="Open alerts" value={summary?.open_alerts ?? 0} accent="red" />
        <Kpi
          label="Avg CDS"
          value={avgCds != null ? avgCds.toFixed(0) : "—"}
          accent={avgCdsTone}
          sub={
            cdsValues.length > 0
              ? `${cdsValues.length} scored`
              : "no scores yet"
          }
        />
        <Kpi
          label="Healthy payers"
          value={healthyCount}
          accent="green"
          sub={`PCI > 0.75 / ${enriched.length} loans`}
        />
      </section>

      {/* Filter bar */}
      <form className="card-iTarang flex flex-wrap items-end gap-3 p-3">
        <div>
          <label className={FIELD_LABEL}>Status</label>
          <select
            name="status"
            defaultValue={params.status ?? ""}
            className={FIELD_INPUT}
          >
            <option value="">All</option>
            <option value="fresh">Fresh</option>
            <option value="idle">Idle</option>
            <option value="stale">Stale</option>
            <option value="offline">Offline</option>
            <option value="never">Never reported</option>
          </select>
        </div>
        <div>
          <label className={FIELD_LABEL}>Severity</label>
          <select
            name="severity"
            defaultValue={params.severity ?? ""}
            className={FIELD_INPUT}
          >
            <option value="">All</option>
            <option value="open">Open alerts only</option>
          </select>
        </div>
        <div>
          <label className={FIELD_LABEL}>Risk</label>
          <select
            name="risk"
            defaultValue={params.risk ?? ""}
            className={FIELD_INPUT}
          >
            <option value="">All</option>
            <option value="high">
              CDS ≥ {bands.mid_high} (High / Very High)
            </option>
            <option value="low_pci">PCI &lt; 0.40 (Concern)</option>
          </select>
        </div>
        <div className="min-w-[200px] flex-1">
          <label className={FIELD_LABEL}>Search</label>
          <input
            type="search"
            name="q"
            defaultValue={params.q ?? ""}
            placeholder="Serial, loan id, or borrower"
            className={`${FIELD_INPUT} w-full`}
          />
        </div>
        <button
          type="submit"
          className="rounded-lg bg-[color:var(--color-brand-navy)] px-4 py-1.5 text-sm font-bold text-white"
        >
          Apply
        </button>
        {(params.status || params.severity || params.risk || params.q) && (
          <Link
            href="/nbfc/batteries"
            className="self-center text-xs text-[color:var(--color-ink-muted)] underline"
          >
            Reset
          </Link>
        )}
      </form>

      <BatteriesTable rows={tableRows} bands={bands} />
    </div>
  );
}

function Kpi({
  label,
  value,
  accent,
  sub,
}: {
  label: string;
  value: number | string;
  accent?: "green" | "red";
  sub?: string;
}) {
  const tone =
    accent === "green"
      ? "text-[color:var(--color-success)]"
      : accent === "red"
        ? "text-[color:var(--color-danger)]"
        : "text-[color:var(--color-brand-navy)]";
  return (
    <div className="card-iTarang p-4">
      <p className="section-label-muted">{label}</p>
      <p className={`mt-2 text-2xl font-semibold tabular-nums ${tone}`}>
        {value}
      </p>
      {sub ? (
        <p className="mt-1 text-[10px] uppercase tracking-widest text-[color:var(--color-ink-muted)]">
          {sub}
        </p>
      ) : null}
    </div>
  );
}
