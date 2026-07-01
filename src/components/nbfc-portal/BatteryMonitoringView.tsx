/**
 * BatteryMonitoringView — shared Battery Monitoring fleet view (BRD §6.2).
 *
 * Server component extracted from /nbfc/batteries so both the NBFC partner
 * dashboard (Risk Manager) and the Risk Head dashboard can render the same
 * tenant-scoped fleet table. The only surface-specific bit is `basePath`, which
 * the KPI-tile filter links and the Reset link use so each dashboard keeps the
 * user on its own route.
 *
 * Joins:
 *   - nbfc_loans                → vehicleno + DPD + outstanding
 *   - loan_files (left)         → borrower_name + dealer_id + lead_id
 *   - leads (left)              → city
 *   - dealers (left)            → company_name
 *   - borrower_risk_scores      → latest CDS / PCI / confidence
 *   - VPS vehicle_state         → SOC / SOH / pack_temp / last_gps / online
 *   - VPS alerts                → open alert count per vehicleno
 *   - nbfc_borrower_actions     → most recent action badge per loan
 */
import Link from "next/link";
import { db } from "@/lib/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  nbfcLoans,
  loanFiles,
  loanApplications,
  loanSanctions,
  leads,
  dealers,
  nbfcRiskRules,
  nbfcBorrowerActions,
  inventory,
} from "@/lib/db/schema";
import { getCurrentTenant, requireNbfcAccess } from "@/lib/nbfc/tenant";
import { computeLiveScores } from "@/lib/nbfc/cds/liveScores";
import {
  getFleetSummary,
  getVehicleStates,
  getOpenAlerts,
  type VehicleStateRow,
} from "@/lib/db/iot-queries";
import { classifyFreshness } from "@/lib/iot/freshness";
import BatteriesTable, {
  type BatteryRow,
} from "@/app/(dashboard)/nbfc/batteries/_components/BatteriesTable";
import BatteriesCsvButton from "@/app/(dashboard)/nbfc/batteries/_components/BatteriesCsvButton";

export interface BatteryMonitoringSearchParams {
  status?: string;
  severity?: string;
  risk?: string;
  q?: string;
  city?: string;
  emi?: string;
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
  imei: string | null;
  current_dpd: number | null;
  outstanding_amount: number | null;
  emi_amount: number | null;
  borrower_name: string | null;
  dealer_name: string | null;
  city: string | null;
}

const FIELD_LABEL =
  "block text-[10px] font-bold uppercase tracking-widest text-[color:var(--color-ink-muted)] mb-1";
const FIELD_INPUT =
  "border border-[color:var(--color-border)] rounded-lg px-2.5 py-1.5 text-sm bg-[color:var(--color-surface)]";

const ACTION_BADGE_LABEL: Record<string, string> = {
  immobilisation: "Immobilization Pending",
};

function badgeFromAction(
  status: string | null,
  actionType: string | null,
): string | null {
  if (!actionType) return null;
  if (actionType === "immobilisation") {
    if (status === "rejected") return "Immobilization Rejected";
    if (status === "reversed") return "Force Majeure";
    if (status === "approved") return "Immobilised";
    if (status === "pending_dual_approval") return "Immobilization Pending";
  }
  return ACTION_BADGE_LABEL[actionType] ?? null;
}

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

