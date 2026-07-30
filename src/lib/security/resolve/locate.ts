/**
 * Maps a security finding's target_url to the source file on disk that most
 * likely owns the vulnerability, so the resolution-chat agent can read the REAL
 * code (not guess) and the Resolve step can apply an edit to a known file.
 *
 * Only ever resolves inside the repo `src/` tree (path allowlist) — the Resolve
 * step trusts this boundary before writing.
 *
 * Dynamic route segments are matched by walking the app dir: a concrete URL
 * segment (e.g. a uuid) that has no matching folder falls back to the single
 * `[param]` folder at that level. So `/api/coborrower/<uuid>` resolves to
 * `src/app/api/coborrower/[leadId]/route.ts`.
 *
 * Runs in a Node route handler (fs access) — never import from Edge middleware.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const MAX_SOURCE_CHARS = 12_000;

export interface LocatedSource {
  /** Repo-relative path, e.g. src/app/api/coborrower/[leadId]/route.ts */
  repoRelPath: string;
  absPath: string;
  /** File content, truncated to MAX_SOURCE_CHARS for the prompt. */
  content: string;
  truncated: boolean;
}

function repoRoot(): string {
  return process.cwd();
}

/** True if `abs` is inside the repo `src/` tree (rejects traversal). */
export function isInsideRepoSrc(abs: string): boolean {
  const srcRoot = path.join(repoRoot(), "src");
  const rel = path.relative(srcRoot, abs);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

/** The single `[param]` child directory of `dir`, if exactly one exists. */
async function dynamicChild(dir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }
  const dyn: string[] = [];
  for (const e of entries) {
    if (/^\[.+\]$/.test(e) && (await isDir(path.join(dir, e)))) dyn.push(e);
  }
  // Prefer catch-all `[...x]` last; a single dynamic dir is the common case.
  if (dyn.length === 1) return dyn[0];
  if (dyn.length > 1) {
    // Deterministic: non-catch-all first, then alphabetical.
    dyn.sort((a, b) => Number(a.includes("...")) - Number(b.includes("...")) || a.localeCompare(b));
    return dyn[0];
  }
  return null;
}

/**
 * Resolve a URL pathname to a route file absolute path, or null.
 * `/api/...` → route.ts under src/app/api/...
 * anything else → the closest page.tsx under src/app/... (best-effort).
 */
export async function resolveRouteFile(pathname: string): Promise<string | null> {
  const clean = pathname.split("?")[0].split("#")[0];
  const segments = clean.split("/").filter(Boolean);
  const isApi = segments[0] === "api";

  let dir = path.join(repoRoot(), "src", "app");
  if (!(await isDir(dir))) return null;

  for (const seg of segments) {
    const exact = path.join(dir, seg);
    if (await isDir(exact)) {
      dir = exact;
      continue;
    }
    const dyn = await dynamicChild(dir);
    if (dyn) {
      dir = path.join(dir, dyn);
      continue;
    }
    // Segment didn't resolve. For API routes the leaf may be the handler file
    // itself with no deeper folder — stop here and check for route.ts below.
    break;
  }

  const leaf = isApi ? path.join(dir, "route.ts") : path.join(dir, "page.tsx");
  if ((await isFile(leaf)) && isInsideRepoSrc(leaf)) return leaf;

  // Route-group folders (e.g. (dashboard)) sit between segments for pages — a
  // best-effort second pass isn't worth it here; API routes are the priority.
  return null;
}

/** Locate + read (truncated) the source behind a finding's target_url. */
export async function locateSourceForTarget(targetUrl: string): Promise<LocatedSource | null> {
  let pathname: string;
  try {
    pathname = new URL(targetUrl).pathname;
  } catch {
    // target_url may already be a bare path.
    pathname = targetUrl.startsWith("/") ? targetUrl : `/${targetUrl}`;
  }

  const absPath = await resolveRouteFile(pathname);
  if (!absPath) return null;

  let raw: string;
  try {
    raw = await fs.readFile(absPath, "utf8");
  } catch {
    return null;
  }

  const truncated = raw.length > MAX_SOURCE_CHARS;
  return {
    repoRelPath: path.relative(repoRoot(), absPath).split(path.sep).join("/"),
    absPath,
    content: truncated ? raw.slice(0, MAX_SOURCE_CHARS) : raw,
    truncated,
  };
}
