/**
 * POST /api/buyback/requests/:id/provenance
 *
 * Where a battery came from (BRD M04/P2). Two sources:
 *
 *   PREV_OWNER_DOCS — a single previous owner (usually the driver): name, phone,
 *                     vehicle/RC, ID proof, optional purchase proof.
 *   DEALER_STOCK    — the dealer's own stock; the ID on file already covers it,
 *                     so no owner fields are required or stored.
 *
 * Bulk apply (`scope: "LINE"`) is the default and covers every unit on the line —
 * a dealer buying a same-source lot enters the owner once. A per-unit override is
 * a second record with `scope: "UNIT"`, which wins for that unit.
 */

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import {
  buybackBatches,
  buybackLines,
  buybackUnits,
  provenanceRecords,
} from "@/lib/db/schema";
import { loadOwnRequest, requireDealer } from "@/lib/buyback/auth";
import { NotFoundError, ValidationError } from "@/lib/buyback/errors";
import { loadDealForUpdate } from "@/lib/buyback/transition";

export const runtime = "nodejs";

const ownerFields = z.object({
  prev_owner_name: z.string().min(1).max(200),
  prev_owner_phone: z.string().min(6).max(20),
  vehicle_no: z.string().max(32).nullish(),
  rc_number: z.string().max(64).nullish(),
  id_proof_type: z.enum(["PAN", "DL", "AADHAAR", "OTHER"]).nullish(),
  id_proof_s3: z.string().max(512).nullish(),
  payment_proof_ref: z.string().max(512).nullish(),
  // --- E-197: who the owner is, and how to pay them directly ---------------
  // PAN in full — a tax identity, not a credential.
  prev_owner_pan: z.string().trim().max(10).nullish(),
  // LAST FOUR ONLY. The full number never reaches this route: the intake sends
  // four digits, and the DB CHECK (^[0-9]{4}$) makes anything longer unstorable.
  prev_owner_aadhaar_last4: z
    .string()
    .regex(/^[0-9]{4}$/, "Enter the last 4 digits of the Aadhaar.")
    .nullish(),
  // Bank details in full — you cannot pay a masked account. Collected only
  // because settlement_transactions.payee_provenance_id can now pay this person.
  payee_account_number: z.string().trim().max(34).nullish(),
  payee_ifsc: z.string().trim().max(11).nullish(),
  payee_bank_name: z.string().trim().max(120).nullish(),
  payee_beneficiary_name: z.string().trim().max(200).nullish(),
});

const bodySchema = z.discriminatedUnion("source_type", [
  z.object({
    source_type: z.literal("PREV_OWNER_DOCS"),
    scope: z.enum(["LINE", "UNIT"]),
    line_id: z.string().uuid(),
    /** Required when scope is UNIT; ignored otherwise. */
    unit_id: z.string().uuid().nullish(),
    ...ownerFields.shape,
  }),
  z.object({
    source_type: z.literal("DEALER_STOCK"),
    scope: z.enum(["LINE", "UNIT"]),
    line_id: z.string().uuid(),
    unit_id: z.string().uuid().nullish(),
    // No owner fields — "uses ID on file, no re-entry needed".
  }),
]);

export const POST = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    const actor = await requireDealer();
    const request = await loadOwnRequest(actor, requestId);
    const body = bodySchema.parse(await req.json());

    if (body.scope === "UNIT" && !body.unit_id) {
      throw new ValidationError("A unit-scoped provenance record needs a unit_id.");
    }

    // The line must belong to THIS request — otherwise a dealer could attach
    // provenance to a line on someone else's request they happened to guess.
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

    const record = await db.transaction(async (tx) => {
      const deal = await loadDealForUpdate(tx, request.id);
      if (!deal) throw new NotFoundError("Deal not found.");
      if (deal.status !== "DRAFT" && deal.status !== "INFO_REQUESTED") {
        throw new ValidationError(
          `Provenance cannot be edited while the request is ${deal.status}.`,
        );
      }

      // Re-entering provenance replaces the previous record at the same scope,
      // rather than stacking duplicates the submit gate would have to dedupe.
      if (body.scope === "LINE") {
        await tx
          .delete(provenanceRecords)
          .where(
            and(
              eq(provenanceRecords.line_id, line.id),
              eq(provenanceRecords.scope, "LINE"),
            ),
          );
      } else {
        await tx
          .delete(provenanceRecords)
          .where(
            and(
              eq(provenanceRecords.unit_id, body.unit_id!),
              eq(provenanceRecords.scope, "UNIT"),
            ),
          );
      }

      const owner =
        body.source_type === "PREV_OWNER_DOCS"
          ? {
              prev_owner_name: body.prev_owner_name,
              prev_owner_phone: body.prev_owner_phone,
              vehicle_no: body.vehicle_no ?? null,
              rc_number: body.rc_number ?? null,
              id_proof_type: body.id_proof_type ?? null,
              id_proof_s3: body.id_proof_s3 ?? null,
              payment_proof_ref: body.payment_proof_ref ?? null,
              // E-197. Aadhaar last-4 goes in as given; the assumption-free
              // Decentro reference is a follow-up (see the intake note), so
              // prev_owner_aadhaar_ref/verified_at stay null here.
              prev_owner_pan: body.prev_owner_pan?.toUpperCase() || null,
              prev_owner_aadhaar_last4: body.prev_owner_aadhaar_last4 || null,
              payee_account_number: body.payee_account_number || null,
              payee_ifsc: body.payee_ifsc?.toUpperCase() || null,
              payee_bank_name: body.payee_bank_name || null,
              payee_beneficiary_name: body.payee_beneficiary_name || null,
            }
          : {};

      const [row] = await tx
        .insert(provenanceRecords)
        .values({
          scope: body.scope,
          // A LINE record carries no unit_id — the CHECK constraint enforces it.
          line_id: line.id,
          unit_id: body.scope === "UNIT" ? body.unit_id! : null,
          source_type: body.source_type,
          ...owner,
        })
        .returning();

      return row;
    });

    return successResponse({ provenance_id: record.id, scope: record.scope }, 201);
  },
);
