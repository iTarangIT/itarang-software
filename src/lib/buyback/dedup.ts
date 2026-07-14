/**
 * The photo dedup sweep (M03).
 *
 *   AC: "duplicate phash across dealers raises a flag."
 *
 * Two jobs, run by the same ticker:
 *
 *   1. HASH  — compute a dHash for photos that don't have one yet.
 *   2. MATCH — find photos whose hash matches an EARLIER photo, and flag them.
 *
 * WHY THE CROSS-DEALER CASE IS THE ONE THAT MATTERS:
 * a duplicate within one dealer's own request is almost always a careless
 * re-upload — the same battery photographed twice, or the same file attached to
 * two lines. Annoying, not dishonest. But the SAME battery photo appearing under
 * TWO DIFFERENT DEALERS means one battery is being sold to us twice. That is
 * fraud, and it is worth real money: we would pay two dealers, take delivery of
 * one battery, and discover it at the weighbridge — or not at all.
 *
 * So the two are flagged distinctly, and only the cross-dealer one is escalated
 * to the admins.
 *
 * WHY THIS IS A TICKER AND NOT BULLMQ: same reason as the dispatcher. BullMQ is
 * dead code in this repo (no worker is deployed) and Vercel crons do not fire on
 * the pm2 VPS. See src/lib/buyback/dispatch.ts for the full argument.
 *
 * Hashing is EXACT-MATCH in SQL (an indexed lookup), then near-matches are
 * confirmed in JS with a Hamming distance. Doing the fuzzy comparison in Postgres
 * would mean a cross join over every photo ever uploaded; doing the exact lookup
 * first shrinks the candidate set to something a Hamming pass can afford.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { notifyRoles } from "@/lib/notifications/notify";
import { getObject } from "@/lib/storage/s3";

import { BUYBACK_ADMIN_ROLES } from "./auth";
import { computePhash, isDuplicate } from "./phash";
import { BUYBACK_BUCKET } from "./storage";

export interface DedupSummary {
  hashed: number;
  hashFailed: number;
  flagged: number;
  crossDealer: number;
}

/** Compute hashes for photos that don't have one. */
async function hashPending(limit: number): Promise<{ hashed: number; failed: number }> {
  const rows = (await db.execute(sql`
    SELECT id, COALESCE(s3_key_display, s3_key_original) AS s3_key
    FROM buyback_photos
    WHERE phash IS NULL
    ORDER BY created_at
    LIMIT ${limit}
  `)) as unknown as Array<{ id: string; s3_key: string }>;

  let hashed = 0;
  let failed = 0;

  for (const row of rows) {
    const bytes = row.s3_key ? await getObject(BUYBACK_BUCKET, row.s3_key) : null;
    const phash = bytes ? await computePhash(bytes) : null;

    if (!phash) {
      // Stamp the attempt so a permanently-unreadable photo is not retried every
      // 24h forever. phash stays NULL — it simply drops out of the queue.
      await db.execute(sql`
        UPDATE buyback_photos SET phash_computed_at = now() WHERE id = ${row.id}
      `);
      failed += 1;
      continue;
    }

    await db.execute(sql`
      UPDATE buyback_photos
      SET phash = ${phash}, phash_computed_at = now()
      WHERE id = ${row.id}
    `);
    hashed += 1;
  }

  return { hashed, failed };
}

/**
 * Flag photos whose hash matches an EARLIER photo.
 *
 * "Earlier" is what makes this stable: the first upload of an image is the
 * original, every later one is the duplicate. Without that ordering the pair
 * would flag each other and the flag would flip depending on scan order.
 */
async function flagDuplicates(): Promise<{ flagged: number; crossDealer: number }> {
  // Exact-hash candidates, with each photo's owning dealer. The index on phash
  // makes this a lookup rather than a scan.
  const candidates = (await db.execute(sql`
    SELECT
      p2.id           AS dup_id,
      p2.phash        AS dup_phash,
      p1.id           AS orig_id,
      p1.phash        AS orig_phash,
      r2.dealer_entity_id AS dup_dealer,
      r1.dealer_entity_id AS orig_dealer,
      r2.request_no   AS dup_request,
      r1.request_no   AS orig_request
    FROM buyback_photos p2
    JOIN buyback_lines l2    ON l2.id = p2.line_id
    JOIN buyback_batches b2  ON b2.id = l2.batch_id
    JOIN buyback_requests r2 ON r2.id = b2.request_id
    JOIN buyback_photos p1   ON p1.phash = p2.phash
                            AND p1.id <> p2.id
                            AND p1.created_at < p2.created_at
    JOIN buyback_lines l1    ON l1.id = p1.line_id
    JOIN buyback_batches b1  ON b1.id = l1.batch_id
    JOIN buyback_requests r1 ON r1.id = b1.request_id
    WHERE p2.phash IS NOT NULL
      AND p2.dup_flag IS NULL
      AND p2.dup_cleared_at IS NULL
  `)) as unknown as Array<{
    dup_id: string;
    dup_phash: string;
    orig_id: string;
    orig_phash: string;
    dup_dealer: string;
    orig_dealer: string;
    dup_request: string;
    orig_request: string;
  }>;

  let flagged = 0;
  let crossDealer = 0;
  const seen = new Set<string>();

  for (const c of candidates) {
    if (seen.has(c.dup_id)) continue; // one flag per photo, against its first match
    // Belt and braces: the SQL matched on exact equality, but the threshold check
    // is what the rule actually is, so it is applied rather than assumed.
    if (!isDuplicate(c.dup_phash, c.orig_phash)) continue;

    seen.add(c.dup_id);

    const cross = c.dup_dealer !== c.orig_dealer;
    const flag = cross ? "DUPLICATE_CROSS_DEALER" : "DUPLICATE_SAME_DEALER";

    await db.execute(sql`
      UPDATE buyback_photos
      SET dup_of_photo_id = ${c.orig_id},
          dup_flag        = ${flag}::buyback_photo_flag,
          dup_flagged_at  = now()
      WHERE id = ${c.dup_id}
    `);

    flagged += 1;

    if (cross) {
      crossDealer += 1;
      // THE FRAUD CASE. This one gets a human, now — not a log line.
      await notifyRoles([...BUYBACK_ADMIN_ROLES], {
        type: "buyback.duplicate_photo",
        title: "Same battery photo under two different dealers",
        message:
          `A photo on ${c.dup_request} matches one already uploaded on ${c.orig_request}, ` +
          `by a DIFFERENT dealer. The same battery may be being sold to iTarang twice. ` +
          `Review both requests before approving either.`,
        data: {
          duplicate_photo_id: c.dup_id,
          original_photo_id: c.orig_id,
          duplicate_request: c.dup_request,
          original_request: c.orig_request,
        },
      }).catch(() => {
        // Best-effort, by the notify helper's own contract. The flag is already on
        // the row, so the admin queue shows it even if the bell insert failed.
      });
    }
  }

  return { flagged, crossDealer };
}

export async function runDedupSweep(hashLimit = 100): Promise<DedupSummary> {
  const { hashed, failed } = await hashPending(hashLimit);
  const { flagged, crossDealer } = await flagDuplicates();
  return { hashed, hashFailed: failed, flagged, crossDealer };
}
