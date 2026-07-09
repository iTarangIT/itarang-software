// Quick reachability + freshness check for whatever IOT_DATABASE_URL points at.
// Reads the URL from .env.local (no hardcoded creds). Run: node scripts/check-iot-live.mjs
import * as dotenv from 'dotenv';
import postgres from 'postgres';
dotenv.config({ path: '.env.local' });

const URL = process.env.IOT_DATABASE_URL;
if (!URL) { console.error('IOT_DATABASE_URL not set in .env.local'); process.exit(1); }
try { const u = new URL(URL); console.log('connecting to:', u.host, u.pathname); } catch {}

const sslmode = (() => { try { return new URL(URL).searchParams.get('sslmode') ?? 'prefer'; } catch { return 'prefer'; } })();
const ssl = sslmode === 'disable' ? false : { rejectUnauthorized: false };
const db = postgres(URL, { ssl, prepare: false, max: 1, connect_timeout: 12 });

try {
  const [t] = await db`SELECT max(time) latest, EXTRACT(EPOCH FROM (now()-max(time)))/3600 AS hrs FROM telemetry_battery`;
  const [v] = await db`SELECT count(*)::int n FROM vehicle_state`;
  const hrs = Number(t.hrs);
  console.log(`✅ CONNECTED — ${v.n} vehicles | latest telemetry ${t.latest} (${hrs.toFixed(2)}h stale)`);
  console.log(hrs < 2 ? '🎉 THIS IS LIVE DATA.' : hrs > 100 ? '⚠️  Reachable but FROZEN (poller not writing here).' : 'Reachable; somewhat behind.');
} catch (e) {
  console.error('❌ FAILED:', e.code || '', e.message);
  if (['ETIMEDOUT', 'ECONNREFUSED', 'ENETUNREACH'].includes(e.code) || /timeout/i.test(e.message))
    console.error('→ The DB is private / not reachable from this machine (security group + no public access). Needs IP allowlist + public access, or a VPC bastion.');
  if (/password|authentication/i.test(e.message))
    console.error('→ Auth failed — get the real password from AWS Secrets Manager.');
}
await db.end({ timeout: 3 });
