/**
 * GET /api/buyback/media?photo=<id>&size=thumb|full
 * GET /api/buyback/media?provenance=<id>&field=id_proof|purchase_proof
 * GET /api/buyback/media?evidence=<s3_key>
 *
 * Serves buyback evidence — battery photos, ID proofs, purchase receipts, and
 * (U1) admin-captured evidence: settlement proofs, e-way bills, weighbridge
 * slips, vendor POs, dealer invoice PDFs — to the people entitled to see it,
 * and to nobody else.
 *
 * The `evidence` form takes the S3 KEY directly, unlike `photo`/`provenance`
 * which take a row id and look the key up themselves. Those documents don't
 * have their own id-bearing table to join through the way a photo or a
 * provenance record does — the key IS the identifier (see evidenceKeyFor,
 * src/lib/buyback/storage.ts) — so authorization instead reads the
 * `{requestId}` segment straight out of the key
 * (`buyback/{requestId}/evidence/…`) and checks it against a real request the
 * caller may see. The key is trusted to name the request ONLY after that
 * lookup succeeds; before that it is just an attacker-suppliable string, which
 * is why it is validated (no `..`, must start with `buyback/`) before use.
 *
 * WHY THIS EXISTS RATHER THAN /api/files/dealer-documents/<key>:
 *
 * That proxy DELIBERATELY does not authenticate the `dealer-documents` bucket —
 * see the comment in its source: dealer onboarding is a pre-login flow, so an
 * anonymous user has to be able to read back what they just uploaded. That is a
 * reasonable decision for an onboarding document the uploader already possesses.
 *
 * It is NOT a reasonable decision for buyback evidence. These objects include
 * scans of a previous owner's PAN, Aadhaar or driving licence — a third party's
 * identity documents, held by us, belonging to someone who is not even our
 * customer. Serving those from an unauthenticated URL would mean anyone holding a
 * link could read them, forever, with no session. So buyback never uses that path.
 *
 * WHO MAY SEE WHAT:
 *   · the DEALER who owns the request  — their own evidence
 *   · iTarang staff (BUYBACK_ADMIN_ROLES) — they must review it; that is the job
 *   · everybody else — 404, not 403. A 403 would confirm the object exists.
 *
 * The ownership check is a JOIN back to buyback_requests.dealer_entity_id, so it
 * cannot be satisfied by guessing a UUID.
 */

import { eq, sql } from "drizzle-orm";

import { withErrorHandler } from "@/lib/api-utils";
import { requireAuth } from "@/lib/auth-utils";
import { db } from "@/lib/db";
import { buybackRequests } from "@/lib/db/schema";
import { BUYBACK_ADMIN_ROLES } from "@/lib/buyback/auth";
import { NotFoundError, ValidationError } from "@/lib/buyback/errors";
import { BUYBACK_BUCKET } from "@/lib/buyback/storage";
import { getObject } from "@/lib/storage/s3";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Guess a content type from the key. S3 has it, but we would need a HEAD to ask. */
function contentTypeFor(key: string): string {
  const ext = key.toLowerCase().split(".").pop();
  switch (ext) {
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "heic":
      return "image/heic";
    case "pdf":
      return "application/pdf";
    default:
      return "image/jpeg";
  }
}

