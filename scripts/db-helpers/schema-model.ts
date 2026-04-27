import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import { PgTable as PgTableClass } from "drizzle-orm/pg-core";

export type ColumnInfo = {
  name: string;
  dataType: string;
  notNull: boolean;
  hasDefault: boolean;
};

export type IndexInfo = {
  name: string;
  columns: string[];
  unique: boolean;
};

export type ForeignKeyInfo = {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete: string | null;
  onUpdate: string | null;
};

export type TableInfo = {
  name: string;
  columns: Record<string, ColumnInfo>;
  primaryKey: string[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
};

export type SchemaModel = {
  source: string;
  tables: Record<string, TableInfo>;
};

const SQL_TYPE_ALIASES: Record<string, string> = {
  "character varying": "varchar",
  "timestamp with time zone": "timestamptz",
  "timestamp without time zone": "timestamp",
  "double precision": "double",
  "integer": "int4",
  "bigint": "int8",
  "smallint": "int2",
  "boolean": "bool",
  "real": "float4",
};

export function canonicalType(raw: string): string {
  const lower = raw.toLowerCase().trim();
  const stripped = lower.replace(/\s*\(.*?\)/g, "");
  return SQL_TYPE_ALIASES[stripped] ?? stripped;
}

export function isDrizzlePgTable(value: unknown): value is PgTable {
  return is(value, PgTableClass);
}

export function modelFromDrizzleSchema(
  schema: Record<string, unknown>,
  source = "code:schema.ts",
): SchemaModel {
  const tables: Record<string, TableInfo> = {};

  for (const value of Object.values(schema)) {
    if (!isDrizzlePgTable(value)) continue;
    const cfg = getTableConfig(value);
    const tableName = cfg.name;

    const columns: Record<string, ColumnInfo> = {};
    for (const col of cfg.columns) {
      columns[col.name] = {
        name: col.name,
        dataType: canonicalType(col.getSQLType()),
        notNull: col.notNull,
        hasDefault: col.hasDefault,
      };
    }

    const primaryKey = cfg.columns
      .filter((c) => c.primary)
      .map((c) => c.name);
    for (const pk of cfg.primaryKeys) {
      for (const col of pk.columns) {
        if (!primaryKey.includes(col.name)) primaryKey.push(col.name);
      }
    }

    const indexes: IndexInfo[] = cfg.indexes.map((idx) => {
      const cfg = idx.config;
      const cols = cfg.columns
        .map((c) => ("name" in c ? (c.name as string) : ""))
        .filter(Boolean);
      return {
        name: cfg.name ?? "",
        columns: cols,
        unique: Boolean(cfg.unique),
      };
    });

    const foreignKeys: ForeignKeyInfo[] = cfg.foreignKeys.map((fk) => {
      const ref = fk.reference();
      return {
        name: fk.getName(),
        columns: ref.columns.map((c) => c.name),
        refTable: getTableConfig(ref.foreignTable).name,
        refColumns: ref.foreignColumns.map((c) => c.name),
        onDelete: fk.onDelete ?? null,
        onUpdate: fk.onUpdate ?? null,
      };
    });

    tables[tableName] = {
      name: tableName,
      columns,
      primaryKey: primaryKey.sort(),
      indexes: indexes.sort((a, b) => a.name.localeCompare(b.name)),
      foreignKeys: foreignKeys.sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  return { source, tables };
}
