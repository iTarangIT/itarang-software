/**
 * POST /api/buyback/requests/:id/photos
 *
 * Records a photo AFTER the browser has PUT the bytes to the presigned URL.
 * Two steps on purpose: the upload never touches the Next server, and the DB row
 * only appears once the object actually exists in S3.
 *
 * `unit_id` is optional — a photo can document the whole line (the common case)
 * or one specific unit (M03: "unit tagging optional").
 *
 * A DISPLAY COPY is generated here (s3_key_display) — a 1024px JPEG. The original
 * is evidence and is kept untouched, but it is whatever came off a phone: often
 * 4-8 MB, sometimes a HEIC no browser can render. Serving that as a thumbnail
 * would have a six-photo grid download ~40 MB to show six postage stamps.
 *
 * phash is left NULL here on purpose: the nightly dedup sweep
 * (src/lib/buyback/dedup.ts) computes it, so a slow hash never delays an upload.
 */

import { and, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireAuth } from "@/lib/auth-utils";
import { db } from "@/lib/db";
import {
  buybackBatches,
  buybackLines,
  buybackPhotos,
  buybackUnits,
} from "@/lib/db/schema";
import { BUYBACK_ADMIN_ROLES, loadOwnRequest, requireDealer } from "@/lib/buyback/auth";
import { NotFoundError, ValidationError } from "@/lib/buyback/errors";
import { BUYBACK_BUCKET } from "@/lib/buyback/storage";
import { loadDealForUpdate } from "@/lib/buyback/transition";
import { getObject, putObject } from "@/lib/storage/s3";

export const runtime = "nodejs";

const bodySchema = z.object({
  line_id: z.string().uuid(),
  unit_id: z.string().uuid().nullish(),
  /** The key returned by /photos/presign — not a client-invented path. */
  s3_key_original: z.string().min(1).max(512),
  taken_at: z.coerce.date().nullish(),
});

export const POST = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    const actor = await requireDealer();
    const request = await loadOwnRequest(actor, requestId);
    const body = bodySchema.parse(await req.json());

    // Re-verify the line is on this request. The presign route checked it too,
    // but this is a separate call and must not trust the earlier one.
    const [line] = await db
      .select({ id: buybackLines.id })
      .from(buybackLines)
      .innerJoin(buybackBatches, eq(buybackLines.batch_id, buybackBatches.id))
      .where(
        and(eq(buybackLines.id, body.line_id), eq(buybackBatches.request_id, request.id)),
      )
      .limit(1);

    if (!line) throw new NotFoundError("Battery line not found on this request.");

    if (body.unit_id) {
      const [unit] = await db
        .select({ id: buybackUnits.id })
        .from(buybackUnits)
        .where(and(eq(buybackUnits.id, body.unit_id), eq(buybackUnits.line_id, line.id)))
        .limit(1);
      if (!unit) throw new NotFoundError("Unit not found on this line.");
    }

    // Built BEFORE the transaction: resizing is CPU work and an S3 round trip, and
    // holding a row lock across it would serialise every dealer uploading a photo.
    const displayKey = await makeDisplayCopy(body.s3_key_original);

    const photo = await db.transaction(async (tx) => {
      const deal = await loadDealForUpdate(tx, request.id);
      if (!deal) throw new NotFoundError("Deal not found.");
      // Evidence is only editable while the request is the dealer's — otherwise
      // photos could be swapped after an admin has reviewed them.
      if (deal.status !== "DRAFT" && deal.status !== "INFO_REQUESTED") {
        throw new ValidationError(
          `Photos cannot be added while the request is ${deal.status}.`,
        );
      }

      const [row] = await tx
        .insert(buybackPhotos)
        .values({
          line_id: line.id,
          unit_id: body.unit_id ?? null,
          s3_key_original: body.s3_key_original,
          s3_key_display: displayKey,
          taken_at: body.taken_at ?? null,
        })
        .returning();

      return row;
    });

    // E-255 — the original went to S3 via a presigned browser PUT, so it never
    // passed through putObject() and its Drive-mirror hook. Enqueue it here,
    // now that we know it exists. Best-effort; never fails the request.
    void import("@/lib/storage/drive-mirror")
      .then((m) =>
        m.onObjectStored({ bucket: BUYBACK_BUCKET, key: body.s3_key_original, contentType: null }),
      )
      .catch(() => {});

    return successResponse(
      { photo_id: photo.id, line_id: photo.line_id, has_thumbnail: displayKey !== null },
      201,
    );
  },
);

/**
 * Make the display copy — a small, web-sized JPEG (BRD §3: `s3_key_display`).
 *
 * The original is EVIDENCE. It is whatever came off the dealer's phone: often 4–8
 * MB, occasionally a HEIC that browsers cannot even render. Serving that as the
 * thumbnail in a six-photo grid means a dealer's intake page downloads ~40 MB to
 * show six postage stamps, and an admin reviewing twenty requests downloads a
 * gigabyte. So the original is kept, untouched, and a 1024px JPEG is derived for
 * looking at.
 *
 * Best-effort by design: if sharp cannot read the file, the photo still records —
 * `s3_key_display` stays null and the media route falls back to the original. A
 * failed thumbnail must never lose the dealer their photo.
 */
