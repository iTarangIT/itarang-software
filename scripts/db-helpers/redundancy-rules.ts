import type { SchemaModel, TableInfo, IndexInfo } from "./schema-model";

export const IGNORE_COLUMNS = new Set([
  "id",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
  "deleted_at",
]);

export type OrphanRow = {
  sqlName: string;
  jsName: string | null;
  rowCount: number | null;
  refCount: number;
  topFiles: string[];
  verdict: "orphan" | "drizzle-only" | "used";
};

export type DuplicateColumnRow = {
  columnName: string;
  dataType: string;
  tableCount: number;
  tables: string[];
  hasFkToCommonParent: boolean;
};

export type SemanticPairRow = {
  tableA: string;
  tableB: string;
  nameSimilarity: number;
  columnOverlap: number;
  sharedColumns: number;
  uniqueToA: number;
  uniqueToB: number;
  verdict: "review" | "likely-duplicate" | "partition-of-same-entity";
};

export type RedundantIndexRow = {
  table: string;
  indexA: string;
  indexAColumns: string[];
  indexB: string;
  indexBColumns: string[];
  relationship: "duplicate" | "prefix";
  dropCandidate: string;
};

function nonIgnoredColumns(t: TableInfo): string[] {
  return Object.keys(t.columns).filter((c) => !IGNORE_COLUMNS.has(c));
}

export function findOrphanTables(
  model: SchemaModel,
  drizzleManifest: Map<string, string>,
  rowCounts: Record<string, number | null>,
  refsBySql: Map<string, string[]>,
): OrphanRow[] {
  const out: OrphanRow[] = [];
  for (const sqlName of Object.keys(model.tables).sort()) {
    if (sqlName === "__drizzle_migrations") continue;
    const refs = refsBySql.get(sqlName) ?? [];
    const jsName = drizzleManifest.get(sqlName) ?? null;
    let verdict: OrphanRow["verdict"];
    if (refs.length === 0) verdict = "orphan";
    else if (
      jsName &&
      refs.length > 0 &&
      refs.every((f) => f.endsWith("schema.ts") || f.startsWith("drizzle/"))
    )
      verdict = "drizzle-only";
    else verdict = "used";
    out.push({
      sqlName,
      jsName,
      rowCount: rowCounts[sqlName] ?? null,
      refCount: refs.length,
      topFiles: refs.slice(0, 3),
      verdict,
    });
  }
  return out;
}