export default async function BatteryMonitoringView({
  searchParams,
  basePath = "/nbfc/batteries",
}: {
  searchParams: Promise<BatteryMonitoringSearchParams>;
  basePath?: string;
}) {
  const tenant = await getCurrentTenant();
  await requireNbfcAccess(tenant.id);
  const params = (await searchParams) ?? {};

  const bands = await loadCdsBands();

  // 1. Portfolio rows + borrower context + dealer name + city (lead.city).
  const portfolio = (await db
    .select({
      loan_application_id: nbfcLoans.loan_application_id,
      vehicleno: nbfcLoans.vehicleno,
      current_dpd: nbfcLoans.current_dpd,
      outstanding_amount: nbfcLoans.outstanding_amount,
      emi_amount: nbfcLoans.emi_amount,
      borrower_name_file: loanFiles.borrower_name,
      borrower_name_app: loanApplications.applicant_name,
      dealer_id_file: loanFiles.dealer_id,
      dealer_id_app: loanApplications.dealer_id,
      lead_id_file: loanFiles.lead_id,
      lead_id_app: loanApplications.lead_id,
      sanction_lead_id: loanSanctions.lead_id,
    })
    .from(nbfcLoans)
    .leftJoin(
      loanFiles,
      eq(loanFiles.loan_application_id, nbfcLoans.loan_application_id),
    )
    .leftJoin(
      loanApplications,
      eq(loanApplications.id, nbfcLoans.loan_application_id),
    )
    .leftJoin(loanSanctions, eq(loanSanctions.id, nbfcLoans.loan_application_id))
    .where(
      and(eq(nbfcLoans.tenant_id, tenant.id), eq(nbfcLoans.is_active, true)),
    )) as Array<{
    loan_application_id: string;
    vehicleno: string | null;
    current_dpd: number | null;
    outstanding_amount: string | null;
    emi_amount: string | null;
    borrower_name_file: string | null;
    borrower_name_app: string | null;
    dealer_id_file: string | null;
    dealer_id_app: string | null;
    lead_id_file: string | null;
    lead_id_app: string | null;
    sanction_lead_id: string | null;
  }>;

  const leadIds = Array.from(
    new Set(
      portfolio
        .map((r) => r.lead_id_file ?? r.lead_id_app ?? r.sanction_lead_id)
        .filter((l): l is string => !!l),
    ),
  );

  interface LeadInfo {
    full_name: string | null;
    owner_name: string | null;
    dealer_id: string | null;
    city: string | null;
  }
  const leadInfoById = new Map<string, LeadInfo>();
  if (leadIds.length > 0) {
    const leadRows = await db
      .select({
        id: leads.id,
        full_name: leads.full_name,
        owner_name: leads.owner_name,
        dealer_id: leads.dealer_id,
        city: leads.city,
      })
      .from(leads)
      .where(inArray(leads.id, leadIds));
    for (const l of leadRows) {
      leadInfoById.set(l.id, {
        full_name: l.full_name,
        owner_name: l.owner_name,
        dealer_id: l.dealer_id,
        city: l.city ?? null,
      });
    }
  }

  const dealerIds = Array.from(
    new Set(
      [
        ...portfolio.map((r) => r.dealer_id_file ?? r.dealer_id_app),
        ...Array.from(leadInfoById.values()).map((l) => l.dealer_id),
      ].filter((d): d is string => !!d),
    ),
  );

  const dealerNameById = new Map<string, string>();
  if (dealerIds.length > 0) {
    const dealerRows = await db
      .select({
        dealer_id: dealers.dealer_id,
        company_name: dealers.company_name,
      })
      .from(dealers)
      .where(inArray(dealers.dealer_id, dealerIds));
    for (const d of dealerRows) {
      if (d.dealer_id) dealerNameById.set(d.dealer_id, d.company_name);
    }
  }

  const serials = Array.from(
    new Set(
      portfolio.map((r) => r.vehicleno).filter((v): v is string => !!v),
    ),
  );
  const imeiBySerial = new Map<string, string | null>();
  if (serials.length > 0) {
    const invRows = await db
      .select({
        serial_number: inventory.serial_number,
        iot_imei_no: inventory.iot_imei_no,
      })
      .from(inventory)
      .where(inArray(inventory.serial_number, serials));
    for (const i of invRows) {
      if (i.serial_number) imeiBySerial.set(i.serial_number, i.iot_imei_no);
    }
  }

  const portfolioRows: PortfolioRow[] = portfolio
    .filter((r): r is typeof r & { vehicleno: string } => !!r.vehicleno)
    .map((r) => {
      const leadId = r.lead_id_file ?? r.lead_id_app ?? r.sanction_lead_id;
      const lead = leadId ? leadInfoById.get(leadId) : undefined;
      const dealerId =
        r.dealer_id_file ?? r.dealer_id_app ?? lead?.dealer_id ?? null;
      return {
        loan_application_id: r.loan_application_id,
        vehicleno: r.vehicleno,
        imei: imeiBySerial.get(r.vehicleno) ?? null,
        current_dpd: r.current_dpd,
        outstanding_amount:
          r.outstanding_amount != null ? Number(r.outstanding_amount) : null,
        emi_amount: r.emi_amount != null ? Number(r.emi_amount) : null,
        borrower_name:
          r.borrower_name_file ??
          r.borrower_name_app ??
          lead?.full_name ??
          lead?.owner_name ??
          null,
        dealer_name: dealerId ? dealerNameById.get(dealerId) ?? null : null,
        city: lead?.city ?? null,
      };
    });

  const vehiclenos = portfolioRows.map((r) => r.vehicleno);
  const loanIds = portfolioRows.map((r) => r.loan_application_id);

  // CDS/PCI are computed LIVE from the current EMI window (not read from the
  // nightly `borrower_risk_scores` snapshot) so the displayed score tracks EMI
  // changes immediately — a payment landing or a status flip moves the number
  // on the next load, with no manual re-score. Same engine helpers as the job,
  // so the value matches the explainability drawer to the cent.
  const liveScores = await computeLiveScores(tenant.id, loanIds);
  const riskByLoan = new Map<string, RiskScoreRow>();
  for (const [loanId, s] of liveScores.entries()) {
    riskByLoan.set(loanId, {
      cds_score: s.cds_score,
      pci_score: s.pci_score,
      confidence: s.confidence,
      computed_at: s.computed_at,
    });
  }

  const actionBadgeByLoan = new Map<string, string>();
  if (loanIds.length > 0) {
    const actionRows = await db
      .select({
        loan_sanction_id: nbfcBorrowerActions.loan_sanction_id,
        action_type: nbfcBorrowerActions.action_type,
        status: nbfcBorrowerActions.status,
        created_at: nbfcBorrowerActions.created_at,
      })
      .from(nbfcBorrowerActions)
      .where(
        and(
          eq(nbfcBorrowerActions.tenant_id, tenant.id),
          inArray(nbfcBorrowerActions.loan_sanction_id, loanIds),
        ),
      )
      .orderBy(desc(nbfcBorrowerActions.created_at));
    for (const r of actionRows) {
      if (actionBadgeByLoan.has(r.loan_sanction_id)) continue;
      const badge = badgeFromAction(r.status, r.action_type);
      if (badge) actionBadgeByLoan.set(r.loan_sanction_id, badge);
    }
  }

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
      last_action_badge: actionBadgeByLoan.get(p.loan_application_id) ?? null,
    };
  });

  const statusFilter = params.status?.toLowerCase();
  const severityFilter = params.severity?.toLowerCase();
  const riskFilter = params.risk?.toLowerCase();
  const cityFilter = params.city?.toLowerCase();
  const emiFilter = params.emi?.toLowerCase();
  const q = params.q?.toLowerCase().trim() ?? "";

  const filtered = enriched.filter((r) => {
    if (statusFilter && r.freshness !== statusFilter) return false;
    if (severityFilter === "open" && r.open_alerts === 0) return false;
    if (riskFilter === "critical") {
      if (r.open_alerts === 0) return false;
      if (r.cds_score == null || r.cds_score < bands.mid_high) return false;
    } else if (riskFilter === "warning") {
      if (r.cds_score == null || r.cds_score < bands.low_mid) return false;
      if (r.cds_score >= bands.mid_high && r.open_alerts > 0) return false;
    } else if (riskFilter === "info") {
      if ((r.cds_score ?? 0) >= bands.low_mid) return false;
    } else if (riskFilter === "geo") {
      if (r.lat == null || r.lon == null) return false;
    }
    if (cityFilter && (r.city ?? "").toLowerCase() !== cityFilter) return false;
    if (emiFilter === "overdue" && (r.current_dpd ?? 0) === 0) return false;
    if (emiFilter === "ontime" && (r.current_dpd ?? 0) > 0) return false;
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
    dealer_name: r.dealer_name,
    city: r.city,
    imei: r.imei,
    emi_amount: r.emi_amount,
    current_dpd: r.current_dpd,
    soc_pct: r.soc_pct,
    soh_pct: r.soh_pct,
    pack_temp_c: r.pack_temp_c,
    cds_score: r.cds_score,
    pci_score: r.pci_score,
    confidence: r.confidence,
    last_seen: r.last_gps_at ? r.last_gps_at.toISOString() : null,
    freshness: r.freshness,
    open_alerts: r.open_alerts,
    last_action_badge: r.last_action_badge,
  }));

  const criticalCount = enriched.filter(
    (r) =>
      r.open_alerts > 0 && r.cds_score != null && r.cds_score >= bands.mid_high,
  ).length;
  const warningCount = enriched.filter(
    (r) =>
      r.cds_score != null &&
      r.cds_score >= bands.low_mid &&
      (r.cds_score < bands.mid_high || r.open_alerts === 0),
  ).length;
  const infoCount = enriched.filter(
    (r) => r.cds_score == null || r.cds_score < bands.low_mid,
  ).length;
  const geoCount = enriched.filter(
    (r) => r.lat != null && r.lon != null,
  ).length;

  const cityOptions = Array.from(
    new Set(enriched.map((r) => r.city).filter((c): c is string => !!c)),
  ).sort();

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <p className="section-label-muted">Battery Monitoring</p>
          <h1 className="mt-1 text-2xl font-semibold text-[color:var(--color-brand-navy)]">
            Fleet telemetry — {tenant.display_name}
          </h1>
          <p className="mt-1 text-sm text-[color:var(--color-ink-muted)]">
            Post-disbursement control · tiles and headers filter + sort the
            master table. Tap any row to open the case workspace.
          </p>
        </div>
        <BatteriesCsvButton rows={tableRows} />
      </header>

      {vpsError ? (
        <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          IoT VPS unreachable — showing portfolio rows only. ({vpsError})
        </div>
      ) : null}

      <section>
        <p className="section-label-muted">Real-time alerts</p>
        <p className="mt-1 text-xs text-[color:var(--color-ink-muted)]">
          Live from telemetry · click a tile to filter the table below
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiTile
            label="Critical"
            value={criticalCount}
            tone="red"
            icon="⚠"
            href={qs(basePath, params, { risk: "critical" })}
            active={riskFilter === "critical"}
          />
          <KpiTile
            label="Warning"
            value={warningCount}
            tone="amber"
            icon="⚠"
            href={qs(basePath, params, { risk: "warning" })}
            active={riskFilter === "warning"}
          />
          <KpiTile
            label="Info"
            value={infoCount}
            tone="sky"
            icon="ⓘ"
            href={qs(basePath, params, { risk: "info" })}
            active={riskFilter === "info"}
          />
          <KpiTile
            label="Geo Variation"
            value={geoCount}
            tone="red"
            icon="📍"
            href={qs(basePath, params, { risk: "geo" })}
            active={riskFilter === "geo"}
          />
        </div>
      </section>

      <form className="card-iTarang flex flex-wrap items-end gap-3 p-3">
        <div>
          <label className={FIELD_LABEL}>EMI</label>
          <select name="emi" defaultValue={params.emi ?? ""} className={FIELD_INPUT}>
            <option value="">All</option>
            <option value="ontime">On time</option>
            <option value="overdue">Overdue</option>
          </select>
        </div>
        <div>
          <label className={FIELD_LABEL}>City</label>
          <select name="city" defaultValue={params.city ?? ""} className={FIELD_INPUT}>
            <option value="">All</option>
            {cityOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={FIELD_LABEL}>Status</label>
          <select name="status" defaultValue={params.status ?? ""} className={FIELD_INPUT}>
            <option value="">All</option>
            <option value="fresh">Fresh</option>
            <option value="idle">Idle</option>
            <option value="stale">Stale</option>
            <option value="offline">Offline</option>
            <option value="never">Never reported</option>
          </select>
        </div>
        <div className="min-w-[200px] flex-1">
          <label className={FIELD_LABEL}>Search</label>
          <input
            type="search"
            name="q"
            defaultValue={params.q ?? ""}
            placeholder="Battery / IMEI / name"
            className={`${FIELD_INPUT} w-full`}
          />
        </div>
        {params.risk ? (
          <input type="hidden" name="risk" value={params.risk} />
        ) : null}
        <button
          type="submit"
          className="rounded-lg bg-[color:var(--color-brand-navy)] px-4 py-1.5 text-sm font-bold text-white"
        >
          Apply
        </button>
        {(params.status ||
          params.severity ||
          params.risk ||
          params.q ||
          params.city ||
          params.emi) && (
          <Link
            href={basePath}
            className="self-center text-xs text-[color:var(--color-ink-muted)] underline"
          >
            Reset
          </Link>
        )}
      </form>

      <section>
        <p className="section-label-muted">Battery risk master table</p>
        <p className="mt-1 text-xs text-[color:var(--color-ink-muted)]">
          {tableRows.length} of {enriched.length} batteries · click any row to
          open case workspace · click headers to sort
        </p>
        <div className="mt-3">
          <BatteriesTable rows={tableRows} bands={bands} />
        </div>
        {summary ? (
          <p className="mt-2 text-[11px] text-[color:var(--color-ink-muted)]">
            Fleet aggregates: {summary.total} total · {summary.online} online ·{" "}
            {summary.fresh_5m} fresh ≤5m · avg SOC{" "}
            {summary.avg_soc != null ? `${summary.avg_soc.toFixed(0)}%` : "—"}
          </p>
        ) : null}
      </section>
    </div>
  );
}