export const GET = withErrorHandler(async (req: Request) => {
  const user = await requireAuth();
  const url = new URL(req.url);

  const isAdmin = BUYBACK_ADMIN_ROLES.includes(String(user.role).toLowerCase());
  const dealerEntityId = user.dealer_id ?? null;

  // A non-admin with no dealer entity owns nothing and may see nothing. Bailing
  // out here rather than passing a null into the query is deliberate: `= NULL`
  // matches nothing today and is one careless COALESCE away from matching
  // everything.
  if (!isAdmin && !dealerEntityId) throw new NotFoundError("Not found.");

  const photoId = url.searchParams.get("photo");
  const provenanceId = url.searchParams.get("provenance");
  const evidenceKey = url.searchParams.get("evidence");

  let key: string | null = null;

  if (photoId) {
    const wantThumb = url.searchParams.get("size") !== "full";

    const rows = (await db.execute(sql`
      SELECT bp.s3_key_display, bp.s3_key_original
      FROM buyback_photos bp
      JOIN buyback_lines bl    ON bl.id = bp.line_id
      JOIN buyback_batches bb  ON bb.id = bl.batch_id
      JOIN buyback_requests br ON br.id = bb.request_id
      WHERE bp.id = ${photoId}::uuid
        AND (${isAdmin} OR br.dealer_entity_id = ${dealerEntityId})
      LIMIT 1
    `)) as unknown as Array<{ s3_key_display: string | null; s3_key_original: string }>;

    const photo = rows[0];
    if (!photo) throw new NotFoundError("Not found.");

    // The display copy is a resized JPEG made at upload; fall back to the original
    // if it was never generated (an older row, or sharp failed on that file).
    key = wantThumb ? (photo.s3_key_display ?? photo.s3_key_original) : photo.s3_key_original;
  } else if (provenanceId) {
    const field = url.searchParams.get("field");
    if (field !== "id_proof" && field !== "purchase_proof") {
      throw new ValidationError("field must be id_proof or purchase_proof.");
    }

    const rows = (await db.execute(sql`
      SELECT pr.id_proof_s3, pr.payment_proof_ref
      FROM provenance_records pr
      JOIN buyback_lines bl    ON bl.id = pr.line_id
      JOIN buyback_batches bb  ON bb.id = bl.batch_id
      JOIN buyback_requests br ON br.id = bb.request_id
      WHERE pr.id = ${provenanceId}::uuid
        AND (${isAdmin} OR br.dealer_entity_id = ${dealerEntityId})
      LIMIT 1
    `)) as unknown as Array<{ id_proof_s3: string | null; payment_proof_ref: string | null }>;

    const record = rows[0];
    if (!record) throw new NotFoundError("Not found.");

    key = field === "id_proof" ? record.id_proof_s3 : record.payment_proof_ref;
  } else if (evidenceKey) {
    // U1 admin-captured evidence: buyback/{requestId}/evidence/{kind}-{uuid}.ext
    // (see evidenceKeyFor, src/lib/buyback/storage.ts). No `..` and it must sit
    // under the buyback/ prefix — otherwise the "requestId" segment below could
    // be pointed anywhere, including outside this bucket's buyback/ tree.
    if (!evidenceKey.startsWith("buyback/") || evidenceKey.includes("..")) {
      throw new NotFoundError("Not found.");
    }

    const evidenceRequestId = evidenceKey.split("/")[1];
    // Malformed, not merely absent: a non-UUID segment cannot match any real
    // request, and letting it reach the query would send Postgres a value it
    // cannot cast to uuid — an unhandled DB error (500), not the clean 404
    // every other bad `evidence` value gets here.
    if (!evidenceRequestId || !UUID_RE.test(evidenceRequestId)) {
      throw new NotFoundError("Not found.");
    }

    const [owner] = await db
      .select({ dealer_entity_id: buybackRequests.dealer_entity_id })
      .from(buybackRequests)
      .where(eq(buybackRequests.id, evidenceRequestId))
      .limit(1);

    // Same rule as photo/provenance above: admin, or the request's own dealer.
    // A non-existent request and someone else's request are indistinguishable.
    if (!owner || (!isAdmin && owner.dealer_entity_id !== dealerEntityId)) {
      throw new NotFoundError("Not found.");
    }

    key = evidenceKey;
  } else {
    throw new ValidationError("Pass ?photo=, ?provenance= or ?evidence=.");
  }

  if (!key) throw new NotFoundError("Not found.");

  const bytes = await getObject(BUYBACK_BUCKET, key);
  if (!bytes) throw new NotFoundError("Not found.");

  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": contentTypeFor(key),
      "Content-Length": String(bytes.length),
      // PRIVATE. These are identity documents; they must not sit in a shared CDN
      // or a proxy cache. `private` allows the user's own browser to cache them
      // (so a lightbox does not re-download on every open) and nothing else to.
      "Cache-Control": "private, max-age=3600",
      "Content-Disposition": "inline",
      // The bytes are user-supplied. Without this a crafted "image" could be
      // sniffed as HTML and run as script on our origin.
      "X-Content-Type-Options": "nosniff",
    },
  });
});
