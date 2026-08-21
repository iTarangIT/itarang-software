/**
 * E-255 — Google Drive mirror of every stored document.
 *
 * The CRM keeps its documents in S3 (see ./s3.ts). This module keeps a SECOND
 * copy of each object in Google Drive, laid out by human category —
 *
 *     <root folder> / KYC Documents / <lead> / <file>
 *     <root folder> / Dealer Onboarding / GST Certificate / <file>
 *     <root folder> / Call Recordings / Elevenlabs / <file>   …
 *
 * (rules in ./drive-mirror-layout.ts). It is a backup, not a second read
 * path: nothing in the app serves a document from Drive.
 *
 * How an object gets there:
 *
 *   1. `putObject()` / `putObjectStream()` in s3.ts call `onObjectStored()`
 *      right after the S3 write succeeds. That inserts a ledger row in
 *      `storage_drive_mirror` (status = pending) and, when the feature is on,
 *      tries the Drive upload straight away in the background — the request
 *      that uploaded the file never waits on Google.
 *   2. Anything the inline attempt could not finish (Google was down, quota
 *      full, the feature was off, the process restarted mid-upload) stays
 *      pending/failed in the ledger and is picked up by `runDriveMirrorTick()`
 *      — the 60 s in-process ticker (instrumentation-node.ts) and
 *      /api/cron/gdrive-mirror.
 *   3. `runDriveMirrorBackfill()` lists the S3 bucket and inserts a ledger row
 *      for every object that has none. Run once after switch-on to back up
 *      the existing corpus, and periodically as a safety net for the few
 *      uploads that bypass the app server (browser presigned PUTs).
 *
 * Failure semantics: a failed upload is never dropped. `attempts` grows,
 * `next_attempt_at` backs off (1 min → 6 h cap) and the row is retried on
 * every tick once due. "Retry failed now" in the admin panel resets the
 * clock. This matters because the most likely failure is a Workspace storage
 * quota problem, which is fixed outside this code — the backlog must simply
 * drain when it is.
 *
 * Auth: the same service account the Sheets export / expense scanner use
 * (GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY), with the full `drive`
 * scope. A service account has no My-Drive storage of its own, so uploads
 * either impersonate a Workspace user (settings.impersonateUser — needs
 * domain-wide delegation for that client id in the Admin console) or go into
 * a Shared Drive the service account is a member of. Both are supported: the
 * root folder id decides which.
 */

import { Readable } from "node:stream";
import path from "node:path";

import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { google, type drive_v3 } from "googleapis";

import { db } from "@/lib/db";
import { storageDriveMirror } from "@/lib/db/schema";
import { describeDriveError, parseDriveFolderId } from "@/lib/google/drive";
import {
  DRIVE_MIRROR_EXCLUDED_BUCKETS,
  driveFolderPathFor,
  isDriveMirrorExcluded,
} from "./drive-mirror-layout";
import {
  driveOAuthClient,
  getDriveOAuthGrant,
  type DriveOAuthGrant,
} from "./drive-mirror-oauth";
import { getDriveMirrorSettings, type DriveMirrorSettings } from "./drive-mirror-settings";
import { getObject, listAllObjects } from "./s3";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const APP_PROP_KEY = "itarang_object";
const SCOPES = ["https://www.googleapis.com/auth/drive"];

/** Ledger states. */
export type MirrorStatus = "pending" | "uploading" | "done" | "failed" | "source_deleted";

/** Backoff after the n-th failure: 1m, 2m, 4m … capped at 6h. */
export function backoffMs(attempts: number): number {
  const base = 60_000 * 2 ** Math.max(0, Math.min(attempts - 1, 12));
  return Math.min(base, 6 * 60 * 60_000);
}

/** Rows stuck in 'uploading' longer than this are assumed orphaned by a restart. */
const STALE_UPLOADING_MS = 15 * 60_000;

/** How many inline (request-time) uploads may run at once in this process. */
const INLINE_CONCURRENCY = 3;
let inlineInFlight = 0;

