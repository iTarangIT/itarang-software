/**
 * GET  /api/admin/buyback/agreements — who has signed, who hasn't
 * POST /api/admin/buyback/agreements — send an agreement for eSign (M17/M18/M19)
 *
 * U12 — THE WHOLE POINT: an existing dealer does NOT re-onboard. The CRM already
 * holds their identity, KYC and bank details in `accounts`. Buyback does not take
 * a copy. An existing dealer of the same firm confirms their firm registration
 * number and signs the buyback agreement, and that is the entire flow — one
 * dealer, one identity, one place for it to be wrong.
 *
 * So this route takes an `entity_id` that ALREADY EXISTS. There is no buyback
 * onboarding wizard, and adding one would create a second KYC store to drift.
 *
 * Sending an agreement unlocks nothing. Only signing does — the sync job flips
 * business_entity_roles.status to ACTIVE, and it is that flag (not the agreement
 * row) that lets an entity trade. A vendor whose role is not ACTIVE is invisible
 * to the routing query, which is how M18's AC holds without the routing screen
 * having to check anything.
 */

import { sql } from "drizzle-orm";
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { loadParty, sendAgreement, syncAgreements } from "@/lib/buyback/agreement";
import { requireBuybackAdmin } from "@/lib/buyback/auth";
import { NotFoundError, ValidationError } from "@/lib/buyback/errors";

export const runtime = "nodejs";
export const maxDuration = 60;

export const GET = withErrorHandler(async () => {
  await requireBuybackAdmin();

  const rows = await db.execute(sql`
    SELECT
      a.id, a.entity_id, a.role, a.status, a.firm_registration_no,
      a.sent_at, a.signed_at, a.declined_reason,
      acc.business_entity_name AS name,
      acc.contact_email        AS email,
      ber.status               AS role_status
    FROM agreements a
    JOIN accounts acc ON acc.id = a.entity_id
    LEFT JOIN business_entity_roles ber
      ON ber.entity_id = a.entity_id AND ber.role = a.role
    ORDER BY a.created_at DESC
  `);

  // Entities that hold a buyback role but have NO agreement at all. These are the
  // ones an admin needs to see: Sprint 2A created vendors with an ACTIVE role and
  // no signature, which was fine then and is not fine now.
  const unsigned = await db.execute(sql`
    SELECT ber.entity_id, ber.role, ber.status, acc.business_entity_name AS name
    FROM business_entity_roles ber
    JOIN accounts acc ON acc.id = ber.entity_id
    WHERE NOT EXISTS (
      SELECT 1 FROM agreements a
      WHERE a.entity_id = ber.entity_id AND a.role = ber.role
        AND a.status IN ('DRAFT', 'SENT', 'SIGNED')
    )
    ORDER BY acc.business_entity_name
  `);

  return successResponse({
    agreements: rows,
    without_agreement: unsigned,
  });
});

const bodySchema = z.object({
  entity_id: z.string().min(1),
  role: z.enum(["BATTERY_DEALER", "SCRAP_SELLER", "SCRAP_VENDOR"]),
  /** U12 — an existing firm confirms this instead of redoing KYC. */
  firm_registration_no: z.string().max(120).optional(),
});

export const POST = withErrorHandler(async (req: Request) => {
  const actor = await requireBuybackAdmin();
  const body = bodySchema.parse(await req.json());

  const party = await loadParty(body.entity_id);
  if (!party) throw new NotFoundError("That entity does not exist.");

  // A live agreement already out (or signed) for this role — the partial unique
  // index would refuse the insert anyway; this gives a sentence instead of a
  // constraint violation.
  const existing = await db.execute(sql`
    SELECT status FROM agreements
    WHERE entity_id = ${body.entity_id} AND role = ${body.role}::buyback_entity_role
      AND status IN ('DRAFT', 'SENT', 'SIGNED')
    LIMIT 1
  `);
  const live = (existing as unknown as Array<{ status: string }>)[0];
  if (live) {
    throw new ValidationError(
      live.status === "SIGNED"
        ? `${party.name} has already signed as ${body.role.replace(/_/g, " ").toLowerCase()}.`
        : `An agreement is already out for signature with ${party.name}.`,
    );
  }

  const result = await db.transaction((tx) =>
    sendAgreement(tx, party, body.role, {
      firmRegistrationNo: body.firm_registration_no ?? null,
      actorId: actor.id,
    }),
  );

  return successResponse(
    {
      agreement_id: result.agreementId,
      digio_doc_id: result.digioDocId,
      sent: result.digioDocId !== null,
      // Be explicit. An admin who sends an agreement and then wonders why the
      // vendor still cannot be routed to needs to know that signing is the gate.
      note:
        result.digioDocId === null
          ? "The document was generated but Digio could not be reached. It is saved as a draft — retry to send it."
          : `Sent to ${party.email ?? party.phone}. ${party.name} cannot trade until they sign.`,
    },
    201,
  );
});

/**
 * PATCH — force a status sync now, rather than waiting for the ticker.
 *
 * Useful the moment after someone says "I've signed it" and the admin is staring
 * at a screen that still says SENT.
 */
export const PATCH = withErrorHandler(async () => {
  await requireBuybackAdmin();
  const result = await syncAgreements();
  return successResponse(result);
});
