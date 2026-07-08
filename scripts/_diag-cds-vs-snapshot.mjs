// Diagnostic: recompute CDS live from the CURRENT emi_schedules (the dates you
// fixed yesterday) and compare against the stale borrower_risk_scores snapshot
// that the Lead Intelligence page still displays. Read-only. No writes.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
function loadEnv(p){ if(!existsSync(p))return; for(const l of readFileSync(p,"utf8").split(/\r?\n/)){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<0)continue;const k=t.slice(0,i).trim();let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!(k in process.env))process.env[k]=v;}}
loadEnv(join(ROOT,".env.local"));
loadEnv(join(ROOT,".env"));

// ---- CDS engine (mirrors src/lib/nbfc/cds/computeCds.ts) ----
const DEPTH = 6, STREAK_PEN = 0.5, STREAK_MAX = DEPTH, TEL_MAX = 0.5, TEL_FRESH_MS = 12*3600*1000;
const recency = (i) => Math.max(0.4, 1.0 - i*0.12);
function emiWeight(status, d){ const s=(status||"").toLowerCase(); if(s==="paid")return 0;
  if(s==="paid_late") return (d??0)<=7?0.5:0.7;
  if(s==="missed") return 1.0;
  if(s==="overdue"){ const x=d??0; if(x<=7)return 0.6; if(x<=30)return 0.85; return 1.0; }
  return 0; }
function streakLen(emis){ let n=0; for(const e of emis){const s=(e.status||"").toLowerCase(); if(s==="missed"||s==="overdue")n++; else break;} return n; }
function computeCds(emis, telAt, now){
  const w = emis.slice(0,DEPTH); let ws=0, tr=0;
  w.forEach((e,i)=>{ ws += emiWeight(e.status,e.days_overdue)*recency(i); tr += recency(i); });
  const streak = streakLen(w); const sp = streak*STREAK_PEN;
  let tel=0; if(telAt){ const lag=now-telAt.getTime(); if(lag>TEL_FRESH_MS){ const days=lag/86400000; tel=Math.max(0,Math.min(TEL_MAX,(days-0.5)/13)); } }
  const denom=(tr||1)+STREAK_MAX*STREAK_PEN+TEL_MAX; const numer=ws+sp+tel;
  return Math.max(0,Math.min(100,Math.round((numer/denom)*100)));
}
// ---- PCI engine (mirrors src/lib/nbfc/pci/computePci.ts) ----
function pciScore(row){ const s=String(row.status??"").toLowerCase(); const d=row.days_overdue??0;
  if(s==="paid"||(row.paid_at!=null&&d<=0))return 1.0;
  if(s==="paid_late"||(row.paid_at!=null&&d>0&&d<7))return 0.5; return 0.0; }
function pci(emisRecentFirst){ const n=Math.min(emisRecentFirst.length,DEPTH); if(n===0)return 0; let wt=0,tw=0;
  for(let i=0;i<n;i++){ const weight=n-i; wt+=pciScore(emisRecentFirst[i])*weight; tw+=weight; }
  return tw===0?0:Math.round((wt/tw)*1000)/1000; }

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const host = (process.env.DATABASE_URL||"").replace(/.*@/,"").split(/[:/]/)[0];
const now = Date.now();
console.log(`Host: ${host}\nNow:  ${new Date(now).toISOString()}\n`);

// Loans referred to the NBFC tenant, with the borrower name.
const loans = (await c.query(`
  SELECT ls.id, ls.nbfc_id, COALESCE(l.full_name, l.owner_name) AS name, ls.status
  FROM loan_sanctions ls
  LEFT JOIN leads l ON l.id = ls.lead_id
  WHERE ls.id LIKE 'LS-IMPORT-%'
  ORDER BY ls.id
`)).rows;

for (const loan of loans) {
  // Latest telemetry for the tenant.
  const tel = (await c.query(
    `SELECT ingested_at FROM telemetry_ingestion_log WHERE tenant_id=$1 ORDER BY ingested_at DESC LIMIT 1`,
    [loan.nbfc_id])).rows[0];
  const telAt = tel?.ingested_at ? new Date(tel.ingested_at) : null;

  // ELAPSED EMIs (due <= today), newest first, last 6 — the live scoring window.
  const emis = (await c.query(`
    SELECT emi_seq, status, days_overdue, due_date, paid_at
    FROM emi_schedules
    WHERE loan_sanction_id=$1 AND due_date <= CURRENT_DATE
    ORDER BY due_date DESC LIMIT 6`, [loan.id])).rows
    .map(r => ({ ...r, days_overdue: r.days_overdue==null?null:Number(r.days_overdue) }));

  // Stale snapshot the leads page shows.
  const snap = (await c.query(`
    SELECT cds_score, pci_score, computed_at FROM borrower_risk_scores
    WHERE loan_sanction_id::text=$1 ORDER BY computed_at DESC LIMIT 1`, [loan.id])).rows[0];

  const liveCds = emis.length ? computeCds(emis, telAt, now) : null;
  const livePci = emis.length ? pci(emis) : null;

  console.log(`\n${loan.id}  ${loan.name ?? "?"}  (${loan.status})`);
  console.log(`  EMI window (newest→oldest): ` + emis.map(e =>
    `#${e.emi_seq}:${e.status}${e.days_overdue?`/${e.days_overdue}d`:""}`).join("  "));
  console.log(`  LIVE  CDS=${liveCds}  PCI=${livePci}`);
  console.log(`  SNAP  CDS=${snap?.cds_score!=null?Math.round(Number(snap.cds_score)):"—"}  ` +
    `PCI=${snap?.pci_score!=null?Number(snap.pci_score):"—"}  ` +
    `(computed ${snap?.computed_at?new Date(snap.computed_at).toISOString().slice(0,16):"never"})` +
    (snap && Math.round(Number(snap.cds_score))!==liveCds ? "   <-- STALE / MISMATCH" : ""));
}
await c.end();
