import type {
  ColumnInfo,
  ForeignKeyInfo,
  IndexInfo,
  SchemaModel,
  TableInfo,
} from "./schema-model";

export type ColumnChange = {
  column: string;
  left: ColumnInfo | null;
  right: ColumnInfo | null;
  reason: "type" | "nullability" | "default-presence";
};

export type IndexChange = {
  index: string;
  left: IndexInfo | null;
  right: IndexInfo | null;
};

export type FkChange = {
  fk: string;
  left: ForeignKeyInfo | null;
  right: ForeignKeyInfo | null;
};

export type TableShapeDiff = {
  table: string;
  columnsOnlyInLeft: string[];
  columnsOnlyInRight: string[];
  columnChanges: ColumnChange[];
  pkDiff: { left: string[]; right: string[] } | null;
  indexesOnlyInLeft: string[];
  indexesOnlyInRight: string[];
  indexChanges: IndexChange[];
  fksOnlyInLeft: string[];
  fksOnlyInRight: string[];
  fkChanges: FkChange[];
};

export type SchemaDiff = {
  leftSource: string;
  rightSource: string;
  tablesOnlyInLeft: string[];
  tablesOnlyInRight: string[];
  shapeDiffs: TableShapeDiff[];
};

function arraysEqual(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function diffColumns(left: TableInfo, right: TableInfo) {
  const leftCols = new Set(Object.keys(left.columns));
  const rightCols = new Set(Object.keys(right.columns));

  const onlyLeft: string[] = [];
  const onlyRight: string[] = [];
  const changes: ColumnChange[] = [];

  for (const c of leftCols) if (!rightCols.has(c)) onlyLeft.push(c);
  for (const c of rightCols) if (!leftCols.has(c)) onlyRight.push(c);

  for (const c of leftCols) {
    if (!rightCols.has(c)) continue;
    const l = left.columns[c];
    const r = right.columns[c];
    if (l.dataType !== r.dataType) {
      changes.push({ column: c, left: l, right: r, reason: "type" });
    } else if (l.notNull !== r.notNull) {
      changes.push({ column: c, left: l, right: r, reason: "nullability" });
    } else if (l.hasDefault !== r.hasDefault) {
      changes.push({
        column: c,
        left: l,
        right: r,
        reason: "default-presence",
      });
    }
  }

  return {
    onlyLeft: onlyLeft.sort(),
    onlyRight: onlyRight.sort(),
    changes: changes.sort((a, b) => a.column.localeCompare(b.column)),
  };
}

function diffIndexes(left: TableInfo, right: TableInfo) {
  const byName = (arr: IndexInfo[]) => new Map(arr.map((i) => [i.name, i]));
  const l = byName(left.indexes);
  const r = byName(right.indexes);
  const onlyLeft: string[] = [];
  const onlyRight: string[] = [];
  const changes: IndexChange[] = [];
  for (const [name, idx] of l) {
    const other = r.get(name);
    if (!other) onlyLeft.push(name);
    else if (
      idx.unique !== other.unique ||
      !arraysEqual(idx.columns, other.columns)
    )
      changes.push({ index: name, left: idx, right: other });
  }
  for (const name of r.keys()) if (!l.has(name)) onlyRight.push(name);
  return {
    onlyLeft: onlyLeft.sort(),
    onlyRight: onlyRight.sort(),
    changes: changes.sort((a, b) => a.index.localeCompare(b.index)),
  };
}

function diffForeignKeys(left: TableInfo, right: TableInfo) {
  const byName = (arr: ForeignKeyInfo[]) =>
    new Map(arr.map((f) => [f.name, f]));
  const l = byName(left.foreignKeys);
  const r = byName(right.foreignKeys);
  const onlyLeft: string[] = [];
  const onlyRight: string[] = [];
  const changes: FkChange[] = [];
  for (const [name, fk] of l) {
    const other = r.get(name);
    if (!other) onlyLeft.push(name);
    else if (
      !arraysEqual(fk.columns, other.columns) ||
      fk.refTable !== other.refTable ||
      !arraysEqual(fk.refColumns, other.refColumns) ||
      (fk.onDelete ?? null) !== (other.onDelete ?? null)
    )
      changes.push({ fk: name, left: fk, right: other });
  }
  for (const name of r.keys()) if (!l.has(name)) onlyRight.push(name);
  return {
    onlyLeft: onlyLeft.sort(),
    onlyRight: onlyRight.sort(),
    changes: changes.sort((a, b) => a.fk.localeCompare(b.fk)),
  };
}

export function diffSchemas(left: SchemaModel, right: SchemaModel): SchemaDiff {
  const leftTables = new Set(Object.keys(left.tables));
  const rightTables = new Set(Object.keys(right.tables));

  const tablesOnlyInLeft: string[] = [];
  const tablesOnlyInRight: string[] = [];
  for (const t of leftTables) if (!rightTables.has(t)) tablesOnlyInLeft.push(t);
  for (const t of rightTables) if (!leftTables.has(t)) tablesOnlyInRight.push(t);

  const shapeDiffs: TableShapeDiff[] = [];
  for (const name of leftTables) {
    if (!rightTables.has(name)) continue;
    const lt = left.tables[name];
    const rt = right.tables[name];
    const cols = diffColumns(lt, rt);
    const idx = diffIndexes(lt, rt);
    const fks = diffForeignKeys(lt, rt);
    const pkDiff = arraysEqual(lt.primaryKey, rt.primaryKey)
      ? null
      : { left: lt.primaryKey, right: rt.primaryKey };

    const hasAnyDiff =
      cols.onlyLeft.length ||
      cols.onlyRight.length ||
      cols.changes.length ||
      idx.onlyLeft.length ||
      idx.onlyRight.length ||
      idx.changes.length ||
      fks.onlyLeft.length ||
      fks.onlyRight.length ||
      fks.changes.length ||
      pkDiff;

    if (hasAnyDiff) {
      shapeDiffs.push({
        table: name,
        columnsOnlyInLeft: cols.onlyLeft,
        columnsOnlyInRight: cols.onlyRight,
        columnChanges: cols.changes,
        pkDiff,
        indexesOnlyInLeft: idx.onlyLeft,
        indexesOnlyInRight: idx.onlyRight,
        indexChanges: idx.changes,
        fksOnlyInLeft: fks.onlyLeft,
        fksOnlyInRight: fks.onlyRight,
        fkChanges: fks.changes,
      });
    }
  }

  return {
    leftSource: left.source,
    rightSource: right.source,
    tablesOnlyInLeft: tablesOnlyInLeft.sort(),
    tablesOnlyInRight: tablesOnlyInRight.sort(),
    shapeDiffs: shapeDiffs.sort((a, b) => a.table.localeCompare(b.table)),
  };
}

export function diffSummary(diff: SchemaDiff): string {
  const parts: string[] = [];
  if (diff.tablesOnlyInLeft.length)
    parts.push(`${diff.tablesOnlyInLeft.length} only in ${diff.leftSource}`);
  if (diff.tablesOnlyInRight.length)
    parts.push(`${diff.tablesOnlyInRight.length} only in ${diff.rightSource}`);
  if (diff.shapeDiffs.length)
    parts.push(`${diff.shapeDiffs.length} table(s) with shape diffs`);
  return parts.length ? parts.join(", ") : "no differences";
}