async function makeDisplayCopy(originalKey: string): Promise<string | null> {
  try {
    const bytes = await getObject(BUYBACK_BUCKET, originalKey);
    if (!bytes) return null;

    const resized = await sharp(bytes)
      .rotate() // honour the EXIF orientation, or every phone photo is sideways
      .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 78 })
      .toBuffer();

    const displayKey = originalKey.replace(/\.[^./]+$/, "") + "_display.jpg";
    await putObject(BUYBACK_BUCKET, displayKey, resized, "image/jpeg");

    return displayKey;
  } catch (error) {
    console.error(
      "[buyback:photos] could not build a display copy for",
      `${originalKey}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/** DELETE ?photo_id= — the dealer removing a bad shot before submit. */
export const DELETE = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    const actor = await requireDealer();
    const request = await loadOwnRequest(actor, requestId);

    const photoId = new URL(req.url).searchParams.get("photo_id");
    if (!photoId) throw new ValidationError("photo_id is required.");

    await db.transaction(async (tx) => {
      const deal = await loadDealForUpdate(tx, request.id);
      if (!deal) throw new NotFoundError("Deal not found.");
      if (deal.status !== "DRAFT" && deal.status !== "INFO_REQUESTED") {
        throw new ValidationError(
          `Photos cannot be removed while the request is ${deal.status}.`,
        );
      }

      // Scoped delete: the photo must sit on a line of THIS request.
      const [photo] = await tx
        .select({ id: buybackPhotos.id })
        .from(buybackPhotos)
        .innerJoin(buybackLines, eq(buybackPhotos.line_id, buybackLines.id))
        .innerJoin(buybackBatches, eq(buybackLines.batch_id, buybackBatches.id))
        .where(
          and(eq(buybackPhotos.id, photoId), eq(buybackBatches.request_id, request.id)),
        )
        .limit(1);

      if (!photo) throw new NotFoundError("Photo not found.");

      await tx.delete(buybackPhotos).where(eq(buybackPhotos.id, photoId));
    });

    return successResponse({ deleted: photoId });
  },
);

/**
 * GET — every piece of evidence on a request: photos, and the provenance proofs.
 *
 * Readable by the DEALER who owns it and by iTarang staff. The admin review screen
 * needs exactly this: the photos to look at, and the ID proof to check the battery
 * was the previous owner's to sell.
 *
 * Returns ids, never S3 keys. A key is a capability — hand one to the browser and
 * it becomes a thing that can be guessed at, logged, and pasted into Slack. The
 * client asks /api/buyback/media?photo=<id>, which re-checks entitlement on every
 * request.
 */
export const GET = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;

    const user = await requireAuth();
    const isAdmin = BUYBACK_ADMIN_ROLES.includes(String(user.role).toLowerCase());

    if (!isAdmin && !user.dealer_id) throw new NotFoundError("Request not found.");

    // Scoped in the QUERY. A dealer asking for someone else's request gets 404,
    // never 403 — a 403 would confirm it exists.
    const rows = (await db.execute(sql`
      SELECT
        bl.id AS line_id,
        COALESCE(
          json_agg(
            json_build_object('id', bp.id, 'unit_id', bp.unit_id, 'has_thumb', bp.s3_key_display IS NOT NULL)
            ORDER BY bp.created_at
          ) FILTER (WHERE bp.id IS NOT NULL), '[]'
        ) AS photos,
        (
          SELECT json_build_object(
            'id', pr.id,
            'source_type', pr.source_type,
            'prev_owner_name', pr.prev_owner_name,
            'prev_owner_phone', pr.prev_owner_phone,
            'vehicle_no', pr.vehicle_no,
            'id_proof_type', pr.id_proof_type,
            'has_id_proof', pr.id_proof_s3 IS NOT NULL,
            'has_purchase_proof', pr.payment_proof_ref IS NOT NULL
          )
          FROM provenance_records pr
          WHERE pr.line_id = bl.id AND pr.scope = 'LINE'
          LIMIT 1
        ) AS provenance
      FROM buyback_requests br
      JOIN buyback_batches bb ON bb.request_id = br.id
      JOIN buyback_lines bl   ON bl.batch_id = bb.id
      LEFT JOIN buyback_photos bp ON bp.line_id = bl.id
      WHERE br.id = ${requestId}::uuid
        AND (${isAdmin} OR br.dealer_entity_id = ${user.dealer_id ?? null})
      GROUP BY bl.id
    `)) as unknown as Array<Record<string, unknown>>;

    return successResponse({ request_id: requestId, lines: rows });
  },
);
