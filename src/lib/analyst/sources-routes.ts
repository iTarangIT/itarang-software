// Data Analyst agent — which data-source calls the CRM forwards, and to whom.
//
// /api/analyst/connections/[[...path]] is one proxy for the agent's whole /connections API, so
// it must be an allowlist and not an open relay: anything not listed here is refused before the
// agent sees it. Each entry says whether the caller must be a source manager (ceo/admin — see
// access.ts), what body it carries, how long it may take, and which query keys pass through.
//
// Pure (no server-only import) so the matcher is unit-tested.

import { z } from "zod";

export type BodyKind = "none" | "json" | "multipart";

export type SourceRoute = {
  /** The agent path to call, ids re-encoded. */
  agentPath: string;
  manage: boolean;
  body: BodyKind;
  timeoutMs: number;
  /** Validates (and strips) a JSON body before it is forwarded. */
  schema?: z.ZodTypeAny;
  /** Query keys forwarded to the agent; every other key is dropped. */
  query?: string[];
};

type Method = "GET" | "POST" | "PUT" | "DELETE";

/** Agent ids are uuids; this is looser on purpose but still path-safe. */
const ID = /^[A-Za-z0-9_-]{1,100}$/;

// ── Bodies ───────────────────────────────────────────────────────────────────

/**
 * Only the one-click iTarang CRM database (DSN filled in server-side). ID 167: an outside
 * Postgres address is refused — it would bypass the read-only role's withheld columns and
 * masked views, and send whatever it holds to the LLM.
 */
export const CreateConnectionBody = z.object({ preset: z.literal("crm") }).strict();

/**
 * The fixed name every iTarang-database source gets. A Postgres source with any other name was
 * made through the retired "Other database" tab (scripts/_delete-analyst-outside-connections.ts).
 */
export const CRM_SOURCE_NAME = "iTarang CRM";

/**
 * ID 167 — a database source other than the iTarang preset: made through the retired "Other
 * database" tab. Never listed and never asked. Files and Google Sheets / Drive stay (on hold).
 */
export function isOutsideConnection(c: { kind: string; name: string }): boolean {
  return c.kind === "postgres" && c.name !== CRM_SOURCE_NAME;
}

/**
 * ID 167 (18 Oct) — may a question be asked on this source? Fails closed: only a source the
 * agent listed (so `undefined` — not found — is refused) that is the iTarang database or an
 * upload. Any other kind, including one the agent adds later, is refused until it is reviewed.
 */
export function canAskSource(c: { kind: string; name: string } | undefined | null): boolean {
  if (!c) return false;
  if (c.kind === "file") return true;
  return c.kind === "postgres" && c.name === CRM_SOURCE_NAME;
}

/** The masked read-only login scripts/_create-analyst-readonly-role.mjs sets up. */
export const CRM_READONLY_ROLE = "analyst_ro";

/**
 * ID 167 (23 Oct) — is the iTarang database DSN the masked read-only login? Only analyst_ro
 * reads through the withheld columns and "Customer #" views; any other login (an admin, a
 * malformed or missing DSN) would hand raw names and notes to Gemini, so it is refused.
 */
export function crmDsnIsMasked(dsn: string | null | undefined): boolean {
  if (!dsn?.trim()) return false;
  try {
    return decodeURIComponent(new URL(dsn.trim()).username) === CRM_READONLY_ROLE;
  } catch {
    return false;
  }
}

const DatasetBody = z.object({ name: z.string().trim().min(1).max(200) });

const ResolveBody = z.object({
  url: z.string().trim().min(1).max(2000),
  confirm_unverified: z.boolean().optional(),
});

const RulesBody = z.object({
  source_id: z.string().regex(ID),
  rules: z
    .array(
      z.object({
        id: z.string().regex(ID),
        kind: z.enum(["folder", "file", "sheet"]),
        recursive: z.boolean().optional(),
      }),
    )
    .max(500),
  combine: z.boolean().optional(),
  dry_run: z.boolean().optional(),
});

const TablesBody = z.object({ tables: z.array(z.string().min(1).max(300)).max(1000) });

// ── Upload limits (the agent's own, checked here first so a too-big upload never leaves) ──

export const UPLOAD_EXTENSIONS = [".csv", ".tsv", ".xlsx", ".parquet", ".pdf"] as const;
export const MAX_UPLOAD_FILES = 20;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Multipart framing on top of the files themselves. */
export const MAX_UPLOAD_REQUEST_BYTES = MAX_UPLOAD_FILES * MAX_FILE_BYTES + 1024 * 1024;

