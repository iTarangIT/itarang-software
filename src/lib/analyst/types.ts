// Data Analyst agent — wire types.
//
// Mirrors the agent's app/api/schemas.py (github.com/iTarangIT/Data-Analysis-Agent-Main), kept
// narrow to what the CRM's ask screen reads. The agent is a separate Python service; the CRM
// only ever talks to it server-side, through src/lib/analyst/client.ts.

export type Connection = {
  id: string;
  name: string;
  kind: "postgres" | "file";
  selected_tables: number;
  total_tables: number;
  file_count: number;
  catalog_refreshed_at: string | null;
  sync_status: "syncing" | "ready" | "failed" | null;
  synced_at: string | null;
};

/** A forecast's own series: the cleaned history it was made from, then what it predicts. */
export type ForecastSeries = {
  grain: "hour" | "day" | "week" | "month" | "quarter" | "year";
  /** How much of the outcome the low-to-high band is meant to hold, e.g. 0.8. */
  interval: number;
  /** [period, value], oldest first. */
  history: [string, number][];
  /** [period, forecast, low, high]. */
  points: [string, number, number, number][];
};

export type ChartSpec = {
  type: "bar" | "line" | "forecast";
  x: string;
  y: string[];
  forecast?: ForecastSeries | null;
};

/**
 * The agent's five contract stages. Not a ladder: a guard rejection sends the run back from
 * sql_guard to sql_gen, so anything drawn as a fixed five-step bar lies on retried runs.
 */
export type Stage = "router" | "sql_gen" | "sql_guard" | "db_exec" | "answer";

/** One pass at writing SQL. Fields after `sql` arrive as the query is checked and run. */
export type Attempt = {
  sql: string | null;
  rejected: boolean;
  tool?: "sql" | "forecast" | null;
  what?: string;
  why?: string;
  reason?: string | null;
  at?: "guard" | "database" | "forecast" | null;
  rows?: number | null;
  truncated?: boolean | null;
  ms?: number | null;
};

export type RunTrace = {
  stages: Stage[];
  attempts: Attempt[];
};

export type RunSummary = {
  id: string;
  thread_id: string;
  question: string;
  status: "running" | "done" | "error";
  tool: string | null;
  connection_id: string;
  connection_name: string | null;
  rows_returned: number;
  duration_ms: number;
  created_at: string;
  has_sql: boolean;
  has_answer: boolean;
};

export type RunPage = {
  items: RunSummary[];
  next_cursor: string | null;
};

export type RunDetail = {
  id: string;
  connection_id: string;
  thread_id: string;
  question: string;
  status: string;
  tool: string | null;
  sql: string | null;
  answer: string | null;
  error: string | null;
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  rows_returned: number;
  chart: ChartSpec | null;
  trace: RunTrace | null;
  duration_ms: number;
  created_at: string;
};

export type Thread = {
  thread_id: string;
  title: string;
  run_count: number;
  last_run_at: string;
  last_status: string;
  connection_id: string;
};

// ── Data sources ──────────────────────────────────────────────────────────────
// A Connection is what a run asks. A "file" connection is a dataset: one or more sources
// (uploads, a Google Sheet, a Drive folder or file), each holding files, each file one or more
// tables. Mirrors ConnectionOut / SourceOut / TablesOut in the agent's app/api/schemas.py.

export type SourceOrigin = "upload" | "gdrive_folder" | "gdrive_file" | "gsheet";

export type SourceFile = {
  id: string;
  name: string;
  status: "ready" | "skipped" | "failed";
  reason: string | null;
  bytes: number | null;
  synced_at: string | null;
  tables: string[];
};

export type SourceRule = { id: string; kind: "folder" | "file" | "sheet"; recursive?: boolean };

export type Source = {
  id: string;
  origin: SourceOrigin;
  label: string;
  status: "pending" | "active";
  combine: boolean;
  rules: SourceRule[];
  files: SourceFile[];
};

export type SourceList = {
  sync_status: "syncing" | "ready" | "failed" | null;
  synced_at: string | null;
  sources: Source[];
};

export type ResolveResult = {
  status: "needs_share" | "unverified" | "resolved";
  /** The agent's Google service account, which the item must be shared with. */
  share_with?: string | null;
  source?: Source | null;
};

export type DriveNode = {
  id: string;
  name: string;
  kind: "folder" | "sheet" | "xlsx" | "csv" | "tsv" | "pdf" | "other";
  supported: boolean;
  bytes: number | null;
  modified: string | null;
};

export type DriveListing = {
  folder_id: string;
  children: DriveNode[];
  supported: number;
  unsupported: number;
  bytes: number;
};

export type DryRun = {
  files: number;
  bytes: number;
  skipped: { name: string; reason: string }[];
  fits: boolean;
  limit: number;
};

export type TableColumn = { name: string; type: string; nullable?: boolean; comment?: string | null };

export type TableInfo = {
  name: string;
  files: string[];
  selected: boolean;
  definition: { name: string; comment?: string | null; columns: TableColumn[] } | null;
  stats: Record<string, unknown> | null;
};

export type TableList = {
  max_selected: number;
  refreshed_at: string | null;
  tables: TableInfo[];
  relationships: unknown[];
  /** Only on a refresh. */
  added?: string[];
  removed?: string[];
};
