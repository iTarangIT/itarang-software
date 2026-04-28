import postgres from "postgres";
import {
  canonicalType,
  type ColumnInfo,
  type ForeignKeyInfo,
  type IndexInfo,
  type SchemaModel,
  type TableInfo,
} from "./schema-model";

type ColumnRow = {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  character_maximum_length: number | null;
  is_nullable: "YES" | "NO";
  column_default: string | null;
};

type PkRow = { table_name: string; column_name: string; ordinal_position: number };

type IndexRow = {
  table_name: string;
  index_name: string;
  is_unique: boolean;
  is_primary: boolean;
  columns: string[];
};

type FkRow = {
  table_name: string;
  constraint_name: string;
  columns: string[];
  ref_table: string;
  ref_columns: string[];
  on_delete: string | null;
  on_update: string | null;
};

const DELETE_ACTION_MAP: Record<string, string> = {
  a: "no action",
  r: "restrict",
  c: "cascade",
  n: "set null",
  d: "set default",
};

export async function introspect(
  connectionString: string,
  source: string,
  schemaName = "public",
): Promise<SchemaModel> {
  const sql = postgres(connectionString, {
    ssl: "require",
    prepare: false,
    max: 2,
    idle_timeout: 5,
    connect_timeout: 15,
  });

  try {
    const tablesQuery = await sql<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = ${schemaName}
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;
    const tableNames = tablesQuery.map((r) => r.table_name);
    const tableSet = new Set(tableNames);

    const columnRows = (await sql`
      SELECT table_name, column_name, data_type, udt_name,
             character_maximum_length, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = ${schemaName}
      ORDER BY table_name, ordinal_position
    `) as unknown as ColumnRow[];

    const pkRows = (await sql`
      SELECT
        kcu.table_name,
        kcu.column_name,
        kcu.ordinal_position
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = ${schemaName}
      ORDER BY kcu.table_name, kcu.ordinal_position
    `) as unknown as PkRow[];

    const indexRows = (await sql`
      SELECT
        t.relname AS table_name,
        i.relname AS index_name,
        ix.indisunique AS is_unique,
        ix.indisprimary AS is_primary,
        ARRAY(
          SELECT a.attname
          FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
          ORDER BY k.ord
        ) AS columns
      FROM pg_class t
      JOIN pg_index ix ON ix.indrelid = t.oid
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = ${schemaName}
        AND t.relkind = 'r'
      ORDER BY t.relname, i.relname
    `) as unknown as IndexRow[];

    const fkRows = (await sql`
      SELECT
        c.conname AS constraint_name,
        cl.relname AS table_name,
        ref.relname AS ref_table,
        ARRAY(
          SELECT att.attname
          FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute att
            ON att.attrelid = c.conrelid AND att.attnum = k.attnum
          ORDER BY k.ord
        ) AS columns,
        ARRAY(
          SELECT att.attname
          FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute att
            ON att.attrelid = c.confrelid AND att.attnum = k.attnum
          ORDER BY k.ord
        ) AS ref_columns,
        c.confdeltype AS on_delete,
        c.confupdtype AS on_update
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_class ref ON ref.oid = c.confrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE c.contype = 'f' AND n.nspname = ${schemaName}
      ORDER BY cl.relname, c.conname
    `) as unknown as FkRow[];

    const tables: Record<string, TableInfo> = {};
    for (const name of tableNames) {
      tables[name] = {
        name,
        columns: {},
        primaryKey: [],
        indexes: [],
        foreignKeys: [],
      };
    }

    for (const row of columnRows) {
      if (!tableSet.has(row.table_name)) continue;
      const dataType =
        row.data_type === "USER-DEFINED" ? row.udt_name : row.data_type;
      const col: ColumnInfo = {
        name: row.column_name,
        dataType: canonicalType(dataType),
        notNull: row.is_nullable === "NO",
        hasDefault: row.column_default !== null,
      };
      tables[row.table_name].columns[row.column_name] = col;
    }

    for (const row of pkRows) {
      if (!tableSet.has(row.table_name)) continue;
      tables[row.table_name].primaryKey.push(row.column_name);
    }
    for (const t of Object.values(tables)) t.primaryKey.sort();

    for (const row of indexRows) {
      if (!tableSet.has(row.table_name)) continue;
      if (row.is_primary) continue;
      const idx: IndexInfo = {
        name: row.index_name,
        columns: row.columns,
        unique: row.is_unique,
      };
      tables[row.table_name].indexes.push(idx);
    }
    for (const t of Object.values(tables))
      t.indexes.sort((a, b) => a.name.localeCompare(b.name));

    for (const row of fkRows) {
      if (!tableSet.has(row.table_name)) continue;
      const fk: ForeignKeyInfo = {
        name: row.constraint_name,
        columns: row.columns,
        refTable: row.ref_table,
        refColumns: row.ref_columns,
        onDelete: row.on_delete ? DELETE_ACTION_MAP[row.on_delete] ?? null : null,
        onUpdate: row.on_update ? DELETE_ACTION_MAP[row.on_update] ?? null : null,
      };
      tables[row.table_name].foreignKeys.push(fk);
    }
    for (const t of Object.values(tables))
      t.foreignKeys.sort((a, b) => a.name.localeCompare(b.name));

    return { source, tables };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function rowCounts(
  connectionString: string,
  tableNames: string[],
  schemaName = "public",
): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {};
  if (!tableNames.length) return out;
  const sql = postgres(connectionString, {
    ssl: "require",
    prepare: false,
    max: 2,
    idle_timeout: 5,
    connect_timeout: 15,
  });
  try {
    for (const name of tableNames) {
      try {
        const result = (await sql.unsafe(
          `SELECT count(*)::bigint AS c FROM "${schemaName}"."${name}"`,
        )) as unknown as { c: string }[];
        out[name] = Number(result[0]?.c ?? 0);
      } catch {
        out[name] = null;
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  return out;
}
