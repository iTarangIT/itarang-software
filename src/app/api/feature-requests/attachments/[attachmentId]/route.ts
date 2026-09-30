/**
 * GET /api/feature-requests/attachments/{id} — download one attachment.
 *
 * Not the shared /api/files proxy: that one only checks for a session, and
 * these files are for feature-request members only. Served as a download
 * (only raster images may render inline, for thumbnails) so an uploaded
 * HTML/SVG can never run in our origin.
 */
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { featureRequestAttachments } from "@/lib/db/schema";
import { HttpError, requireSeat } from "@/lib/feature-requests/server";
import { readBucketObject } from "@/lib/storage/readStoredDocument";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ attachmentId: string }> }) => {
    const user = await requireSeat();
    const { attachmentId } = await ctx.params;
    if (!/^[0-9a-f-]{36}$/i.test(attachmentId)) throw new HttpError("Not found", 404);

    const [att] = await db
      .select()
      .from(featureRequestAttachments)
      .where(eq(featureRequestAttachments.id, attachmentId))
      .limit(1);
    // An unclaimed upload is visible only to the person who uploaded it.
    if (!att || (!att.feature_request_id && att.uploaded_by !== user.id)) {
      throw new HttpError("Not found", 404);
    }

    const buf = await readBucketObject(att.storage_bucket, att.storage_key);
    if (!buf) throw new HttpError("This file is no longer stored.", 404);

    // Raster images may render inline (thumbnails); everything else downloads.
    const inline =
      new URL(req.url).searchParams.get("inline") === "1" &&
      /^image\/(png|jpe?g|gif|webp)$/i.test(att.mime_type ?? "");
    const ascii = att.file_name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": att.mime_type || "application/octet-stream",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(att.file_name)}`,
        "Content-Length": String(buf.byteLength),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=3600",
      },
    });
  },
);
