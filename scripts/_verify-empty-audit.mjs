import postgres from 'postgres'
import XLSX from 'xlsx'
import os from 'node:os'
import path from 'node:path'

const URL = 'postgresql://postgres:MYitarang2026@database-2.c9w88wq6qyco.ap-south-1.rds.amazonaws.com:5432/postgres?sslmode=require'
const sql = postgres(URL, { ssl: { rejectUnauthorized: false }, max: 2 })

const wb = XLSX.readFile(path.join(os.homedir(), 'Downloads', 'database-2-empty-audit.xlsx'))
const et = XLSX.utils.sheet_to_json(wb.Sheets['Empty Tables (0 rows)'])
const ec = XLSX.utils.sheet_to_json(wb.Sheets['Empty Columns'])
console.log('sheets:', wb.SheetNames)
console.log('empty tables rows:', et.length, '| empty col rows:', ec.length)
console.log('sample empty tables:', et.slice(0, 8).map((r) => r.Table).join(', '))

// Re-verify 5 claimed-empty tables really have 0 rows
for (const r of et.slice(0, 5)) {
  const q = await sql.unsafe(`SELECT count(*)::int AS n FROM public."${r.Table}"`)
  console.log(`  ${r.Table}: actual=${q[0].n} ${q[0].n === 0 ? 'OK' : 'MISMATCH'}`)
}

// Re-verify 5 claimed-empty columns
for (const r of ec.slice(0, 5)) {
  const q = await sql.unsafe(`SELECT count("${r.Column}")::int AS nn FROM public."${r.Table}"`)
  console.log(`  ${r.Table}.${r.Column}: non-null=${q[0].nn} ${q[0].nn === 0 ? 'OK' : '(blank-string case)'}`)
}

// Negative control: a table we expect to HAVE data must not be listed as empty
const ctl = await sql.unsafe(`SELECT count(*)::int AS n FROM public."users"`)
console.log('control users rows:', ctl[0].n, '| listed empty?', et.some((r) => r.Table === 'users'))

await sql.end()
