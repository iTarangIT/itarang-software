import postgres from 'postgres'
import XLSX from 'xlsx'
import os from 'node:os'
import path from 'node:path'

const URL = 'postgresql://postgres:MYitarang2026@database-2.c9w88wq6qyco.ap-south-1.rds.amazonaws.com:5432/postgres?sslmode=require'
const sql = postgres(URL, { ssl: { rejectUnauthorized: false }, max: 4, idle_timeout: 20 })

const ident = (s) => '"' + s.replace(/"/g, '""') + '"'

const tables = await sql`
  SELECT c.relname AS table_name
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
  ORDER BY c.relname
`
console.log('tables:', tables.length)

const cols = await sql`
  SELECT table_name, column_name, data_type, ordinal_position
  FROM information_schema.columns
  WHERE table_schema = 'public'
  ORDER BY table_name, ordinal_position
`
const colsByTable = new Map()
for (const c of cols) {
  if (!colsByTable.has(c.table_name)) colsByTable.set(c.table_name, [])
  colsByTable.get(c.table_name).push(c)
}

const TEXTY = new Set(['text', 'character varying', 'character', 'citext'])

const allTables = []
const emptyTables = []
const emptyCols = []

for (const { table_name: t } of tables) {
  let n
  try {
    const r = await sql.unsafe(`SELECT count(*)::bigint AS n FROM public.${ident(t)}`)
    n = Number(r[0].n)
  } catch (e) {
    allTables.push({ Table: t, 'Row Count': 'ERROR', Status: String(e.message).slice(0, 120) })
    continue
  }
  const tCols = colsByTable.get(t) || []
  allTables.push({
    Table: t,
    'Row Count': n,
    'Column Count': tCols.length,
    Status: n === 0 ? 'EMPTY TABLE (unused)' : 'has data',
  })

  if (n === 0) {
    emptyTables.push({
      Table: t,
      'Row Count': 0,
      'Column Count': tCols.length,
      Columns: tCols.map((c) => c.column_name).join(', '),
    })
    continue
  }

  const parts = tCols.map((c) => {
    const q = ident(c.column_name)
    const nonNull = `count(${q})::bigint`
    const nonBlank = TEXTY.has(c.data_type)
      ? `count(NULLIF(btrim(${q}::text), ''))::bigint`
      : nonNull
    return `${nonNull} AS ${ident('nn_' + c.ordinal_position)}, ${nonBlank} AS ${ident('nb_' + c.ordinal_position)}`
  })
  let stats
  try {
    const r = await sql.unsafe(`SELECT ${parts.join(', ')} FROM public.${ident(t)}`)
    stats = r[0]
  } catch (e) {
    console.log('col-scan failed', t, e.message)
    continue
  }
  for (const c of tCols) {
    const nn = Number(stats['nn_' + c.ordinal_position])
    const nb = Number(stats['nb_' + c.ordinal_position])
    if (nn === 0) {
      emptyCols.push({
        Table: t, Column: c.column_name, 'Data Type': c.data_type,
        'Table Rows': n, 'Non-NULL Values': 0, Status: 'ALL NULL',
      })
    } else if (nb === 0) {
      emptyCols.push({
        Table: t, Column: c.column_name, 'Data Type': c.data_type,
        'Table Rows': n, 'Non-NULL Values': nn, Status: 'ALL NULL OR BLANK STRING',
      })
    }
  }
  process.stdout.write('.')
}

await sql.end()
console.log('\nempty tables:', emptyTables.length, '| empty cols:', emptyCols.length)

const wb = XLSX.utils.book_new()

const summary = [
  { Metric: 'Database', Value: 'database-2 (AWS RDS, ap-south-1)' },
  { Metric: 'Schema', Value: 'public' },
  { Metric: 'Audit date', Value: '2026-07-17' },
  { Metric: 'Total tables', Value: tables.length },
  { Metric: 'Tables with ZERO rows (unused)', Value: emptyTables.length },
  { Metric: 'Tables with data', Value: tables.length - emptyTables.length },
  { Metric: 'Empty columns in populated tables', Value: emptyCols.length },
]

const mk = (rows, widths) => {
  const ws = XLSX.utils.json_to_sheet(rows)
  ws['!cols'] = widths.map((w) => ({ wch: w }))
  if (rows.length) ws['!autofilter'] = { ref: ws['!ref'] }
  return ws
}

XLSX.utils.book_append_sheet(wb, mk(summary, [40, 40]), 'Summary')
XLSX.utils.book_append_sheet(wb, mk(emptyTables, [42, 10, 14, 90]), 'Empty Tables (0 rows)')
XLSX.utils.book_append_sheet(wb, mk(emptyCols, [42, 36, 22, 12, 16, 28]), 'Empty Columns')
XLSX.utils.book_append_sheet(wb, mk(allTables, [42, 12, 14, 24]), 'All Tables')

const out = path.join(os.homedir(), 'Downloads', 'database-2-empty-audit.xlsx')
XLSX.writeFile(wb, out)
console.log('WROTE', out)
