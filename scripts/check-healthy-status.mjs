// One-off: validate the new "disconnected" battery-status rule against live telemetry.
// Reads IOT_DATABASE_URL from .env.local (tunnel on 127.0.0.1:5500). Run:
//   node scripts/check-healthy-status.mjs
import * as dotenv from 'dotenv';
import postgres from 'postgres';
dotenv.config({ path: '.env.local' });

const URL = process.env.IOT_DATABASE_URL;
if (!URL) { console.error('IOT_DATABASE_URL not set'); process.exit(1); }
const sslmode = (() => { try { return new URL(URL).searchParams.get('sslmode') ?? 'prefer'; } catch { return 'prefer'; } })();
const ssl = sslmode === 'disable' ? false : { rejectUnauthorized: false };
const db = postgres(URL, { ssl, prepare: false, max: 1, connect_timeout: 12 });

try {
  const [r] = await db`
    SELECT
      count(*)::int                                                             AS total,
      count(*) FILTER (WHERE online)::int                                       AS online,
      count(*) FILTER (WHERE online AND open_alert_count = 0)::int              AS online_no_alert,
      count(*) FILTER (WHERE online AND open_alert_count = 0
                       AND (last_battery_at IS NULL
                            OR last_battery_at < now() - interval '24 hours'
                            OR soc_pct IS NULL OR soh_pct IS NULL))::int         AS disc_24h,
      count(*) FILTER (WHERE online AND open_alert_count = 0
                       AND (last_battery_at IS NULL
                            OR last_battery_at < now() - interval '3 hours'
                            OR soc_pct IS NULL OR soh_pct IS NULL))::int         AS disc_3h,
      count(*) FILTER (WHERE online AND open_alert_count = 0
                       AND (last_battery_at IS NULL
                            OR last_battery_at < now() - interval '1 hour'
                            OR soc_pct IS NULL OR soh_pct IS NULL))::int         AS disc_1h
    FROM vehicle_state`;

  const healthy24 = r.online_no_alert - r.disc_24h;
  console.log(`total vehicles      : ${r.total}`);
  console.log(`online              : ${r.online}`);
  console.log(`online & no alert   : ${r.online_no_alert}   (old = "Healthy")`);
  console.log('');
  console.log(`would be Disconnected @ 24h : ${r.disc_24h}   -> Healthy stays ${healthy24}`);
  console.log(`would be Disconnected @ 3h  : ${r.disc_3h}`);
  console.log(`would be Disconnected @ 1h  : ${r.disc_1h}`);
} catch (e) {
  console.error('FAILED:', e.code || '', e.message);
} finally {
  await db.end({ timeout: 3 });
}