function qs(
  basePath: string,
  current: BatteryMonitoringSearchParams,
  next: Partial<BatteryMonitoringSearchParams>,
): string {
  const sp = new URLSearchParams();
  const merged = { ...current, ...next };
  for (const [k, v] of Object.entries(merged)) {
    if (v) sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `${basePath}?${s}` : basePath;
}

function KpiTile({
  label,
  value,
  tone,
  icon,
  href,
  active,
}: {
  label: string;
  value: number;
  tone: "red" | "amber" | "sky";
  icon: string;
  href: string;
  active: boolean;
}) {
  const toneText =
    tone === "red"
      ? "text-red-600"
      : tone === "amber"
        ? "text-amber-600"
        : "text-sky-600";
  const toneBg =
    tone === "red" ? "bg-red-50" : tone === "amber" ? "bg-amber-50" : "bg-sky-50";
  return (
    <Link
      href={href}
      className={`card-iTarang block p-4 transition ${
        active ? `${toneBg} ring-2 ring-offset-1` : ""
      }`}
    >
      <div
        className={`flex items-center gap-2 text-xs font-bold uppercase tracking-widest ${toneText}`}
      >
        <span aria-hidden>{icon}</span>
        <span>{label}</span>
      </div>
      <p className={`mt-2 text-3xl font-semibold tabular-nums ${toneText}`}>
        {value}
      </p>
      <p className="mt-1 text-[10px] uppercase tracking-widest text-[color:var(--color-ink-muted)]">
        {active ? "Filtered" : "Click to filter"}
      </p>
    </Link>
  );
}
