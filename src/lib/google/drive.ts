/**
 * E-216 — Google Drive reader for the expense scanner.
 *
 * Auth is the SAME service account the Sheets integration already uses
 * (src/lib/google/sheet.ts) — `GOOGLE_SERVICE_ACCOUNT_EMAIL` +
 * `GOOGLE_PRIVATE_KEY` — with the Drive read-only scope added. Two setup steps
 * are easy to miss and both fail quietly-ish:
 *
 *   1. The Drive API must be ENABLED in the GCP project that owns the service
 *      account. Only the Sheets API was enabled before this module; without it
 *      every call 403s with `accessNotConfigured`.
 *   2. Each folder must be SHARED with the service-account email. A service
 *      account has no Drive of its own, so an unshared folder is not an error —
 *      it lists as empty, which reads exactly like "no new invoices".
 *
 * `describeDriveError` exists to turn both of those into sentences a human can
 * act on, because the raw googleapis error is a wall of JSON.
 */
import { google, type drive_v3 } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];

const FOLDER_MIME = "application/vnd.google-apps.folder";
const GOOGLE_SHEET_MIME = "application/vnd.google-apps.spreadsheet";

/**
 * How deep to walk sub-folders. Guards against a pathological tree.
 *
 * Real accounts folders are deeper than you would guess. The live one is
 * root / 2026 / March 2026 / Purchase / iTarang account / Trontek / <file> —
 * six levels before the first PDF. A cap of 5 would have silently found
 * nothing there, so this is set well clear of it, and `truncatedAtDepth` below
 * reports when it does bite rather than dropping files quietly.
 */
const MAX_DEPTH = 10;

/**
 * Folder names skipped by default.
 *
 * This module books EXPENSES. A typical accounts folder splits each month into
 * Purchase and Sale, and the Sale side holds customer invoices — revenue,
 * which this CRM already gets from Zoho into `zoho_invoices`. Walking into it
 * would add the company's entire turnover to the expense total and
 * double-count it against Zoho: the single worst thing this module could do.
 *
 * Matched as a leading word, not an exact name — see `folderMatchesToken`. The
 * live folder proved why: 2026 names these "Sale" / "Sales", but 2025 names
 * them "Sales Invoices". An exact-name list silently let 19 customer invoices
 * through, which is the precise failure this exists to prevent.
 *
 * Secondary guard only. The primary filter is the ALLOWLIST below — this
 * catches a sales folder misfiled inside a purchase branch, where the
 * allowlist alone would have already let it in.
 */
export const DEFAULT_EXCLUDED_FOLDER_NAMES = ["sale"];

/**
 * Only files inside a folder matching one of these are imported.
 *
 * This is an ALLOWLIST, and it is the main safety property of the scanner:
 * an accounts folder holds both sides of the books, and only the purchase
 * side is an expense. A denylist has to anticipate every name the sales side
 * might be given ("Sale", "Sales", "Sale Invoices", "Sales Invoices" all
 * appear in the live folder, across two different yearly conventions) and
 * fails open when it misses one — booking customer invoices as company spend.
 * An allowlist fails closed: an unrecognised folder is skipped and logged,
 * not imported.
 *
 * Scope is inherited: once the walk enters "Purchase Invoices", everything
 * below it ("iTarang Account / Trontek / *.pdf") is in scope too.
 *
 * An empty list means "no allowlist" — every folder is in scope, and only the
 * exclusions above apply.
 */
export const DEFAULT_INCLUDED_FOLDER_NAMES = ["purchase"];

/**
 * Does this folder name match one of the exclusion tokens?
 *
 * A token matches the name itself, its plural, or either followed by more
 * words: "sale" catches Sale, Sales, "Sale Invoices" and "Sales Invoices".
 * A token appearing later in the name does not match, so "Wholesale" and
 * "Resale Docs" are still walked.
 *
 * Deliberately biased toward excluding. Wrongly skipping a folder understates
 * expenses, is logged with its full path, and is fixed by editing one field.
 * Wrongly including one books the company's revenue as spend and double-counts
 * it against Zoho — silently, and in the direction nobody questions. The two
 * errors are not symmetric.
 */
export function folderMatchesToken(name: string, tokens: Iterable<string>): boolean {
  const n = name.trim().toLowerCase();
  for (const raw of tokens) {
    const t = raw.trim().toLowerCase();
    if (!t) continue;
    if (n === t || n === `${t}s`) return true;
    if (n.startsWith(`${t} `) || n.startsWith(`${t}s `)) return true;
  }
  return false;
}

