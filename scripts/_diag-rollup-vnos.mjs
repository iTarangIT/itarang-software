// Do the 7 active-EMI vehicles have REAL daily distance in distance_rollup
// (the populated table), even though daily_distance_per_vehicle is empty?
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
function loadEnv(p){ if(!existsSync(p))return; for(const l of readFileSync(p,"utf8").split(/\r?\n/)){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<0)continue;const k=t.slice(0,i).trim();let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!(k in process.env))process.env[k]=v;}}
loadEnv(join(ROOT,".env.local"));
loadEnv(join(ROOT,".env"));
const sslmode = (()=>{ try { return new URL(process.env.IOT_DATABASE_URL).searchParams.get("sslmode"); } catch { return null; } })();
const c = new pg.Client({ connectionString: process.env.IOT_DATABASE_URL, ssl: sslmode==="disable" ? false : { rejectUnauthorized: false } });
await c.connect();
const vnos = ['TK-51105-02AZ-179422','TK-51105-02AZ-179424','TK-51105-02AZ-179528','TK-51105-07KY-161946','TK-51105-07KY-161947','TK-51105-07KY-161951','TK-51105-07KY-161952'];

const rows = (await c.query(`
  SELECT vehicleno,
         COUNT(*)::int AS day_rows_14d,
         ROUND(SUM(distance_km)::numeric,1) AS km_14d,
         ROUND((SUM(distance_km)/14)::numeric,1) AS avg_per_day
  FROM distance_rollup
  WHERE vehicleno = ANY($1) AND bucket_size='day'
    AND time >= NOW() - INTERVAL '14 days'
  GROUP BY vehicleno ORDER BY vehicleno
`, [vnos])).rows;
const byV = new Map(rows.map(r=>[r.vehicleno,r]));
console.log("Using distance_rollup (bucket_size='day'), last 14 days:\n");
console.log(`${"VEHICLENO".padEnd(24)} ${"ROWS".padStart(5)} ${"KM_14d".padStart(9)} ${"AVG/DAY".padStart(8)}`);
for (const v of vnos){ const r=byV.get(v); console.log(`${v.padEnd(24)} ${String(r?.day_rows_14d??0).padStart(5)} ${String(r?.km_14d??0).padStart(9)} ${String(r?.avg_per_day??0).padStart(8)}`); }

// Also widen the window in case these vehicles report older than 14d.
const anytime = (await c.query(`
  SELECT COUNT(DISTINCT vehicleno)::int AS vehicles, COUNT(*)::int AS rows,
         MIN(time)::date AS first_day, MAX(time)::date AS last_day
  FROM distance_rollup WHERE vehicleno = ANY($1) AND bucket_size='day'
`, [vnos])).rows[0];
console.log(`\nAll-time in distance_rollup for these 7: vehicles=${anytime.vehicles}, rows=${anytime.rows}, range=${anytime.first_day}..${anytime.last_day}`);
await c.end();
