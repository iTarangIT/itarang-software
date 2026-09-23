/**
 * The 08:00 card, as a self-contained HTML document.
 *
 * WHY NOT SCREENSHOT /monitor ITSELF. Driving a browser to the real page needs
 * a session, and the only ways to give a bot one are a password in the
 * environment or a token-gated public route. The second is the worse of the
 * two here: any path not listed in middleware's roleDashboards is NOT treated
 * as protected, so a public snapshot route would be world-readable with a
 * query-string token as its only gate. Rendering from the same data instead
 * needs no session at all.
 *
 * The trade-off is honest: this is a RENDERING OF THE SAME DATA, not a pixel
 * copy of the page, so the two can drift visually. They cannot drift
 * numerically — both read fetchMonitorOverview(). In exchange the card is
 * shaped for a phone rather than being a 1600px desktop layout squeezed onto
 * one, which is what a screenshot of the live page would give you.
 *
 * Everything is inline: no external stylesheet, font or image, so the capture
 * never waits on the network and can never render half-styled.
 */
import {
    SILENCE_BANDS,
    SILENCE_BAND_LABELS,
    SOC_BANDS,
    freshnessPill,
    relativeAge,
} from "@/lib/telemetry/monitor-math";
import type { MonitorPeriods, MonitorOverview } from "@/lib/telemetry/monitor-queries";

const NAVY = "#02314e";
const INK = "#0f172a";
const MUTED = "#64748b";
const FAINT = "#94a3b8";
const LINE = "#e2e8f0";
const BATTERY = "#2a78d6";
const GPS = "#eb6834";
const SOC = "#0ea5e9";
const CRITICAL = "#d03b3b";

const PILL_BG: Record<string, string> = {
    live: "#059669",
    stale: "#b45309",
    frozen: "#b91c1c",
    never: "#475569",
};

const IST_DATE = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
});

