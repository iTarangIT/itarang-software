// Diagnostic: is "Active loan, low utilization" firing on genuine 0 km/day, or
// on MISSING telemetry (no rows in daily_distance_per_vehicle)? Read-only.
//
// 1. CRM (DATABASE_URL): find iTarang Finance's active loans with EMI > 0 and
//    their vehiclenos — the exact pool evalLowUtilizationActiveLoan builds.
// 2. VPS (IOT_DATABASE_URL): for those vehiclenos, count rows + sum km in the
//    last 14 days from daily_distance_per_vehicle.
//
// If a vehicle has 0 rows -> the "0" avg is a DATA GAP (defaulted), not real.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
function loadEnv(p){ if(!existsSync(p))return; for(const l of readFileSync(p,"utf8").split(/\r?\n/)){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<0)continue;const k=t.slice(0,i).trim();let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!(k in process.env))process.env[k]=v;}}
loadEnv(join(ROOT,".env.local"));
loadEnv(join(ROOT,".env"));

const crm = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await crm.connect();
const crmHost = (process.env.DATABASE_URL||"").replace(/.*@/,"").split(/[:/]/)[0];
console.log(`CRM host: ${crmHost}`);

// Active-EMI loans for the iTarang Finance tenant (match by display/legal name).
const loans = (await crm.query(`
  SELECT nl.vehicleno, nl.emi_amount, nl.current_dpd
  FROM nbfc_loans nl
  JOIN nbfc_tenants t ON t.id = nl.tenant_id
  WHERE nl.is_active = true
    AND nl.emi_amount > 0
    AND (t.display_name ILIKE '%iTarang Finance%' OR t.nbfc_legal_name ILIKE '%iTarang Finance%')
  ORDER BY nl.vehicleno
`)).rows;
console.log(`\nActive-EMI loans (the card's pool): ${loans.length}`);
const vnos = loans.map(l => l.vehicleno).filter(Boolean);
console.log(`vehiclenos: ${vnos.length}`, vnos);
await crm.end();

if (!process.env.IOT_DATABASE_URL) { console.log("\nIOT_DATABASE_URL not set — cannot check the VPS."); process.exit(0); }
const iotSslmode = (()=>{ try { return new URL(process.env.IOT_DATABASE_URL).searchParams.get("sslmode"); } catch { return null; } })();
const iot = new pg.Client({ connectionString: process.env.IOT_DATABASE_URL, ssl: iotSslmode==="disable" ? false : { rejectUnauthorized: false } });
await iot.connect();
const iotHost = (process.env.IOT_DATABASE_URL||"").replace(/.*@/,"").split(/[:/]/)[0];
console.log(`\nVPS host: ${iotHost}`);

const rows = (await iot.query(`
  SELECT vehicleno, COUNT(*)::int AS rows, COALESCE(SUM(km),0)::float AS total_km_14d
  FROM daily_distance_per_vehicle
  WHERE vehicleno = ANY($1) AND day >= NOW() - INTERVAL '14 days'
  GROUP BY vehicleno
`, [vnos])).rows;
const byVno = new Map(rows.map(r => [r.vehicleno, r]));

console.log(`\n${"VEHICLENO".padEnd(24)} ${"ROWS".padStart(5)} ${"14d_KM".padStart(9)} ${"AVG/DAY".padStart(8)}  VERDICT`);
let gap = 0, realZero = 0, driving = 0;
for (const v of vnos) {
  const r = byVno.get(v);
  const rowsN = r?.rows ?? 0;
  const km = r?.total_km_14d ?? 0;
  const avg = km / 14;
  let verdict;
  if (rowsN === 0) { verdict = "DATA GAP (no rows -> defaulted 0)"; gap++; }
  else if (avg < 20) { verdict = "real low-use"; realZero++; }
  else { verdict = "driving (>=20, shouldn't be flagged)"; driving++; }
  console.log(`${v.padEnd(24)} ${String(rowsN).padStart(5)} ${km.toFixed(1).padStart(9)} ${avg.toFixed(1).padStart(8)}  ${verdict}`);
}
console.log(`\nSummary: ${gap} data-gap, ${realZero} genuine low-use, ${driving} actually driving.`);
console.log(gap === vnos.length
  ? "=> ALL of them are missing telemetry. The High Alert is a DATA-COVERAGE artifact, not real risk."
  : gap > 0 ? "=> MIXED: some flagged vehicles have no data, some are genuinely idle."
  : "=> All flagged vehicles have telemetry and are genuinely idle. Alert is legitimate.");
await iot.end();
