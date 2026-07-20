/**
 * GET /api/vendor/threads/:id/photo?photo=<photoId>&size=thumb|full
 *
 * Streams ONE battery photo for a lot routed to the CALLING vendor.
 *
 * A DEDICATED vendor route, not a branch on /api/buyback/media — that route is
 * dealer/admin-scoped and bails on `!isAdmin && !dealerEntityId`, so a vendor
 * cannot reach it, and widening its guard to admit vendors is the exact
 * one-COALESCE-from-matching-everything change its own comment warns against.
 * Same shape as the proforma route beside it.
 *
 * SCOPED TWICE. loadOwnThread proves the thread is theirs (404 on a miss, never
 * 403). Then the key lookup requires the photo's line to belong to THIS thread
 * (via vendor_thread_lines), so a vendor can only ever pull photos for the exact
 * lot they were quoted — never another vendor's, never an arbitrary photo id.
 *
 * Serves the EXIF-stripped display copy by default (COALESCE display→original,
 * the same copy the quotation email already attaches). `?size=full` serves the
 * original. No S3 key is ever handed to the client; the bytes are streamed.
 */

import { sql } from "drizzle-orm";

import { withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { requireVendor } from "@/lib/buyback/auth";
import { NotFoundError } from "@/lib/buyback/errors";
import { BUYBACK_BUCKET } from "@/lib/buyback/storage";
import { loadOwnThread } from "@/lib/buyback/vendors";
import { getObject } from "@/lib/storage/s3";

export const runtime = "nodejs";

function mimeForKey(key: string): string {
  const ext = key.toLowerCase().split(".").pop() ?? "";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "heic") return "image/heic";
  return "image/jpeg"; // the display copy is always JPEG (sharp .jpeg())
}

export const GET = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: threadId } = await ctx.params;
    const actor = await requireVendor();

    // Ownership — 404, not 403 (a vendor must not be able to probe thread ids).
    const own = await loadOwnThread(actor.entityId!, threadId);
    if (!own) throw new NotFoundError("Not found.");

    const url = new URL(req.url);
    const photoId = url.searchParams.get("photo");
    if (!photoId) throw new NotFoundError("Not found.");
    const full = url.searchParams.get("size") === "full";

    // The photo must belong to a line in THIS thread. That join is the second
    // scope: a valid photo id from another lot resolves to zero rows here.
    const rows = await db.execute(sql`
      SELECT bp.s3_key_display, bp.s3_key_original
      FROM buyback_photos bp
      JOIN vendor_thread_lines vtl ON vtl.line_id = bp.line_id
      WHERE bp.id = ${photoId}::uuid AND vtl.thread_id = ${threadId}::uuid
      LIMIT 1
    `);
    const row = (rows as unknown as Array<Record<string, unknown>>)[0];
    if (!row) throw new NotFoundError("Not found.");

    const display = (row.s3_key_display as string) ?? null;
    const original = (row.s3_key_original as string) ?? null;
    // Default to the EXIF-stripped display copy; only ?size=full serves the
    // original (which retains capture EXIF, same trade-off as the email path).
    const key = full ? original ?? display : display ?? original;
    if (!key) throw new NotFoundError("Not found.");

    const bytes = await getObject(BUYBACK_BUCKET, key);
    if (!bytes) throw new NotFoundError("Not found.");

    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": mimeForKey(key),
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  },
);
