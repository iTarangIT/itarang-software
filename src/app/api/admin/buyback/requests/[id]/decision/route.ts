/**
 * POST /api/admin/buyback/requests/:id/decision
 *
 * The four review actions (BRD M06): accept · reject · negotiate · request_info.
 *
 * All four are gated by the state machine, which allows them ONLY in SUBMITTED
 * and UNDER_REVIEW. Outside that window the server returns 409 whatever the UI
 * did — the ghosting on screen is a courtesy, not the gate (invariant 3).
 *
 * `negotiate` is itemized per SKU. There is no lump-sum path: negotiation_rounds
 * has no amount column, so a total-only counter cannot even be written (P5).
 *
 * `request_info` targets specific UNITS, so the dealer's banner names exactly the
 * batteries in question — "Unit 2", not "your request" (P4).
 */

import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import {
  buybackBatches,
  buybackLines,
  buybackUnits,
  infoRequests,
  negotiationRoundLines,
  negotiationRounds,
} from "@/lib/db/schema";
import { loadAnyRequest, requireBuybackAdmin } from "@/lib/buyback/auth";
import { NotFoundError, ValidationError } from "@/lib/buyback/errors";
import { linesForRequest, nextRoundNo } from "@/lib/buyback/queries";
import { applyTransition, loadDealForUpdate } from "@/lib/buyback/transition";

export const runtime = "nodejs";

const lineOffer = z.object({
  line_id: z.string().uuid(),
  price_per_unit: z.number().nonnegative(),
});

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start_review") }),
  z.object({ action: z.literal("accept"), note: z.string().max(2000).nullish() }),
  z.object({ action: z.literal("reject"), reason: z.string().min(1).max(2000) }),
  z.object({
    action: z.literal("negotiate"),
    // Itemized per SKU. Never a single total.
    lines: z.array(lineOffer).min(1),
    note: z.string().max(2000).nullish(),
  }),
  z.object({
    action: z.literal("request_info"),
    target_unit_ids: z.array(z.string().uuid()).min(1),
    checklist: z.array(z.string().min(1)).min(1),
    note: z.string().max(2000).nullish(),
  }),
]);

export const POST = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    const actor = await requireBuybackAdmin();
    const request = await loadAnyRequest(requestId);
    const body = bodySchema.parse(await req.json());

    const outcome = await db.transaction(async (tx) => {
      const deal = await loadDealForUpdate(tx, request.id);
      if (!deal) throw new NotFoundError("Deal not found.");

      switch (body.action) {
        case "start_review":
        case "accept": {
          return applyTransition({
            tx,
            dealId: deal.id,
            requestId: request.id,
            currentStatus: deal.status,
            offerVersion: deal.offer_version,
            action: body.action,
            actor: { id: actor.id, role: "admin" },
            notificationPayload: { request_no: request.request_no },
          });
        }

        case "reject": {
          return applyTransition({
            tx,
            dealId: deal.id,
            requestId: request.id,
            currentStatus: deal.status,
            offerVersion: deal.offer_version,
            action: "reject",
            actor: { id: actor.id, role: "admin" },
            after: { status: "REJECTED", reason: body.reason },
            notificationPayload: {
              request_no: request.request_no,
              reason: body.reason,
            },
          });
        }

        case "negotiate": {
          await assertLinesBelong(
            tx,
            request.id,
            body.lines.map((l) => l.line_id),
          );

          const roundNo = await nextRoundNo(tx, deal.id, "DEALER");

          const [round] = await tx
            .insert(negotiationRounds)
            .values({
              deal_id: deal.id,
              leg: "DEALER",
              counterparty_id: request.dealer_entity_id,
              round_no: roundNo,
              offered_by: actor.id,
              offered_by_role: "admin",
              note: body.note ?? null,
            })
            .returning();

          await tx.insert(negotiationRoundLines).values(
            body.lines.map((l) => ({
              round_id: round.id,
              line_id: l.line_id,
              offered_price_per_unit: l.price_per_unit.toString(),
            })),
          );

          return applyTransition({
            tx,
            dealId: deal.id,
            requestId: request.id,
            currentStatus: deal.status,
            offerVersion: deal.offer_version,
            action: "negotiate",
            actor: { id: actor.id, role: "admin" },
            after: { round_no: roundNo, lines: body.lines },
            // An admin can counter more than once at the same offer version, so
            // the round number keeps each one a distinct notification event.
            eventDiscriminator: roundNo,
            notificationPayload: {
              request_no: request.request_no,
              round_no: roundNo,
              lines: body.lines,
            },
          });
        }

        case "request_info": {
          const units = await assertUnitsBelong(tx, request.id, body.target_unit_ids);

          const [info] = await tx
            .insert(infoRequests)
            .values({
              request_id: request.id,
              target_unit_ids: body.target_unit_ids,
              // The lines those units sit on, so the dealer's UI can group them.
              target_line_ids: [...new Set(units.map((u) => u.line_id))],
              checklist: body.checklist,
              note: body.note ?? null,
              raised_by: actor.id,
            })
            .returning();

          return applyTransition({
            tx,
            dealId: deal.id,
            requestId: request.id,
            currentStatus: deal.status,
            offerVersion: deal.offer_version,
            action: "request_info",
            actor: { id: actor.id, role: "admin" },
            after: {
              info_request_id: info.id,
              checklist: body.checklist,
              target_unit_ids: body.target_unit_ids,
            },
            // An admin may raise several info requests across one version.
            eventDiscriminator: info.id,
            notificationPayload: {
              request_no: request.request_no,
              checklist: body.checklist,
              unit_count: units.length,
            },
          });
        }
      }
    });

    return successResponse({
      request_id: request.id,
      request_no: request.request_no,
      from: outcome.from,
      status: outcome.to,
    });
  },
);