function esc(s: string | number): string {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function n(v: number): string {
    return v.toLocaleString("en-IN");
}

function tile(label: string, value: string, sub: string, accent: string): string {
    return `
    <div style="flex:1;min-width:0;background:#fff;border:1px solid ${LINE};border-left:5px solid ${accent};border-radius:14px;padding:18px 20px;">
      <div style="font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${FAINT};">${esc(label)}</div>
      <div style="font-size:46px;font-weight:600;color:${INK};line-height:1.05;margin-top:8px;font-variant-numeric:tabular-nums;">${esc(value)}</div>
      <div style="font-size:14px;color:${MUTED};margin-top:6px;">${esc(sub)}</div>
    </div>`;
}

/** A labelled bar row. `pct` is 0-100 of the row's full width. */
function bar(label: string, count: number, pct: number, colour: string): string {
    return `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:7px;">
      <div style="width:62px;font-size:13px;color:${MUTED};text-align:right;">${esc(label)}</div>
      <div style="flex:1;background:#f1f5f9;border-radius:5px;height:16px;position:relative;">
        <div style="width:${Math.max(pct, count > 0 ? 1.5 : 0)}%;background:${colour};height:16px;border-radius:5px;"></div>
      </div>
      <div style="width:46px;font-size:13px;color:${INK};font-variant-numeric:tabular-nums;">${esc(n(count))}</div>
    </div>`;
}

/**
 * The Total / Last-30-days grid.
 *
 * Two columns rather than one number each, because every figure here only means
 * something against a period: 1,388 km per vehicle is unremarkable until you
 * see it beside 5,539 since April, and 24 vehicles silent for a month is a
 * different problem from the 11 that have never reported at all.
 *
 * The "total" column is labelled with its start date. An unlabelled total
 * invites someone to read five months of distance as the fleet's whole history.
 */
function periodGrid(p: MonitorPeriods): string {
    const th = `font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${FAINT};padding:0 0 10px;`;
    const td = `font-size:20px;font-weight:600;color:${INK};font-variant-numeric:tabular-nums;padding:7px 0;`;
    const rowLabel = `font-size:14px;color:${MUTED};padding:7px 0;`;

    const row = (label: string, a: string, b: string) => `
      <tr>
        <td style="${rowLabel}">${esc(label)}</td>
        <td style="${td}text-align:right;">${esc(a)}</td>
        <td style="${td}text-align:right;">${esc(b)}</td>
      </tr>`;

    const km = (v: number | null) => (v === null ? "—" : n(v));

    return `
    <div style="background:#fff;border:1px solid ${LINE};border-radius:14px;padding:18px 20px;margin-bottom:12px;">
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <th style="${th}text-align:left;"></th>
          <th style="${th}text-align:right;">${esc(p.sinceLabel ? `Since ${p.sinceLabel}` : "Total")}</th>
          <th style="${th}text-align:right;">Last 30 days</th>
        </tr>
        ${row("Vehicles", n(p.total.vehicles), n(p.last30d.vehicles))}
        ${row("Silent", n(p.total.silent), n(p.last30d.silent))}
        ${row("Avg km / vehicle", km(p.total.avgKmPerVehicle), km(p.last30d.avgKmPerVehicle))}
      </table>
      <div style="font-size:12px;color:${FAINT};margin-top:10px;line-height:1.6;">
        Vehicles: the whole fleet, against those that recorded distance in the window.
        Silent: no data at all in the period &mdash; a longer window is a stricter test,
        so the 30-day count is normally the larger one.
      </div>
    </div>`;
}

export function renderMorningCard(
    data: MonitorOverview,
    now: Date,
    periods?: MonitorPeriods | null,
): string {
    const { fleet, alerts, distance, mapping } = data;
    const pill = freshnessPill(fleet.newestSignalAgeMs);
    const max = Math.max(1, fleet.fleetSize);

    const silenceRows = SILENCE_BANDS.map((band) => {
        const b = fleet.silence.battery[band];
        const g = fleet.silence.gps[band];
        return `
        <div style="margin-bottom:10px;">
          ${bar(SILENCE_BAND_LABELS[band], b, (b / max) * 100, BATTERY)}
          ${bar("", g, (g / max) * 100, GPS)}
        </div>`;
    }).join("");

    const socMax = Math.max(1, ...SOC_BANDS.map((b) => fleet.soc.buckets[b]));
    const socBars = SOC_BANDS.map((band) => {
        const v = fleet.soc.buckets[band];
        const h = Math.round((v / socMax) * 120);
        const colour = band === "0-20" ? CRITICAL : SOC;
        return `
        <div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:6px;">
          <div style="font-size:13px;color:${MUTED};font-variant-numeric:tabular-nums;">${esc(n(v))}</div>
          <div style="width:100%;height:${Math.max(h, v > 0 ? 3 : 0)}px;background:${colour};border-radius:6px 6px 0 0;"></div>
          <div style="font-size:12px;color:${FAINT};">${esc(band)}%</div>
        </div>`;
    }).join("");

    return `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <div style="width:720px;box-sizing:border-box;">

    <div style="background:${NAVY};color:#fff;padding:20px 24px;display:flex;align-items:center;justify-content:space-between;">
      <div>
        <div style="font-size:19px;font-weight:600;letter-spacing:.02em;">Fleet Monitor</div>
        <div style="font-size:13px;color:rgba(255,255,255,.55);margin-top:3px;">${esc(IST_DATE.format(now))}</div>
      </div>
      <div style="background:${PILL_BG[pill.kind]};border-radius:999px;padding:7px 15px;font-size:13px;font-weight:700;letter-spacing:.06em;">
        ${esc(pill.label)}
      </div>
    </div>

    <div style="padding:20px 24px 24px;">

      <div style="display:flex;gap:12px;margin-bottom:12px;">
        ${tile("Live now", n(fleet.liveNow), `of ${n(fleet.fleetSize)} · ${fleet.livePct}%`, fleet.livePct >= 80 ? "#059669" : "#d97706")}
        ${tile("Silent >24h", n(fleet.silentOver24h), "was working, stopped", fleet.silentOver24h === 0 ? "#059669" : "#d97706")}
      </div>
      <div style="display:flex;gap:12px;margin-bottom:22px;">
        ${tile("Never reported", n(fleet.neverReported), "no signal on record", fleet.neverReported === 0 ? "#059669" : "#94a3b8")}
        ${tile("Alerts", n(alerts.open), "open · connectivity", alerts.open === 0 ? "#059669" : "#d97706")}
      </div>

      ${periods ? periodGrid(periods) : ""}

      <div style="background:#fff;border:1px solid ${LINE};border-radius:14px;padding:18px 20px;margin-bottom:12px;">
        <div style="font-size:16px;font-weight:600;color:${INK};">Time since last signal</div>
        <div style="font-size:13px;color:${MUTED};margin:4px 0 14px;">
          <span style="display:inline-block;width:10px;height:10px;background:${BATTERY};border-radius:2px;"></span> Battery
          &nbsp;&nbsp;
          <span style="display:inline-block;width:10px;height:10px;background:${GPS};border-radius:2px;"></span> GPS
        </div>
        ${silenceRows}
      </div>

      <div style="background:#fff;border:1px solid ${LINE};border-radius:14px;padding:18px 20px;margin-bottom:12px;">
        <div style="display:flex;align-items:baseline;justify-content:space-between;">
          <div style="font-size:16px;font-weight:600;color:${INK};">State of charge</div>
          <div style="font-size:13px;color:${fleet.soc.below20 > 0 ? CRITICAL : MUTED};">
            ${esc(n(fleet.soc.below20))} below 20%
          </div>
        </div>
        <div style="display:flex;gap:10px;align-items:flex-end;height:170px;margin-top:14px;">${socBars}</div>
      </div>

      <div style="background:#fff;border:1px solid ${LINE};border-radius:14px;padding:16px 20px;font-size:14px;color:${MUTED};line-height:1.7;">
        <div><span style="color:${INK};font-weight:600;">${esc(n(Math.round(distance.totalKm30d)))} km</span> in the last 30 days${distance.avgKmPerVehicleDay !== null ? ` · ${esc(distance.avgKmPerVehicleDay)} km per vehicle-day` : ""}</div>
        <div><span style="color:${INK};font-weight:600;">${esc(n(mapping.mapped))}</span> of ${esc(n(mapping.telemetryVehicles))} mapped to a battery${mapping.unmapped > 0 ? ` · ${esc(n(mapping.unmapped))} unmapped` : ""}</div>
        <div style="font-size:13px;color:${FAINT};margin-top:6px;">Freshness from last_battery_at / last_gps_at, never last_seen. Newest signal ${esc(relativeAge(fleet.newestSignalAgeMs))}.</div>
      </div>

    </div>
  </div>
</body></html>`;
}
