/**
 * Per-battery detail drawer — server component. Fetches:
 *   - battery_health_metrics (latest row for this vehicleno) → SOH trend + EOL date
 *   - geofence_events (last 30 days)
 *   - immobilizer_state (current)
 *   - charge_events (last 30 days)
 *   - fault_codes (open only)
 *
 * All five queries degrade gracefully via the helpers in
 * src/lib/db/iot-queries.ts when the VPS tables don't yet exist.
 */
import {
  getBatteryHealth,
  getGeofenceEvents,
  getImmobilizerState,
  getChargeEvents,
  getOpenFaultCodes,
} from "@/lib/db/iot-queries";

interface RowProps {
  row: {
    loan_application_id: string;
    vehicleno: string;
    borrower_name: string | null;
    current_dpd: number | null;
    outstanding_amount: number | null;
    soc_pct: number | null;
    soh_pct: number | null;
    pack_temp_c: number | null;
    online: boolean;
    last_gps_at: Date | null;
    freshness: string;
    open_alerts: number;
    lat: number | null;
    lon: number | null;
  };
}

export default async function BatteryRowDrawer({ row }: RowProps) {
  let health: Awaited<ReturnType<typeof getBatteryHealth>> = null;
  let geofence: Awaited<ReturnType<typeof getGeofenceEvents>> = [];
  let immobilizer: Awaited<ReturnType<typeof getImmobilizerState>> = null;
  let charges: Awaited<ReturnType<typeof getChargeEvents>> = [];
  let faults: Awaited<ReturnType<typeof getOpenFaultCodes>> = [];
  let vpsError: string | null = null;
  try {
    [health, geofence, immobilizer, charges, faults] = await Promise.all([
      getBatteryHealth(row.vehicleno),
      getGeofenceEvents(row.vehicleno, 30),
      getImmobilizerState(row.vehicleno),
      getChargeEvents(row.vehicleno, 30),
      getOpenFaultCodes(row.vehicleno),
    ]);
  } catch (e) {
    vpsError = e instanceof Error ? e.message : String(e);
  }

  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="section-label-muted">Battery detail</p>
          <h2 className="text-lg font-semibold mt-1">{row.vehicleno}</h2>
          <p className="text-sm text-slate-500">
            {row.borrower_name ?? "—"} · loan {row.loan_application_id}
          </p>
        </div>
        <div className="text-right text-xs text-slate-500">
          <div>DPD: <span className="font-bold text-slate-900">{row.current_dpd ?? 0}d</span></div>
          {row.outstanding_amount != null ? (
            <div>
              Outstanding: <span className="font-bold text-slate-900">₹{row.outstanding_amount.toLocaleString("en-IN")}</span>
            </div>
          ) : null}
        </div>
      </header>

      {vpsError ? (
        <div className="border border-amber-200 bg-amber-50 text-amber-900 text-xs rounded p-2">
          IoT VPS unreachable — telemetry detail unavailable. ({vpsError})
        </div>
      ) : null}

      {/* Live gauges */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Gauge label="SOC" value={row.soc_pct} suffix="%" />
        <Gauge label="SOH" value={row.soh_pct} suffix="%" />
        <Gauge label="Pack Temp" value={row.pack_temp_c} suffix="°C" />
        <Gauge label="Online" value={row.online ? "Yes" : "No"} />
      </div>

      {/* Health + immobilizer */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Panel title="Battery health (last sample)">
          {health ? (
            <ul className="text-sm space-y-1">
              <li>SOH: <strong>{health.soh_pct.toFixed(1)}%</strong> ({health.sample_date.toDateString()})</li>
              {health.degradation_rate_30d != null ? (
                <li>30d degradation: <strong>{health.degradation_rate_30d.toFixed(3)} pp/day</strong></li>
              ) : null}
              {health.predicted_eol_date ? (
                <li>Predicted EOL (60% SOH): <strong>{health.predicted_eol_date.toDateString()}</strong></li>
              ) : null}
              {health.cycles_since_install != null ? (
                <li>Charge cycles: <strong>{health.cycles_since_install.toLocaleString("en-IN")}</strong></li>
              ) : null}
            </ul>
          ) : (
            <NoData>battery_health_metrics not populated yet on the VPS.</NoData>
          )}
        </Panel>

        <Panel title="Immobilizer state">
          {immobilizer ? (
            <div className="text-sm space-y-1">
              <div>
                Status:{" "}
                <span
                  className={`px-2 py-0.5 rounded text-xs font-bold uppercase ${
                    immobilizer.enabled ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"
                  }`}
                >
                  {immobilizer.enabled ? "Immobilised" : "Mobile"}
                </span>
              </div>
              {immobilizer.last_toggled_at ? (
                <div className="text-xs text-slate-500">
                  Last toggled {immobilizer.last_toggled_at.toLocaleString()}
                </div>
              ) : null}
              {immobilizer.last_reason ? (
                <div className="text-xs text-slate-500">Reason: {immobilizer.last_reason}</div>
              ) : null}
              {immobilizer.last_request_id ? (
                <div className="text-xs font-mono text-slate-400">req {immobilizer.last_request_id}</div>
              ) : null}
            </div>
          ) : (
            <NoData>No immobilizer state recorded.</NoData>
          )}
        </Panel>

        <Panel title="Open fault codes">
          {faults.length === 0 ? (
            <NoData>No open faults.</NoData>
          ) : (
            <ul className="text-sm space-y-1">
              {faults.map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs">{f.dtc_code}</span>
                  <span className="flex-1 text-xs text-slate-600 truncate">{f.description ?? ""}</span>
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${
                      f.severity === "critical"
                        ? "bg-red-50 text-red-700"
                        : f.severity === "warning"
                          ? "bg-amber-50 text-amber-700"
                          : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {f.severity}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Recent geofence events (30d)">
          {geofence.length === 0 ? (
            <NoData>No geofence events.</NoData>
          ) : (
            <ul className="text-xs space-y-1">
              {geofence.slice(0, 8).map((g) => (
                <li key={g.id} className="flex justify-between gap-2">
                  <span className="text-slate-500 tabular-nums">{g.event_time.toLocaleString()}</span>
                  <span className="uppercase font-bold text-slate-700">{g.event_type}</span>
                  <span className="text-slate-500">
                    {g.distance_km != null ? `${g.distance_km.toFixed(1)} km` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Charge events (30d)">
          {charges.length === 0 ? (
            <NoData>No charge sessions.</NoData>
          ) : (
            <ul className="text-xs space-y-1">
              {charges.slice(0, 8).map((c) => (
                <li key={c.id} className="flex justify-between gap-2">
                  <span className="text-slate-500 tabular-nums">{c.start_time.toLocaleString()}</span>
                  <span>
                    {c.start_soc_pct != null && c.end_soc_pct != null
                      ? `${Math.round(c.start_soc_pct)}→${Math.round(c.end_soc_pct)}%`
                      : "—"}
                  </span>
                  <span className="text-slate-500">
                    {c.energy_kwh != null ? `${c.energy_kwh.toFixed(2)} kWh` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Last GPS fix">
          {row.lat != null && row.lon != null ? (
            <div className="text-sm">
              <div className="font-mono text-xs">
                {row.lat.toFixed(5)}, {row.lon.toFixed(5)}
              </div>
              <a
                href={`https://www.openstreetmap.org/?mlat=${row.lat}&mlon=${row.lon}#map=15/${row.lat}/${row.lon}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs underline text-[color:var(--color-brand-navy)]"
              >
                View on OpenStreetMap →
              </a>
              <div className="text-xs text-slate-500 mt-1">
                Last seen {row.last_gps_at?.toLocaleString() ?? "—"}
              </div>
            </div>
          ) : (
            <NoData>No GPS fix recorded.</NoData>
          )}
        </Panel>
      </div>

      <p className="text-xs text-slate-500">
        Detail timeseries (SOC, SOH, GPS) available at{" "}
        <code>/api/nbfc/iot/battery/{row.vehicleno}/history?metric=soc</code> &mdash; chart wiring lands
        in a follow-up unit.
      </p>
    </section>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded-md p-3">
      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-2">{title}</p>
      {children}
    </div>
  );
}

function Gauge({
  label,
  value,
  suffix,
}: {
  label: string;
  value: number | string | null;
  suffix?: string;
}) {
  const display =
    value == null
      ? "—"
      : typeof value === "number"
        ? `${Math.round(value)}${suffix ?? ""}`
        : value;
  return (
    <div className="card-iTarang p-3 text-center">
      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</p>
      <p className="text-xl font-semibold tabular-nums mt-1">{display}</p>
    </div>
  );
}

function NoData({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-slate-400 italic">{children}</p>;
}
