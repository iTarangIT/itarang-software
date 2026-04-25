import { getCurrentTenant, getTenantLoanSlice } from "@/lib/nbfc/tenant";
import { getFleetSummary } from "@/lib/db/iot-queries";

export const dynamic = "force-dynamic"; // always pull fresh

function fmtNum(n: number | null | undefined, suffix = "") {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 1 }) + suffix;
}

export default async function NbfcOverview() {
  const tenant = await getCurrentTenant();
  const loans = await getTenantLoanSlice(tenant.id);
  const vehiclenos = loans
    .map((l) => l.vehicleno)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  const summary = await getFleetSummary(vehiclenos);

  const tiles = [
    { label: "Active Loans", value: loans.length },
    { label: "Vehicles Tracked", value: summary.total },
    { label: "Online (1h)", value: summary.online, accent: "text-emerald-600" },
    { label: "Reporting (5m)", value: summary.fresh_5m },
    { label: "With GPS Fix", value: summary.with_lat },
    { label: "Avg SOC", value: fmtNum(summary.avg_soc, "%") },
    { label: "Avg Pack V", value: fmtNum(summary.avg_pack_voltage, " V") },
    { label: "Open Alerts", value: summary.open_alerts, accent: "text-red-600" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Overview</h1>
        <p className="text-sm text-slate-500 mt-1">Fleet health for {tenant.display_name}</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {tiles.map((t) => (
          <div
            key={t.label}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-4 py-3"
          >
            <div className="text-xs uppercase tracking-wider text-slate-500">{t.label}</div>
            <div className={`text-2xl font-semibold mt-1 ${t.accent ?? ""}`}>
              {typeof t.value === "number" ? t.value.toLocaleString("en-IN") : t.value}
            </div>
          </div>
        ))}
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6">
        <h2 className="text-base font-semibold">What you can do here</h2>
        <ul className="mt-3 space-y-2 text-sm text-slate-600 dark:text-slate-400 list-disc pl-5">
          <li>
            Visit <a className="text-sky-600 hover:underline" href="/nbfc/risk">Risk</a> for
            hypothesis-driven cards prioritising your highest-attention borrowers.
          </li>
          <li>
            Visit <a className="text-sky-600 hover:underline" href="/nbfc/batteries">Batteries</a>{" "}
            for SOH degradation drill-downs.
          </li>
          <li>
            Visit <a className="text-sky-600 hover:underline" href="/nbfc/recovery">Recovery</a>{" "}
            for the repossession queue (Phase D).
          </li>
        </ul>
      </div>
    </div>
  );
}