/** Settings are re-read at most this often from the request-time hook. */
const SETTINGS_TTL_MS = 30_000;
let settingsCache: { at: number; value: DriveMirrorSettings } | null = null;
async function cachedSettings(): Promise<DriveMirrorSettings> {
  const now = Date.now();
  if (settingsCache && now - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.value;
  const value = await getDriveMirrorSettings();
  settingsCache = { at: now, value };
  return value;
}
/** Drop every in-process cache — called after the admin form saves. */
export function invalidateDriveMirrorSettingsCache(): void {
  settingsCache = null;
  grantCache = null;
  driveClients.clear();
  folderCache.clear();
}

// ---------------------------------------------------------------------------
// Google client
// ---------------------------------------------------------------------------

export function isDriveMirrorCredentialConfigured(): boolean {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY);
}

const driveClients = new Map<string, drive_v3.Drive>();

/** The OAuth grant is re-read at most this often (it changes only via the settings page). */
const GRANT_TTL_MS = 30_000;
let grantCache: { at: number; value: DriveOAuthGrant | null } | null = null;
async function cachedGrant(): Promise<DriveOAuthGrant | null> {
  const now = Date.now();
  if (grantCache && now - grantCache.at < GRANT_TTL_MS) return grantCache.value;
  const value = await getDriveOAuthGrant();
  grantCache = { at: now, value };
  return value;
}

/** True when SOME credential can upload: an OAuth grant, or the service account. */
export async function hasAnyDriveCredential(): Promise<boolean> {
  if (await cachedGrant()) return true;
  return isDriveMirrorCredentialConfigured();
}

/**
 * Who the uploads are made as. Precedence:
 *   1. a connected Google account (OAuth grant from the settings page) — files
 *      are owned by that user, no admin-console step needed;
 *   2. the service account, impersonating `impersonate` when set (needs
 *      domain-wide delegation) or acting as itself (Shared Drive only).
 */
async function driveClient(impersonate: string | null): Promise<drive_v3.Drive> {
  const grant = await cachedGrant();
  if (grant) {
    const cacheKey = `oauth:${grant.refresh_token.slice(-12)}`;
    const cached = driveClients.get(cacheKey);
    if (cached) return cached;
    const auth = driveOAuthClient();
    auth.setCredentials({ refresh_token: grant.refresh_token });
    const client = google.drive({ version: "v3", auth });
    driveClients.set(cacheKey, client);
    return client;
  }

  if (!isDriveMirrorCredentialConfigured()) {
    throw new Error(
      "No Google credential: connect a Google account on the Drive Backup page, or set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY.",
    );
  }
  const cacheKey = `sa:${impersonate || ""}`;
  const cached = driveClients.get(cacheKey);
  if (cached) return cached;
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!,
    // PEM is stored single-line in .env — same replace as lib/google/drive.ts.
    key: process.env.GOOGLE_PRIVATE_KEY!.replace(/\\n/g, "\n"),
    scopes: SCOPES,
    subject: impersonate || undefined,
  });
  const client = google.drive({ version: "v3", auth });
  driveClients.set(cacheKey, client);
  return client;
}

