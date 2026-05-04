/**
 * /nbfc/batteries — Battery Monitoring (BRD §6.2)
 *
 * Server-rendered fleet table for the current tenant. Joins the local
 * nbfc_loans portfolio (for borrower/loan context) with the VPS vehicle_state
 * table (for SOC/SOH/last_seen/online/lat-lon) and the VPS alerts table
 * (open-alert count per vehicleno). Row click reveals a drawer with deeper
 * telemetry — those endpoints already exist.
 *
 * Filters are URL-driven: ?status=online|idle|stale|offline|never &severity=open
 * &q=<text> &serial=<one to auto-open>.
 */
import Link from "next/link";
import { db } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { nbfcLoans, loanFiles } from "@/lib/db/schema";
import { getCurrentTenant, requireNbfcAccess } from "@/lib/nbfc/tenant";
import {
  getFleetSummary,
  getVehicleStates,
  getOpenAlerts,
  type VehicleStateRow,
} from "@/lib/db/iot-queries";
import { classifyFreshness } from "@/lib/iot/freshness";
import BatteryRowDrawer from "./_components/BatteryRowDrawer";

export const dynamic = "force-dynamic";

interface SearchParams {
  status?: string;
  severity?: string;
  q?: string;
  serial?: string;
}

interface PortfolioRow {
  loan_application_id: string;
  vehicleno: string;
  current_dpd: number | null;
  outstanding_amount: number | null;
  borrower_name: string | null;
}

const FRESHNESS_TONE: Record<string, string> = {
  fresh: "bg-emerald-50 text-emerald-700",
  idle: "bg-amber-50 text-amber-700",
  stale: "bg-orange-50 text-orange-700",
  offline: "bg-red-50 text-red-700",
  never: "bg-gray-100 text-gray-500",
};