/** Per-file byte cap. Anything larger is reported, not silently ignored. */
export const MAX_DRIVE_FILE_BYTES = 10 * 1024 * 1024;

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  /**
   * Google's content hash. Native Google-apps files (Sheets/Docs) have none —
   * callers should fall back to `modifiedTime` as the version key so the
   * (file_id, checksum) dedup index still has something non-null to bite on.
   */
  md5Checksum: string | null;
  modifiedTime: string | null;
  size: number | null;
  /** Drive folder id this file was found in (not necessarily the scan root). */
  parentFolderId: string;
  /**
   * Human-readable path from the scan root, e.g.
   * "2026 / March 2026 / Purchase / iTarang account / Trontek".
   *
   * Carried because in an accounts folder the path IS the meaning — it says
   * which month, which entity and whether this is a purchase. Stored on the
   * ingest log so "where did this ₹1.2L come from?" has an answer that does
   * not require opening Drive.
   */
  folderPath: string;
}

export interface ListFolderResult {
  files: DriveFile[];
  /** Paths of folders deliberately not walked (see DEFAULT_EXCLUDED_FOLDER_NAMES). */
  skippedFolders: string[];
  /**
   * Folder paths holding files that fell outside the allowlist. Worth showing:
   * a Purchase folder named something unrecognised shows up here rather than
   * vanishing, which is how you find out the allowlist needs widening.
   */
  skippedOutOfScope: string[];
  /** True when the depth cap stopped the walk — files may have been missed. */
  truncatedAtDepth: boolean;
}

export function isDriveConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY,
  );
}

function getAuth() {
  // The `\\n` → `\n` replace is load-bearing: the PEM is stored single-line in
  // .env, exactly as sheet.ts:61 does it.
  return new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!,
    key: process.env.GOOGLE_PRIVATE_KEY!.replace(/\\n/g, "\n"),
    scopes: SCOPES,
  });
}

function getDriveClient(): drive_v3.Drive {
  if (!isDriveConfigured()) {
    throw new Error(
      "Google Drive is not configured — set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY.",
    );
  }
  return google.drive({ version: "v3", auth: getAuth() });
}

/**
 * Accepts a bare folder id or any Drive folder URL and returns the id.
 * The admin UI takes whatever the user pasted out of the address bar.
 */
export function parseDriveFolderId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  const patterns = [
    /\/folders\/([a-zA-Z0-9_-]{10,})/, // .../drive/folders/<id>
    /[?&]id=([a-zA-Z0-9_-]{10,})/, // ...open?id=<id>
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m) return m[1];
  }

  // A bare id: Drive ids are URL-safe base64-ish and comfortably over 10 chars.
  if (/^[a-zA-Z0-9_-]{10,}$/.test(raw)) return raw;
  return null;
}

/** Turn a googleapis failure into something worth showing an admin. */
export function describeDriveError(err: unknown): string {
  const anyErr = err as {
    code?: number | string;
    message?: string;
    errors?: Array<{ reason?: string; message?: string }>;
  };
  const reason = anyErr?.errors?.[0]?.reason;
  const status = Number(anyErr?.code);
  const message = anyErr?.message ?? "";

  // Checked on the message as well as the `reason` field: Google returns this
  // as a plain 403 whose structured `reason` is often absent, and without the
  // text match it falls through to the generic 403 below and tells you to fix
  // folder sharing — which is not the problem and wastes the setup session.
  if (
    reason === "accessNotConfigured" ||
    /has not been used in project|is disabled|accessNotConfigured/i.test(message)
  ) {
    const projectMatch = message.match(/project (\d+)/);
    return (
      "The Google Drive API is not enabled for this service account's Google Cloud project" +
      (projectMatch ? ` (${projectMatch[1]})` : "") +
      ". Enable it at https://console.developers.google.com/apis/api/drive.googleapis.com/overview" +
      (projectMatch ? `?project=${projectMatch[1]}` : "") +
      " and allow a few minutes for it to propagate."
    );
  }
  if (status === 404) {
    return "That folder does not exist, or it has not been shared with the service account.";
  }
  if (status === 403) {
    return `Google Drive refused the request${
      reason ? ` (${reason})` : ""
    }. The usual cause is the folder not being shared with ${
      process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "the service account"
    }.`;
  }
  if (status === 429 || status === 503) {
    return "Google Drive is rate-limiting or temporarily unavailable. The next scheduled scan will retry.";
  }
  return anyErr?.message || "Google Drive request failed.";
}

/** Read a folder's own name, so the UI can label it without the admin typing one. */
export async function getFolderName(folderId: string): Promise<string | null> {
  const drive = getDriveClient();
  const res = await drive.files.get({
    fileId: folderId,
    fields: "name, mimeType",
    supportsAllDrives: true,
  });
  if (res.data.mimeType !== FOLDER_MIME) {
    throw new Error("That Drive id is a file, not a folder.");
  }
  return res.data.name ?? null;
}