/** Every offered line must live on THIS request — no cross-request price writes. */
async function assertLinesBelong(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  requestId: string,
  lineIds: string[],
) {
  // inArray, not raw `= ANY(${ids}::uuid[])`: the postgres-js driver does not
  // serialize a JS array parameter into a Postgres array through a raw sql
  // template — the query dies at runtime ("Failed query") the first time an
  // admin actually negotiates. Found live; the unit variant below had it too.
  const rows = await tx
    .select({ id: buybackLines.id })
    .from(buybackLines)
    .innerJoin(buybackBatches, eq(buybackLines.batch_id, buybackBatches.id))
    .where(and(eq(buybackBatches.request_id, requestId), inArray(buybackLines.id, lineIds)));

  const found = rows.map((r) => String(r.id));

  if (found.length !== new Set(lineIds).size) {
    throw new ValidationError("One or more battery lines do not belong to this request.");
  }

  // Every counter must price EVERY line — a partial counter is a lump sum in
  // disguise, and would leave lines with no stated price (P5).
  const all = await linesForRequest(requestId, tx);
  if (found.length !== all.length) {
    throw new ValidationError(
      `A counter must price every battery line. This request has ${all.length}; you priced ${found.length}.`,
    );
  }

  return found;
}

/** Every targeted unit must live on THIS request. */
async function assertUnitsBelong(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  requestId: string,
  unitIds: string[],
): Promise<Array<{ unit_id: string; line_id: string }>> {
  // Same driver constraint as assertLinesBelong: no raw array params.
  const rows = await tx
    .select({ unit_id: buybackUnits.id, line_id: buybackUnits.line_id })
    .from(buybackUnits)
    .innerJoin(buybackLines, eq(buybackUnits.line_id, buybackLines.id))
    .innerJoin(buybackBatches, eq(buybackLines.batch_id, buybackBatches.id))
    .where(and(eq(buybackBatches.request_id, requestId), inArray(buybackUnits.id, unitIds)));

  const found = rows.map((r) => ({
    unit_id: String(r.unit_id),
    line_id: String(r.line_id),
  }));

  if (found.length !== new Set(unitIds).size) {
    throw new ValidationError("One or more units do not belong to this request.");
  }

  return found;
}