export default async function BatteriesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const tenant = await getCurrentTenant();
  await requireNbfcAccess(tenant.id);
  const params = (await searchParams) ?? {};

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
    .leftJoin(loanFiles, eq(loanFiles.loan_application_id, nbfcLoans.loan_application_id))
    .where(and(eq(nbfcLoans.tenant_id, tenant.id), eq(nbfcLoans.is_active, true)))) as Array<{
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
      outstanding_amount: r.outstanding_amount != null ? Number(r.outstanding_amount) : null,
      borrower_name: r.borrower_name,
    }));

  const vehiclenos = portfolioRows.map((r) => r.vehicleno);

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
        for (const a of alerts) m.set(a.vehicleno, (m.get(a.vehicleno) ?? 0) + 1);
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
    };
  });

  const statusFilter = params.status?.toLowerCase();
  const severityFilter = params.severity?.toLowerCase();
  const q = params.q?.toLowerCase().trim() ?? "";

  const filtered = enriched.filter((r) => {
    if (statusFilter && r.freshness !== statusFilter) return false;
    if (severityFilter === "open" && r.open_alerts === 0) return false;
    if (q) {
      const hay = `${r.vehicleno} ${r.loan_application_id} ${r.borrower_name ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const drawerRow = params.serial ? enriched.find((r) => r.vehicleno === params.serial) : null;

  return (
    <div className="space-y-6">
      <header>
        <p className="section-label-muted">Battery Monitoring</p>
        <h1 className="text-2xl font-semibold text-[color:var(--color-brand-navy)] mt-1">
          Fleet telemetry — {tenant.display_name}
        </h1>
        <p className="text-sm text-[color:var(--color-ink-muted)] mt-1">
          Live SOC / SOH / GPS for every battery in your portfolio. Click a row for the
          per-battery detail drawer (history charts, alerts, immobiliser state).
        </p>
      </header>

      {vpsError ? (
        <div className="border border-amber-200 bg-amber-50 text-amber-900 text-sm rounded p-3">
          IoT VPS unreachable — showing portfolio rows only. ({vpsError})
        </div>
      ) : null}

      {/* KPI strip */}
      <section className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <Kpi label="Total" value={summary?.total ?? portfolioRows.length} />
        <Kpi label="Online" value={summary?.online ?? 0} accent="green" />
        <Kpi label="Fresh ≤5m" value={summary?.fresh_5m ?? 0} />
        <Kpi
          label="Avg SOC"
          value={summary?.avg_soc != null ? `${summary.avg_soc.toFixed(0)}%` : "—"}
        />
        <Kpi label="Open alerts" value={summary?.open_alerts ?? 0} accent="red" />
      </section>

      {/* Filter bar */}
      <form className="flex flex-wrap items-end gap-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-3">
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">
            Status
          </label>
          <select name="status" defaultValue={params.status ?? ""} className="border rounded px-2 py-1 text-sm">
            <option value="">All</option>
            <option value="fresh">Fresh</option>
            <option value="idle">Idle</option>
            <option value="stale">Stale</option>
            <option value="offline">Offline</option>
            <option value="never">Never reported</option>
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">
            Severity
          </label>
          <select name="severity" defaultValue={params.severity ?? ""} className="border rounded px-2 py-1 text-sm">
            <option value="">All</option>
            <option value="open">Open alerts only</option>
          </select>
        </div>
        <div className="flex-1 min-w-[200px]">
          <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">
            Search
          </label>
          <input
            type="search"
            name="q"
            defaultValue={params.q ?? ""}
            placeholder="Serial, loan id, or borrower"
            className="border rounded px-2 py-1 text-sm w-full"
          />
        </div>
        <button
          type="submit"
          className="px-4 py-1.5 text-sm font-bold bg-[color:var(--color-brand-navy)] text-white rounded"
        >
          Apply
        </button>
        {(params.status || params.severity || params.q) && (
          <Link href="/nbfc/batteries" className="text-xs underline text-slate-500 self-center">
            Reset
          </Link>
        )}
      </form>

      {/* Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-900 text-xs uppercase tracking-widest text-slate-500">
            <tr>
              <th className="px-3 py-2.5 text-left font-bold">Serial / Vehicle</th>
              <th className="px-3 py-2.5 text-left font-bold">Borrower</th>
              <th className="px-3 py-2.5 text-right font-bold">SOC</th>
              <th className="px-3 py-2.5 text-right font-bold">SOH</th>
              <th className="px-3 py-2.5 text-right font-bold">Temp</th>
              <th className="px-3 py-2.5 text-left font-bold">Last seen</th>
              <th className="px-3 py-2.5 text-left font-bold">Freshness</th>
              <th className="px-3 py-2.5 text-right font-bold">Alerts</th>
              <th className="px-3 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-3 py-12 text-center text-slate-500 text-sm">
                  No batteries match these filters.
                </td>
              </tr>
            ) : (
              filtered.map((r) => (
                <tr key={r.vehicleno} className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                  <td className="px-3 py-2 font-mono text-xs">{r.vehicleno}</td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{r.borrower_name ?? "—"}</div>
                    <div className="text-xs text-slate-500">{r.loan_application_id}</div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.soc_pct != null ? `${Math.round(r.soc_pct)}%` : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.soh_pct != null ? `${Math.round(r.soh_pct)}%` : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.pack_temp_c != null ? `${r.pack_temp_c.toFixed(0)}°C` : "—"}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500 tabular-nums">
                    {r.last_gps_at ? r.last_gps_at.toLocaleString() : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 rounded text-xs font-bold uppercase ${FRESHNESS_TONE[r.freshness]}`}>
                      {r.freshness}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {r.open_alerts > 0 ? (
                      <span className="px-2 py-0.5 rounded bg-red-50 text-red-700 text-xs font-bold tabular-nums">
                        {r.open_alerts}
                      </span>
                    ) : (
                      <span className="text-slate-400">0</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Link
                      href={`?${new URLSearchParams({
                        ...(params.status ? { status: params.status } : {}),
                        ...(params.severity ? { severity: params.severity } : {}),
                        ...(params.q ? { q: params.q } : {}),
                        serial: r.vehicleno,
                      }).toString()}`}
                      scroll={false}
                      className="text-xs font-bold uppercase tracking-widest text-[color:var(--color-brand-navy)] hover:underline"
                    >
                      Open
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {drawerRow ? <BatteryRowDrawer row={drawerRow} /> : null}
    </div>
  );
}

function Kpi({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent?: "green" | "red";
}) {
  const tone =
    accent === "green"
      ? "text-emerald-600"
      : accent === "red"
        ? "text-red-600"
        : "text-[color:var(--color-brand-navy)]";
  return (
    <div className="card-iTarang p-4">
      <p className="section-label-muted">{label}</p>
      <p className={`mt-2 text-2xl font-semibold tabular-nums ${tone}`}>{value}</p>
    </div>
  );
}