export function findDuplicateColumns(
  model: SchemaModel,
  minTables = 3,
): DuplicateColumnRow[] {
  const buckets = new Map<string, { tables: string[]; dataType: string }>();
  for (const t of Object.values(model.tables)) {
    for (const col of Object.values(t.columns)) {
      if (IGNORE_COLUMNS.has(col.name)) continue;
      const key = `${col.name}::${col.dataType}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { tables: [], dataType: col.dataType };
        buckets.set(key, bucket);
      }
      bucket.tables.push(t.name);
    }
  }

  const rows: DuplicateColumnRow[] = [];
  for (const [key, bucket] of buckets) {
    if (bucket.tables.length < minTables) continue;
    const columnName = key.split("::")[0];
    const fkParents = new Map<string, number>();
    for (const tableName of bucket.tables) {
      const t = model.tables[tableName];
      if (!t) continue;
      for (const fk of t.foreignKeys) {
        if (fk.columns.length === 1 && fk.columns[0] === columnName) {
          fkParents.set(fk.refTable, (fkParents.get(fk.refTable) ?? 0) + 1);
        }
      }
    }
    const hasCommonParent = Array.from(fkParents.values()).some((c) => c >= 2);
    rows.push({
      columnName,
      dataType: bucket.dataType,
      tableCount: bucket.tables.length,
      tables: bucket.tables.sort(),
      hasFkToCommonParent: hasCommonParent,
    });
  }
  rows.sort((a, b) =>
    b.tableCount - a.tableCount || a.columnName.localeCompare(b.columnName),
  );
  return rows;
}

export function levenshteinRatio(a: string, b: string): number {
  if (a === b) return 1;
  const al = a.length;
  const bl = b.length;
  if (al === 0 || bl === 0) return 0;
  const dp: number[][] = Array.from({ length: al + 1 }, () =>
    new Array(bl + 1).fill(0),
  );
  for (let i = 0; i <= al; i++) dp[i][0] = i;
  for (let j = 0; j <= bl; j++) dp[0][j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }
  const dist = dp[al][bl];
  return 1 - dist / Math.max(al, bl);
}

export function findSemanticPairs(
  model: SchemaModel,
  nameThreshold = 0.6,
  overlapThreshold = 0.6,
): SemanticPairRow[] {
  const tableNames = Object.keys(model.tables)
    .filter((n) => n !== "__drizzle_migrations")
    .sort();

  const rows: SemanticPairRow[] = [];
  for (let i = 0; i < tableNames.length; i++) {
    for (let j = i + 1; j < tableNames.length; j++) {
      const a = model.tables[tableNames[i]];
      const b = model.tables[tableNames[j]];
      const colsA = new Set(nonIgnoredColumns(a));
      const colsB = new Set(nonIgnoredColumns(b));
      if (colsA.size === 0 || colsB.size === 0) continue;
      let shared = 0;
      for (const c of colsA) if (colsB.has(c)) shared++;
      const overlap = shared / Math.min(colsA.size, colsB.size);
      const nameSim = levenshteinRatio(a.name, b.name);
      if (nameSim < nameThreshold && overlap < overlapThreshold) continue;

      let verdict: SemanticPairRow["verdict"];
      if (nameSim >= 0.8 && overlap >= 0.8) verdict = "likely-duplicate";
      else if (overlap >= 0.7 && nameSim < 0.5) verdict = "partition-of-same-entity";
      else verdict = "review";

      rows.push({
        tableA: a.name,
        tableB: b.name,
        nameSimilarity: Number(nameSim.toFixed(3)),
        columnOverlap: Number(overlap.toFixed(3)),
        sharedColumns: shared,
        uniqueToA: colsA.size - shared,
        uniqueToB: colsB.size - shared,
        verdict,
      });
    }
  }
  rows.sort(
    (x, y) =>
      y.columnOverlap - x.columnOverlap ||
      y.nameSimilarity - x.nameSimilarity,
  );
  return rows;
}

function indexKey(idx: IndexInfo): string {
  return idx.columns.join(",");
}

function isPrefix(shorter: string[], longer: string[]): boolean {
  if (shorter.length >= longer.length) return false;
  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] !== longer[i]) return false;
  }
  return true;
}

export function findRedundantIndexes(model: SchemaModel): RedundantIndexRow[] {
  const rows: RedundantIndexRow[] = [];
  for (const t of Object.values(model.tables)) {
    const indexes = t.indexes.filter((i) => i.columns.length > 0);
    for (let i = 0; i < indexes.length; i++) {
      for (let j = i + 1; j < indexes.length; j++) {
        const a = indexes[i];
        const b = indexes[j];
        const aKey = indexKey(a);
        const bKey = indexKey(b);

        if (aKey === bKey) {
          const dropCandidate = a.unique && !b.unique ? b.name : a.name;
          rows.push({
            table: t.name,
            indexA: a.name,
            indexAColumns: a.columns,
            indexB: b.name,
            indexBColumns: b.columns,
            relationship: "duplicate",
            dropCandidate,
          });
          continue;
        }

        if (isPrefix(a.columns, b.columns)) {
          if (a.unique) continue;
          rows.push({
            table: t.name,
            indexA: a.name,
            indexAColumns: a.columns,
            indexB: b.name,
            indexBColumns: b.columns,
            relationship: "prefix",
            dropCandidate: a.name,
          });
        } else if (isPrefix(b.columns, a.columns)) {
          if (b.unique) continue;
          rows.push({
            table: t.name,
            indexA: b.name,
            indexAColumns: b.columns,
            indexB: a.name,
            indexBColumns: a.columns,
            relationship: "prefix",
            dropCandidate: b.name,
          });
        }
      }
    }
  }
  rows.sort(
    (x, y) =>
      x.table.localeCompare(y.table) || x.indexA.localeCompare(y.indexA),
  );
  return rows;
}