export function uploadAllowed(name: string): boolean {
  const lower = name.toLowerCase();
  return UPLOAD_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// ── Matcher ──────────────────────────────────────────────────────────────────

const READ = 15_000;
const WRITE = 30_000;
/** A Postgres connect lists every table; an upload is converted to Parquet before it answers. */
const SLOW = 120_000;

const enc = encodeURIComponent;

/** The route for a method and the path segments after /api/analyst/connections, or null. */
export function matchSourceRoute(method: string, segments: string[]): SourceRoute | null {
  const m = method.toUpperCase() as Method;
  const [first, second, third, ...rest] = segments;
  if (rest.length) return null;

  if (segments.length === 0) {
    if (m === "GET") return { agentPath: "/connections", manage: false, body: "none", timeoutMs: READ };
    if (m === "POST")
      return { agentPath: "/connections", manage: true, body: "json", timeoutMs: SLOW, schema: CreateConnectionBody };
    return null;
  }

  if (segments.length === 1 && first === "file") {
    return m === "POST" ? { agentPath: "/connections/file", manage: true, body: "multipart", timeoutMs: SLOW } : null;
  }
  if (segments.length === 1 && first === "dataset") {
    return m === "POST"
      ? { agentPath: "/connections/dataset", manage: true, body: "json", timeoutMs: WRITE, schema: DatasetBody }
      : null;
  }

  if (!ID.test(first)) return null;
  const base = `/connections/${enc(first)}`;

  if (segments.length === 1) {
    return m === "DELETE" ? { agentPath: base, manage: true, body: "none", timeoutMs: WRITE } : null;
  }

  if (segments.length === 2) {
    switch (second) {
      case "files":
        return m === "POST" ? { agentPath: `${base}/files`, manage: true, body: "multipart", timeoutMs: SLOW } : null;
      case "sources":
        if (m === "GET") return { agentPath: `${base}/sources`, manage: false, body: "none", timeoutMs: READ };
        if (m === "POST")
          return { agentPath: `${base}/sources`, manage: true, body: "json", timeoutMs: SLOW, schema: RulesBody };
        return null;
      case "sync":
        return m === "POST" ? { agentPath: `${base}/sync`, manage: true, body: "none", timeoutMs: WRITE } : null;
      case "tables":
        if (m === "GET") return { agentPath: `${base}/tables`, manage: false, body: "none", timeoutMs: READ };
        if (m === "PUT")
          return { agentPath: `${base}/tables`, manage: true, body: "json", timeoutMs: WRITE, schema: TablesBody };
        return null;
      default:
        return null;
    }
  }

  // segments.length === 3
  if (second === "files" && m === "DELETE") {
    // A file name, not an id: anything but a path separator or a dot-segment.
    if (!third || third.length > 255 || /[\\/]/.test(third) || third === "." || third === "..") return null;
    return { agentPath: `${base}/files/${enc(third)}`, manage: true, body: "none", timeoutMs: SLOW };
  }
  if (second === "sources" && m === "DELETE" && ID.test(third)) {
    return { agentPath: `${base}/sources/${enc(third)}`, manage: true, body: "none", timeoutMs: WRITE };
  }
  if (second === "google" && third === "resolve" && m === "POST") {
    return { agentPath: `${base}/google/resolve`, manage: true, body: "json", timeoutMs: WRITE, schema: ResolveBody };
  }
  if (second === "google" && third === "tree" && m === "GET") {
    return {
      agentPath: `${base}/google/tree`,
      manage: true,
      body: "none",
      timeoutMs: WRITE,
      query: ["source_id", "folder_id"],
    };
  }
  if (second === "tables" && third === "refresh" && m === "POST") {
    return { agentPath: `${base}/tables/refresh`, manage: true, body: "none", timeoutMs: SLOW };
  }
  return null;
}

/** The forwarded query string ("" or "?a=b"), keeping only the route's allowed keys. */
export function forwardQuery(route: SourceRoute, params: URLSearchParams): string {
  if (!route.query?.length) return "";
  const out = new URLSearchParams();
  for (const key of route.query) {
    const value = params.get(key);
    if (value !== null && value.length <= 200 && ID.test(value)) out.set(key, value);
  }
  const text = out.toString();
  return text ? `?${text}` : "";
}
