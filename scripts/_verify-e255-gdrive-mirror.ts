/**
 * E-255 end-to-end check against the ACTIVE database (prints the host first)
 * and a real Google Drive folder.
 *
 *   node --import tsx --env-file=.env.local scripts/_verify-e255-gdrive-mirror.ts <folderIdOrUrl> [impersonateUser]
 *
 * What it does:
 *   1. probes the folder with the configured service account,
 *   2. uploads one throwaway text object through uploadBufferToDrive()
 *      (bucket "documents", key "_gdrive-mirror-selftest/<ts>.txt") — no S3
 *      write involved — and re-uploads it to prove idempotency,
 *   3. exercises the ledger: enqueue → claim/upload via runDriveMirrorTick
 *      (the object is NOT in S3, so the tick must flag it source_deleted),
 *   4. lists S3 through the backfill path (dry: reports counts, enqueues
 *      nothing unless --backfill is passed),
 *   5. trashes the Drive test file and deletes the ledger rows it created,
 *      restoring the settings to what they were.
 */
import { and, eq, like } from "drizzle-orm";
import { google } from "googleapis";

import { db } from "@/lib/db";
import { storageDriveMirror } from "@/lib/db/schema";
import { parseDriveFolderId } from "@/lib/google/drive";
import {
  enqueueDriveMirror,
  probeDriveMirror,
  runDriveMirrorBackfill,
  runDriveMirrorTick,
  uploadBufferToDrive,
  invalidateDriveMirrorSettingsCache,
} from "@/lib/storage/drive-mirror";
import {
  getDriveMirrorSettings,
  setDriveMirrorSettings,
} from "@/lib/storage/drive-mirror-settings";
import { listAllObjects } from "@/lib/storage/s3";

const [, , folderArg, impersonateArg] = process.argv;
const BACKFILL = process.argv.includes("--backfill");

function host(): string {
  try {
    return new URL(process.env.DATABASE_URL || "").hostname;
  } catch {
    return "?";
  }
}