/**
 * List every non-folder file under `folderId`.
 *
 * `supportsAllDrives` + `includeItemsFromAllDrives` are required for Shared
 * Drives (Team Drives). Without them the call succeeds and returns an EMPTY
 * list, which is the worst kind of failure — indistinguishable from an empty
 * folder.
 */
export async function listFolderFiles(
  folderId: string,
  opts: {
    recursive?: boolean;
    /** Folder names to skip outright. Defaults to Sale/Sales. */
    excludeNames?: string[];
    /**
     * Only import files at or below a folder matching one of these.
     * Defaults to Purchase. Pass `[]` to disable the allowlist.
     */
    includeNames?: string[];
  } = {},
): Promise<ListFolderResult> {
  const drive = getDriveClient();
  const recursive = opts.recursive ?? true;
  const excluded = opts.excludeNames ?? DEFAULT_EXCLUDED_FOLDER_NAMES;
  const included = opts.includeNames ?? DEFAULT_INCLUDED_FOLDER_NAMES;
  const hasAllowlist = [...included].some((t) => t.trim());

  const out: DriveFile[] = [];
  const skippedFolders: string[] = [];
  const skippedOutOfScope: string[] = [];
  let truncatedAtDepth = false;
  const visited = new Set<string>();
  // `inScope` is inherited: it flips true on entering an allowlisted folder
  // and stays true for everything beneath it.
  const queue: Array<{ id: string; depth: number; path: string; inScope: boolean }> = [
    { id: folderId, depth: 0, path: "", inScope: !hasAllowlist },
  ];

  while (queue.length > 0) {
    const { id, depth, path, inScope } = queue.shift()!;
    if (visited.has(id)) continue; // a shortcut loop would otherwise spin forever
    visited.add(id);

    let pageToken: string | undefined;
    do {
      const res = await drive.files.list({
        q: `'${id}' in parents and trashed = false`,
        fields:
          "nextPageToken, files(id, name, mimeType, md5Checksum, modifiedTime, size)",
        pageSize: 200,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        orderBy: "modifiedTime desc",
      });

      for (const f of res.data.files ?? []) {
        if (!f.id || !f.name) continue;
        if (f.mimeType === FOLDER_MIME) {
          if (!recursive) continue;
          const childPath = path ? `${path} / ${f.name}` : f.name;
          if (folderMatchesToken(f.name, excluded)) {
            // Reported, not silent: "we deliberately ignored your Sales folder"
            // and "we found nothing" must never look the same.
            skippedFolders.push(childPath);
            continue;
          }
          if (depth >= MAX_DEPTH) {
            truncatedAtDepth = true;
            continue;
          }
          // Keep walking even while out of scope — the Purchase folders sit
          // under year/month folders that are not themselves allowlisted.
          queue.push({
            id: f.id,
            depth: depth + 1,
            path: childPath,
            inScope: inScope || folderMatchesToken(f.name, included),
          });
          continue;
        }

        // Out of scope: a file that never sat under an allowlisted folder.
        // Logged by folder so an admin can spot a Purchase folder named
        // something the allowlist does not recognise.
        if (!inScope) {
          skippedOutOfScope.push(path || "(root)");
          continue;
        }
        out.push({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType ?? "application/octet-stream",
          md5Checksum: f.md5Checksum ?? null,
          modifiedTime: f.modifiedTime ?? null,
          size: f.size == null ? null : Number(f.size),
          parentFolderId: id,
          folderPath: path,
        });
      }

      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  }

  return { files: out, skippedFolders, skippedOutOfScope, truncatedAtDepth };
}

/** Download a binary file (PDF, image, xlsx, csv) as a Buffer. */
export async function downloadFile(fileId: string): Promise<Buffer> {
  const drive = getDriveClient();
  const res = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" },
  );
  return Buffer.from(res.data as ArrayBuffer);
}

/**
 * Native Google Sheets have no downloadable bytes — they must be exported.
 * CSV is enough here: the costing-sheet extractor only ever reads the first
 * sheet's cell values.
 */
export async function exportGoogleSheetAsCsv(fileId: string): Promise<Buffer> {
  const drive = getDriveClient();
  const res = await drive.files.export(
    { fileId, mimeType: "text/csv" },
    { responseType: "arraybuffer" },
  );
  return Buffer.from(res.data as ArrayBuffer);
}

export function isGoogleSheet(mimeType: string): boolean {
  return mimeType === GOOGLE_SHEET_MIME;
}

/** True for Google-apps files generally (Docs, Slides, Sheets, Forms…). */
export function isGoogleNativeFile(mimeType: string): boolean {
  return mimeType.startsWith("application/vnd.google-apps.");
}
