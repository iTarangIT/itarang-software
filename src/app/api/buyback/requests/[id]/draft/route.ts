/**
 * GET /api/buyback/requests/:id/draft
 *
 * Everything the intake editor needs to REOPEN a dealer's own unsent draft.
 *
 * This route exists because, until it did, a draft was a dead end. The intake
 * POSTed a brand-new request on mount and accepted no id, and the dealer's
 * detail page is read-only for a DRAFT — no line editor, no photo box, no
 * submit. So a dealer who stopped halfway could not go back: their only move
 * was "New Buyback Request", which minted another one.
 *
 * That is not a theory about what users might do. On db-1, 24 of the first 32
 * buyback requests died in DRAFT — 14 with no battery lines at all and 10 with
 * lines but zero photos against a five-photo minimum — and only one of four
 * dealers had ever landed a request in the review queue. The admin queue took
 * the blame for "only showing one dealer" when it was faithfully showing the
 * only dealer who had managed to finish anything.
 *
 * ONE round trip, not three. The editor needs lines, photos and provenance
 * together or it renders a half-populated form; three fetches would also mean
 * three chances to leave it that way.
 *
 * DRAFT ONLY. A submitted request is under review, and its lines are what the
 * admin is pricing — reopening one in the editor would let a dealer change the
 * goods after the quote. Anything else 409s rather than 404s: the request does
 * exist and is theirs, and pretending otherwise would send them hunting.
 */

import { sql } from "drizzle-orm";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { loadOwnRequest, requireDealer } from "@/lib/buyback/auth";
import { HttpError, NotFoundError } from "@/lib/buyback/errors";
import { dealHeader, linesForRequest } from "@/lib/buyback/queries";
import { toDraftLine } from "@/lib/buyback/serialize";

export const runtime = "nodejs";

/** A saved photo, as the editor's thumbnail strip wants it. */
interface DraftPhoto {
  id: string;
  has_thumb: boolean;
}

/** The saved provenance record for a line, if the dealer got that far. */
interface DraftProvenance {
  id: string;
  source_type: string;
  prev_owner_name: string | null;
  prev_owner_phone: string | null;
  vehicle_no: string | null;
  id_proof_type: string | null;
  has_id_proof: boolean;
  has_purchase_proof: boolean;
  // E-197 — so a resumed draft does not lose the owner identity/payee the dealer
  // already typed. PAN, Aadhaar last-4 and bank details are not secrets a media
  // proxy guards; they hydrate straight back into the form.
  prev_owner_pan: string | null;
  prev_owner_aadhaar_last4: string | null;
  payee_account_number: string | null;
  payee_ifsc: string | null;
  payee_bank_name: string | null;
  payee_beneficiary_name: string | null;
}

export const GET = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;

    // Entity-scoped: loadOwnRequest 404s another dealer's request rather than
    // 403ing it, because a 403 confirms it exists.
    const actor = await requireDealer();
    const request = await loadOwnRequest(actor, requestId);

    const header = await dealHeader(request.id);
    if (!header) throw new NotFoundError("Request not found.");

    if (header.status !== "DRAFT") {
      throw new HttpError(
        `This request has already been submitted (${header.status.toLowerCase().replace(/_/g, " ")}), so it can no longer be edited.`,
        409,
      );
    }

    // Photos and provenance per line, in the shape the editor rehydrates from.
    // `has_thumb` / `has_id_proof` rather than S3 keys: a key is a capability,
    // and the client fetches the bytes back through /api/buyback/media, which
    // does its own scoping.
    const evidence = (await db.execute(sql`
      SELECT
        bl.id AS line_id,
        COALESCE(
          json_agg(
            json_build_object('id', bp.id, 'has_thumb', bp.s3_key_display IS NOT NULL)
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
            'has_purchase_proof', pr.payment_proof_ref IS NOT NULL,
            'prev_owner_pan', pr.prev_owner_pan,
            'prev_owner_aadhaar_last4', pr.prev_owner_aadhaar_last4,
            'payee_account_number', pr.payee_account_number,
            'payee_ifsc', pr.payee_ifsc,
            'payee_bank_name', pr.payee_bank_name,
            'payee_beneficiary_name', pr.payee_beneficiary_name
          )
          FROM provenance_records pr
          WHERE pr.line_id = bl.id AND pr.scope = 'LINE'
          LIMIT 1
        ) AS provenance
      FROM buyback_lines bl
      JOIN buyback_batches bb      ON bb.id = bl.batch_id
      LEFT JOIN buyback_photos bp  ON bp.line_id = bl.id
      WHERE bb.request_id = ${request.id}::uuid
      GROUP BY bl.id
    `)) as unknown as Array<{
      line_id: string;
      photos: DraftPhoto[];
      provenance: DraftProvenance | null;
    }>;

    const evidenceByLine = new Map(evidence.map((e) => [String(e.line_id), e]));

    // The batch the editor attaches new lines to, and the address already
    // chosen. Sprint 1 is one batch per request (see /api/buyback/requests).
    const [batch] = (await db.execute(sql`
      SELECT id, pickup_address_id
      FROM buyback_batches
      WHERE request_id = ${request.id}::uuid
      ORDER BY created_at
      LIMIT 1
    `)) as unknown as Array<{ id: string; pickup_address_id: string | null }>;

    const lines = (await linesForRequest(request.id)).map((line) => {
      const e = evidenceByLine.get(line.id);
      return {
        ...toDraftLine(line),
        photos: e?.photos ?? [],
        provenance: e?.provenance ?? null,
      };
    });

    return successResponse({
      request_id: request.id,
      request_no: request.request_no,
      batch_id: batch?.id ?? null,
      pickup_address_id: batch?.pickup_address_id ?? null,
      lines,
    });
  },
);