/** Escape a value for a Drive `q` string literal. */
function q(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// ---------------------------------------------------------------------------
// Folder tree
// ---------------------------------------------------------------------------

/**
 * `${parentId}/${name}` → folder id. A Promise is cached (not the resolved id)
 * so two concurrent uploads into the same new sub-folder share ONE create call
 * instead of racing and producing two same-named folders — Drive allows
 * duplicate names, so nothing else would stop that.
 */
const folderCache = new Map<string, Promise<string>>();

async function ensureChildFolder(
  drive: drive_v3.Drive,
  parentId: string,
  name: string,
): Promise<string> {
  const cacheKey = `${parentId}/${name}`;
  const hit = folderCache.get(cacheKey);
  if (hit) return hit;

  const p = (async () => {
    const found = await drive.files.list({
      q: `name = '${q(name)}' and '${q(parentId)}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
      fields: "files(id)",
      pageSize: 1,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const existing = found.data.files?.[0]?.id;
    if (existing) return existing;
    const created = await drive.files.create({
      requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId] },
      fields: "id",
      supportsAllDrives: true,
    });
    if (!created.data.id) throw new Error(`Drive returned no id creating folder "${name}"`);
    return created.data.id;
  })();

  folderCache.set(cacheKey, p);
  // A failed lookup must not poison the cache for the next attempt.
  p.catch(() => folderCache.delete(cacheKey));
  return p;
}

/**
 * Resolve (creating as needed) the folder an object belongs in. The path is
 * the human category layout from ./drive-mirror-layout.ts — "KYC Documents /
 * LEAD-2026… /", "Dealer Onboarding / GST Certificate /" — not the raw bucket
 * name.
 */
async function folderForObject(
  drive: drive_v3.Drive,
  rootId: string,
  bucket: string,
  key: string,
): Promise<string> {
  const { path: names } = driveFolderPathFor(bucket, key);
  let parent = rootId;
  for (const name of names) {
    parent = await ensureChildFolder(drive, parent, name);
  }
  return parent;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export interface DriveUploadResult {
  fileId: string;
  folderId: string;
  webViewLink: string | null;
  md5: string | null;
}

/**
 * Upload (or re-upload) one object's bytes to Drive. Idempotent on
 * (bucket, key): an existing Drive file tagged with the same object gets a
 * new revision instead of a duplicate. `knownFileId` short-circuits the
 * lookup when the ledger already holds the id.
 */
export async function uploadBufferToDrive(
  settings: DriveMirrorSettings,
  bucket: string,
  key: string,
  body: Buffer,
  contentType: string | null,
  knownFileId: string | null = null,
): Promise<DriveUploadResult> {
  const rootId = settings.rootFolderId ? parseDriveFolderId(settings.rootFolderId) : null;
  if (!rootId) throw new Error("Drive mirror root folder is not configured.");
  const drive = await driveClient(settings.impersonateUser);

  const folderId = await folderForObject(drive, rootId, bucket, key);
  const name = path.posix.basename(key) || key;
  const objectTag = `${bucket}/${key}`;
  const mimeType = contentType || "application/octet-stream";
  const fields = "id, webViewLink, md5Checksum";

  let fileId = knownFileId;
  if (!fileId) {
    const found = await drive.files.list({
      q: `appProperties has { key='${APP_PROP_KEY}' and value='${q(objectTag)}' } and trashed = false`,
      fields: "files(id)",
      pageSize: 1,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    fileId = found.data.files?.[0]?.id ?? null;
  }

  if (fileId) {
    try {
      const res = await drive.files.update({
        fileId,
        requestBody: { name },
        media: { mimeType, body: Readable.from(body) },
        fields,
        supportsAllDrives: true,
      });
      return {
        fileId: res.data.id ?? fileId,
        folderId,
        webViewLink: res.data.webViewLink ?? null,
        md5: res.data.md5Checksum ?? null,
      };
    } catch (err) {
      // The ledger's id may point at a file someone deleted from Drive by
      // hand. Fall through and create a fresh one rather than failing forever.
      const code = Number((err as { code?: number | string })?.code);
      if (code !== 404) throw err;
    }
  }

  const res = await drive.files.create({
    requestBody: {
      name,
      parents: [folderId],
      appProperties: { [APP_PROP_KEY]: objectTag },
    },
    media: { mimeType, body: Readable.from(body) },
    fields,
    supportsAllDrives: true,
  });
  if (!res.data.id) throw new Error("Drive returned no id for the uploaded file");
  return {
    fileId: res.data.id,
    folderId,
    webViewLink: res.data.webViewLink ?? null,
    md5: res.data.md5Checksum ?? null,
  };
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

type LedgerRow = typeof storageDriveMirror.$inferSelect;

/**
 * Insert-or-refresh the ledger row for an object. Called on every S3 write,
 * so an overwrite of an existing key re-queues it (status back to pending)
 * and the Drive copy picks up the new bytes as a new revision.
 */
export async function enqueueDriveMirror(input: {
  bucket: string;
  key: string;
  contentType?: string | null;
  size?: number | null;
}): Promise<number | null> {
  // Excluded buckets (call recordings) never get a ledger row.
  if (isDriveMirrorExcluded(input.bucket, input.key)) return null;
  const now = new Date();
  const [row] = await db
    .insert(storageDriveMirror)
    .values({
      bucket: input.bucket,
      object_key: input.key,
      content_type: input.contentType ?? null,
      size_bytes: input.size ?? null,
      status: "pending",
      next_attempt_at: now,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [storageDriveMirror.bucket, storageDriveMirror.object_key],
      set: {
        content_type: input.contentType ?? sql`${storageDriveMirror.content_type}`,
        size_bytes: input.size ?? sql`${storageDriveMirror.size_bytes}`,
        status: "pending",
        next_attempt_at: now,
        last_error: null,
        updated_at: now,
      },
    })
    .returning({ id: storageDriveMirror.id });
  return row?.id ?? null;
}

async function markDone(id: number, r: DriveUploadResult): Promise<void> {
  const now = new Date();
  await db
    .update(storageDriveMirror)
    .set({
      status: "done",
      drive_file_id: r.fileId,
      drive_folder_id: r.folderId,
      drive_web_view_link: r.webViewLink,
      drive_md5: r.md5,
      last_error: null,
      mirrored_at: now,
      updated_at: now,
    })
    .where(eq(storageDriveMirror.id, id));
}

async function markFailed(id: number, attempts: number, err: unknown): Promise<void> {
  const now = new Date();
  const message = describeDriveError(err).slice(0, 2000);
  await db
    .update(storageDriveMirror)
    .set({
      status: "failed",
      attempts,
      next_attempt_at: new Date(now.getTime() + backoffMs(attempts)),
      last_error: message,
      updated_at: now,
    })
    .where(eq(storageDriveMirror.id, id));
}

/**
 * Do the work for one claimed row: fetch bytes (from the caller when it still
 * has them, else from S3) and upload. Updates the ledger either way.
 */
async function mirrorRow(
  row: Pick<LedgerRow, "id" | "bucket" | "object_key" | "content_type" | "attempts" | "drive_file_id">,
  settings: DriveMirrorSettings,
  body: Buffer | null,
): Promise<"done" | "failed" | "missing"> {
  if (isDriveMirrorExcluded(row.bucket, row.object_key)) {
    // Queued before the category was excluded — drop it, never upload.
    await db.delete(storageDriveMirror).where(eq(storageDriveMirror.id, row.id));
    return "missing";
  }
  try {
    const bytes = body ?? (await getObject(row.bucket, row.object_key));
    if (!bytes) {
      // Object gone from S3 between enqueue and upload — nothing to back up.
      await db
        .update(storageDriveMirror)
        .set({
          status: "source_deleted",
          last_error: "Object not found in S3 at upload time",
          updated_at: new Date(),
        })
        .where(eq(storageDriveMirror.id, row.id));
      return "missing";
    }
    const r = await uploadBufferToDrive(
      settings,
      row.bucket,
      row.object_key,
      bytes,
      row.content_type,
      row.drive_file_id,
    );
    await markDone(row.id, r);
    return "done";
  } catch (err) {
    await markFailed(row.id, row.attempts + 1, err);
    return "failed";
  }
}

/**
 * Atomically claim up to `limit` due rows. Two sweeps running at once (ticker
 * + cron, or two PM2 processes) split the work instead of duplicating it —
 * FOR UPDATE SKIP LOCKED — and the status flip inside the claim keeps a third
 * from seeing them.
 */
async function claimDue(limit: number): Promise<LedgerRow[]> {
  const rows = await db.execute<LedgerRow>(sql`
    UPDATE storage_drive_mirror
       SET status = 'uploading', updated_at = now()
     WHERE id IN (
           SELECT id
             FROM storage_drive_mirror
            WHERE status IN ('pending', 'failed')
              AND next_attempt_at <= now()
              AND bucket NOT IN (${sql.join(
                DRIVE_MIRROR_EXCLUDED_BUCKETS.map((b) => sql`${b}`),
                sql`, `,
              )})
            ORDER BY created_at
            LIMIT ${limit}
              FOR UPDATE SKIP LOCKED
     )
    RETURNING *
  `);
  return Array.from(rows as unknown as Iterable<LedgerRow>);
}

/** Return rows orphaned in 'uploading' (process died mid-upload) to pending. */
async function recoverStale(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_UPLOADING_MS);
  const rows = await db
    .update(storageDriveMirror)
    .set({ status: "pending", updated_at: new Date() })
    .where(and(eq(storageDriveMirror.status, "uploading"), lte(storageDriveMirror.updated_at, cutoff)))
    .returning({ id: storageDriveMirror.id });
  return rows.length;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Request-time hook — called by s3.ts after every successful PUT. Never
 * throws and never blocks the caller on Google: the ledger insert is awaited
 * (fast, local DB), the Drive upload is fire-and-forget with a small
 * concurrency cap; anything over the cap is left for the ticker.
 */
export async function onObjectStored(input: {
  bucket: string;
  key: string;
  contentType?: string | null;
  size?: number | null;
  /** The bytes, when the caller still has them — saves an S3 round-trip. */
  body?: Buffer | null;
}): Promise<void> {
  let id: number | null = null;
  try {
    id = await enqueueDriveMirror(input);
  } catch (err) {
    // Most likely E-255 not applied on this database. Log, don't break uploads.
    console.error(
      "[gdrive-mirror] could not enqueue",
      `${input.bucket}/${input.key}:`,
      err instanceof Error ? err.message : err,
    );
    return;
  }
  if (id == null) return;
  const rowId = id;

  let settings: DriveMirrorSettings;
  try {
    settings = await cachedSettings();
  } catch {
    return;
  }
  if (!settings.enabled || !settings.rootFolderId) return;
  if (!(await hasAnyDriveCredential())) return;
  if (inlineInFlight >= INLINE_CONCURRENCY) return; // ticker will get it

  // Claim just this row so a concurrently running tick doesn't double-upload.
  inlineInFlight += 1;
  void (async () => {
    try {
      const claimed = await db
        .update(storageDriveMirror)
        .set({ status: "uploading", updated_at: new Date() })
        .where(
          and(
            eq(storageDriveMirror.id, rowId),
            inArray(storageDriveMirror.status, ["pending", "failed"]),
          ),
        )
        .returning();
      const row = claimed[0];
      if (!row) return;
      await mirrorRow(row, settings, input.body ?? null);
    } catch (err) {
      console.error(
        "[gdrive-mirror] inline upload failed",
        `${input.bucket}/${input.key}:`,
        err instanceof Error ? err.message : err,
      );
    } finally {
      inlineInFlight -= 1;
    }
  })();
}

/** Called by s3.ts removeObjects — the S3 original is gone; keep the Drive copy, note it. */
export async function onObjectsRemoved(bucket: string, keys: string[]): Promise<void> {
  if (!keys.length) return;
  try {
    await db
      .update(storageDriveMirror)
      .set({ status: "source_deleted", updated_at: new Date() })
      .where(and(eq(storageDriveMirror.bucket, bucket), inArray(storageDriveMirror.object_key, keys)));
  } catch (err) {
    console.error(
      "[gdrive-mirror] could not flag removed objects:",
      err instanceof Error ? err.message : err,
    );
  }
}

export interface DriveMirrorTickResult {
  enabled: boolean;
  skipped_reason: string | null;
  claimed: number;
  done: number;
  failed: number;
  missing: number;
  recovered_stale: number;
  duration_ms: number;
}

/**
 * Process due ledger rows. Time-boxed so a cron/HTTP caller returns inside its
 * budget; whatever is left waits for the next tick.
 */
export async function runDriveMirrorTick(
  opts: { max?: number; timeBudgetMs?: number; concurrency?: number } = {},
): Promise<DriveMirrorTickResult> {
  const started = Date.now();
  const max = opts.max ?? 25;
  const budget = opts.timeBudgetMs ?? 50_000;
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const result: DriveMirrorTickResult = {
    enabled: false,
    skipped_reason: null,
    claimed: 0,
    done: 0,
    failed: 0,
    missing: 0,
    recovered_stale: 0,
    duration_ms: 0,
  };

  const settings = await getDriveMirrorSettings();
  settingsCache = { at: Date.now(), value: settings };
  result.enabled = settings.enabled;
  if (!settings.enabled) {
    result.skipped_reason = "disabled";
  } else if (!(await hasAnyDriveCredential())) {
    result.skipped_reason = "no Google credential (connect an account or configure the service account)";
  } else if (!settings.rootFolderId) {
    result.skipped_reason = "root folder not configured";
  }
  if (result.skipped_reason) {
    result.duration_ms = Date.now() - started;
    return result;
  }

  result.recovered_stale = await recoverStale();
  await purgeExcludedQueue();
  const rows = await claimDue(max);
  result.claimed = rows.length;

  // Small worker pool: `concurrency` uploads in flight; stop taking new rows
  // once the time budget is spent (an upload already started still finishes).
  let idx = 0;
  const worker = async () => {
    while (idx < rows.length) {
      if (Date.now() - started > budget) break;
      const row = rows[idx++];
      const outcome = await mirrorRow(row, settings, null);
      if (outcome === "done") result.done += 1;
      else if (outcome === "failed") result.failed += 1;
      else result.missing += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));

  // Anything claimed but never started (budget hit) goes back to pending.
  if (idx < rows.length) {
    const leftover = rows.slice(idx).map((r) => r.id);
    await db
      .update(storageDriveMirror)
      .set({ status: "pending", updated_at: new Date() })
      .where(inArray(storageDriveMirror.id, leftover));
    result.claimed -= leftover.length;
  }

  result.duration_ms = Date.now() - started;
  return result;
}

export interface DriveMirrorBackfillResult {
  listed: number;
  enqueued: number;
  duration_ms: number;
}

/**
 * Drop queued (not-yet-uploaded) rows for objects that are excluded from the
 * backup — rows enqueued before the allow-list / excluded-bucket rules were
 * tightened. Rows already `done` are left alone so the ledger still records
 * what is in Drive. Cheap once the backlog is clean (id/bucket/key only).
 */
export async function purgeExcludedQueue(): Promise<number> {
  const rows = await db
    .select({
      id: storageDriveMirror.id,
      bucket: storageDriveMirror.bucket,
      object_key: storageDriveMirror.object_key,
    })
    .from(storageDriveMirror)
    .where(inArray(storageDriveMirror.status, ["pending", "failed"]));
  const ids = rows.filter((r) => isDriveMirrorExcluded(r.bucket, r.object_key)).map((r) => r.id);
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    await db.delete(storageDriveMirror).where(inArray(storageDriveMirror.id, ids.slice(i, i + CHUNK)));
  }
  return ids.length;
}

/**
 * List every object in the S3 bucket and add a ledger row for each one that
 * has none. Existing rows are left alone (ON CONFLICT DO NOTHING) — a done row
 * is not re-uploaded, a failed row keeps its backoff clock. Cheap enough to
 * run periodically: one LIST per 1000 objects, one batched INSERT per 500.
 */
export async function runDriveMirrorBackfill(
  opts: { prefix?: string } = {},
): Promise<DriveMirrorBackfillResult> {
  const started = Date.now();
  await purgeExcludedQueue();
  const objects = await listAllObjects(opts.prefix ?? "");
  let enqueued = 0;
  const now = new Date();
  const CHUNK = 500;
  for (let i = 0; i < objects.length; i += CHUNK) {
    const chunk = objects.slice(i, i + CHUNK);
    const values = chunk
      .map((o) => {
        const slash = o.key.indexOf("/");
        if (slash <= 0 || slash === o.key.length - 1) return null; // not bucket/key shaped
        if (isDriveMirrorExcluded(o.key.slice(0, slash), o.key.slice(slash + 1))) return null;
        return {
          bucket: o.key.slice(0, slash),
          object_key: o.key.slice(slash + 1),
          content_type: null as string | null,
          size_bytes: o.size,
          status: "pending" as const,
          next_attempt_at: now,
          created_at: now,
          updated_at: now,
        };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);
    if (!values.length) continue;
    const inserted = await db
      .insert(storageDriveMirror)
      .values(values)
      .onConflictDoNothing({ target: [storageDriveMirror.bucket, storageDriveMirror.object_key] })
      .returning({ id: storageDriveMirror.id });
    enqueued += inserted.length;
  }
  return { listed: objects.length, enqueued, duration_ms: Date.now() - started };
}

/** Reset every failed row's clock so the next tick retries it immediately. */
export async function retryFailedNow(): Promise<number> {
  const rows = await db
    .update(storageDriveMirror)
    .set({ status: "pending", next_attempt_at: new Date(), updated_at: new Date() })
    .where(eq(storageDriveMirror.status, "failed"))
    .returning({ id: storageDriveMirror.id });
  return rows.length;
}

export interface DriveMirrorStatus {
  counts: Record<MirrorStatus, number>;
  total: number;
  bytes_done: number;
  last_mirrored_at: string | null;
  recent_failures: Array<{
    id: number;
    bucket: string;
    object_key: string;
    attempts: number;
    next_attempt_at: string;
    last_error: string | null;
  }>;
  recent_done: Array<{
    id: number;
    bucket: string;
    object_key: string;
    mirrored_at: string | null;
    drive_web_view_link: string | null;
  }>;
}

/** Ledger summary for the admin panel. */
export async function getDriveMirrorStatus(): Promise<DriveMirrorStatus> {
  const counts: Record<MirrorStatus, number> = {
    pending: 0,
    uploading: 0,
    done: 0,
    failed: 0,
    source_deleted: 0,
  };
  const grouped = await db
    .select({
      status: storageDriveMirror.status,
      n: sql<number>`count(*)::int`,
      bytes: sql<string>`coalesce(sum(size_bytes), 0)::bigint`,
    })
    .from(storageDriveMirror)
    .groupBy(storageDriveMirror.status);
  let bytesDone = 0;
  for (const g of grouped) {
    if (g.status in counts) counts[g.status as MirrorStatus] = g.n;
    if (g.status === "done") bytesDone = Number(g.bytes);
  }
  const [last] = await db
    .select({ at: sql<string | null>`max(mirrored_at)` })
    .from(storageDriveMirror);
  const failures = await db
    .select({
      id: storageDriveMirror.id,
      bucket: storageDriveMirror.bucket,
      object_key: storageDriveMirror.object_key,
      attempts: storageDriveMirror.attempts,
      next_attempt_at: storageDriveMirror.next_attempt_at,
      last_error: storageDriveMirror.last_error,
    })
    .from(storageDriveMirror)
    .where(eq(storageDriveMirror.status, "failed"))
    .orderBy(desc(storageDriveMirror.updated_at))
    .limit(10);
  const done = await db
    .select({
      id: storageDriveMirror.id,
      bucket: storageDriveMirror.bucket,
      object_key: storageDriveMirror.object_key,
      mirrored_at: storageDriveMirror.mirrored_at,
      drive_web_view_link: storageDriveMirror.drive_web_view_link,
    })
    .from(storageDriveMirror)
    .where(eq(storageDriveMirror.status, "done"))
    .orderBy(desc(storageDriveMirror.mirrored_at))
    .limit(10);
  return {
    counts,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    bytes_done: bytesDone,
    last_mirrored_at: last?.at ? new Date(last.at).toISOString() : null,
    recent_failures: failures.map((f) => ({
      ...f,
      next_attempt_at: f.next_attempt_at.toISOString(),
    })),
    recent_done: done.map((d) => ({
      ...d,
      mirrored_at: d.mirrored_at ? d.mirrored_at.toISOString() : null,
    })),
  };
}

/**
 * Probe the configured root folder: does it exist, can we see it, can we
 * write into it, who are we acting as. Used by "Test connection".
 */
export async function probeDriveMirror(settings?: DriveMirrorSettings): Promise<{
  ok: boolean;
  message: string;
  folder_name?: string;
  can_add_children?: boolean;
  drive_id?: string | null;
  acting_as?: string;
}> {
  const s = settings ?? (await getDriveMirrorSettings());
  grantCache = null;
  const grant = await cachedGrant();
  if (!grant && !isDriveMirrorCredentialConfigured()) {
    return {
      ok: false,
      message:
        "No Google credential — connect a Google account below, or set GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY.",
    };
  }
  const rootId = s.rootFolderId ? parseDriveFolderId(s.rootFolderId) : null;
  if (!rootId) return { ok: false, message: "No root folder configured." };
  const actingAs = grant
    ? grant.email || "the connected Google account"
    : s.impersonateUser || process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "service account";
  try {
    const drive = await driveClient(s.impersonateUser);
    const res = await drive.files.get({
      fileId: rootId,
      fields: "id, name, mimeType, driveId, capabilities(canAddChildren)",
      supportsAllDrives: true,
    });
    if (res.data.mimeType !== FOLDER_MIME) {
      return { ok: false, message: "That Drive id is a file, not a folder.", acting_as: actingAs };
    }
    const canAdd = res.data.capabilities?.canAddChildren ?? false;
    return {
      ok: canAdd,
      message: canAdd
        ? `Connected. Uploads will land in "${res.data.name}"${
            res.data.driveId ? " (Shared Drive)" : ""
          } as ${actingAs}.`
        : `"${res.data.name}" is visible but ${actingAs} cannot create files in it — share it with Editor access.`,
      folder_name: res.data.name ?? undefined,
      can_add_children: canAdd,
      drive_id: res.data.driveId ?? null,
      acting_as: actingAs,
    };
  } catch (err) {
    return { ok: false, message: describeDriveError(err), acting_as: actingAs };
  }
}