async function main() {
  console.log("DB HOST:", host());
  console.log("S3 BUCKET:", process.env.AWS_S3_BUCKET, "backend:", process.env.STORAGE_BACKEND);
  const folderId = folderArg ? parseDriveFolderId(folderArg) : null;
  if (!folderId) {
    console.error("usage: … scripts/_verify-e255-gdrive-mirror.ts <folderIdOrUrl> [impersonateUser]");
    process.exit(2);
  }

  const before = await getDriveMirrorSettings();
  console.log("settings before:", before);
  const settings = await setDriveMirrorSettings({
    enabled: true,
    rootFolderId: folderId,
    impersonateUser: impersonateArg ?? null,
  });
  invalidateDriveMirrorSettingsCache();

  const stamp = Date.now();
  const testKey = `_gdrive-mirror-selftest/${stamp}.txt`;
  const driveFileIds: string[] = [];
  let failed = false;
  try {
    // 1. probe
    const probe = await probeDriveMirror(settings);
    console.log("\n[1] probe:", probe);
    if (!probe.ok) throw new Error("probe failed — fix sharing/credentials first");

    // 2. direct upload + idempotent re-upload. A failure here (typically
    //    "Service Accounts do not have storage quota" — the folder is a plain
    //    My-Drive folder and no impersonation user was given) is reported but
    //    the remaining steps still run so the ledger path gets exercised.
    try {
      const r1 = await uploadBufferToDrive(
        settings,
        "documents",
        testKey,
        Buffer.from(`itarang gdrive mirror self-test ${stamp}\n`),
        "text/plain",
      );
      console.log("[2] uploaded:", r1);
      driveFileIds.push(r1.fileId);
      const r2 = await uploadBufferToDrive(
        settings,
        "documents",
        testKey,
        Buffer.from(`itarang gdrive mirror self-test ${stamp} (v2)\n`),
        "text/plain",
      );
      console.log(
        "[2] re-uploaded (same file id expected):",
        r2.fileId === r1.fileId ? "OK same id" : `MISMATCH ${r2.fileId}`,
      );
      if (r2.fileId !== r1.fileId) failed = true;
    } catch (err) {
      failed = true;
      console.log("[2] UPLOAD FAILED:", err instanceof Error ? err.message : err);
    }

    // 3. ledger path: enqueue a key that is not in S3 → tick must mark source_deleted
    const ghostKey = `_gdrive-mirror-selftest/ghost-${stamp}.txt`;
    const id = await enqueueDriveMirror({ bucket: "documents", key: ghostKey, contentType: "text/plain" });
    console.log("[3] enqueued ledger row id", id);
    const tick = await runDriveMirrorTick({ max: 5, timeBudgetMs: 30_000 });
    console.log("[3] tick:", tick);
    const [row] = await db
      .select({ status: storageDriveMirror.status, last_error: storageDriveMirror.last_error })
      .from(storageDriveMirror)
      .where(and(eq(storageDriveMirror.bucket, "documents"), eq(storageDriveMirror.object_key, ghostKey)));
    console.log("[3] ghost row after tick:", row);
    if (row?.status !== "source_deleted") {
      console.log("    ^^ expected source_deleted (object is not in S3)");
      failed = true;
    }

    // 3b. a REAL S3 object through the ledger → tick → done, or failed (+backoff)
    const objects = await listAllObjects();
    const sample = objects.find((o) => (o.size ?? 0) > 0 && (o.size ?? 0) < 512 * 1024);
    if (sample) {
      const slash = sample.key.indexOf("/");
      const b = sample.key.slice(0, slash);
      const k = sample.key.slice(slash + 1);
      const [existing] = await db
        .select({ id: storageDriveMirror.id })
        .from(storageDriveMirror)
        .where(and(eq(storageDriveMirror.bucket, b), eq(storageDriveMirror.object_key, k)));
      const id2 = await enqueueDriveMirror({ bucket: b, key: k, size: sample.size });
      const tick2 = await runDriveMirrorTick({ max: 1, timeBudgetMs: 30_000 });
      const [row2] = await db.select().from(storageDriveMirror).where(eq(storageDriveMirror.id, id2!));
      console.log(`[3b] real object ${sample.key} → tick`, { done: tick2.done, failed: tick2.failed }, {
        status: row2?.status,
        attempts: row2?.attempts,
        next_attempt_at: row2?.next_attempt_at,
        last_error: row2?.last_error,
        drive_web_view_link: row2?.drive_web_view_link,
      });
      if (row2?.status === "done" && row2.drive_file_id) driveFileIds.push(row2.drive_file_id);
      if (!existing) {
        await db.delete(storageDriveMirror).where(eq(storageDriveMirror.id, id2!));
        console.log("[3b] removed the ledger row again (it did not exist before this run)");
      }
    }

    // 4. S3 listing (what backfill would enqueue)
    const byBucket = new Map<string, { n: number; bytes: number }>();
    for (const o of objects) {
      const b = o.key.split("/")[0];
      const cur = byBucket.get(b) ?? { n: 0, bytes: 0 };
      cur.n += 1;
      cur.bytes += o.size ?? 0;
      byBucket.set(b, cur);
    }
    console.log(`[4] S3 has ${objects.length} objects:`);
    for (const [b, v] of byBucket) console.log(`     ${b}: ${v.n} objects, ${(v.bytes / 1024 / 1024).toFixed(1)} MB`);
    if (BACKFILL) {
      const bf = await runDriveMirrorBackfill();
      console.log("[4] backfill:", bf);
    } else {
      console.log("[4] (pass --backfill to enqueue them; not done)");
    }
  } catch (err) {
    failed = true;
    console.error("FAILED:", err instanceof Error ? err.message : err);
  } finally {
    // 5. cleanup
    if (driveFileIds.length) {
      try {
        const auth = new google.auth.JWT({
          email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!,
          key: process.env.GOOGLE_PRIVATE_KEY!.replace(/\\n/g, "\n"),
          scopes: ["https://www.googleapis.com/auth/drive"],
          subject: impersonateArg || undefined,
        });
        const drive = google.drive({ version: "v3", auth });
        for (const fid of driveFileIds) {
          await drive.files.delete({ fileId: fid, supportsAllDrives: true });
          console.log("\n[5] deleted Drive test file", fid);
        }
      } catch (err) {
        console.log("[5] could not delete Drive test file:", err instanceof Error ? err.message : err);
      }
    }
    const gone = await db
      .delete(storageDriveMirror)
      .where(like(storageDriveMirror.object_key, "_gdrive-mirror-selftest/%"))
      .returning({ id: storageDriveMirror.id });
    console.log(`[5] removed ${gone.length} self-test ledger row(s)`);
    await setDriveMirrorSettings(before);
    invalidateDriveMirrorSettingsCache();
    console.log("[5] settings restored:", before);
    console.log(failed ? "\nRESULT: FAILED" : "\nRESULT: OK");
    process.exit(failed ? 1 : 0);
  }
}

main();
