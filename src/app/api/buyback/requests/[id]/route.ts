/**
 * GET /api/buyback/requests/:id — the dealer's view of their own request.
 *
 * Runs the payload through toDealerDeal(), so margin and vendor fields are
 * structurally absent (BRD M23 AC: "keys absent, not nulled"). Another dealer's
 * request 404s — it is not distinguishable from one that does not exist (M01 AC).
 *
 * Also returns:
 *  · the live submit-gate result, so the intake page's Submit button and the
 *    server agree by construction (they call the same function);
 *  · the open info request, so the dealer's banner can name EXACTLY the units
 *    the admin asked about (BRD P4);
 *  · the current final offer, itemized, for the accept/decline panel.
 */

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import {
  buybackActivityLog,
  buybackBatches,
  buybackDeals,
  buybackPickupAddresses,
  finalOffers,
  infoRequests,
} from "@/lib/db/schema";
import { loadOwnRequest, requireDealer } from "@/lib/buyback/auth";
import { NotFoundError, TransitionError } from "@/lib/buyback/errors";
import { formatBatteryLine } from "@/lib/buyback/format";
import { dealHeader, linesForRequest, toGateLines } from "@/lib/buyback/queries";
import { toDealerDeal, visibleActivityForDealer } from "@/lib/buyback/serialize";
import { checkSubmitReadiness } from "@/lib/buyback/submit-gate";

export const runtime = "nodejs";

export const GET = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    const actor = await requireDealer();
    await loadOwnRequest(actor, requestId); // 404s if it isn't theirs

    const header = await dealHeader(requestId);
    if (!header) throw new NotFoundError("Request not found.");

    const lines = await linesForRequest(requestId);

    // The redaction boundary. Everything below this line is dealer-safe.
    const dealerView = toDealerDeal({ ...header, lines });

    const gate = checkSubmitReadiness(toGateLines(lines));

    // The open info request, resolved to human unit labels.
    const [openInfo] = await db
      .select()
      .from(infoRequests)
      .where(and(eq(infoRequests.request_id, requestId), isNull(infoRequests.resolved_at)))
      .orderBy(desc(infoRequests.created_at))
      .limit(1);

    const infoBanner = openInfo ? await describeInfoRequest(openInfo) : null;

    // The current final offer, itemized (U5 — one binary answer for the set).
    const offer = await currentFinalOffer(header.deal_id, header.offer_version);

    const activity = await db
      .select({
        action: buybackActivityLog.action,
        role: buybackActivityLog.role,
        created_at: buybackActivityLog.created_at,
        // Selected ONLY so the vendor-leg settlement filter can see the leg —
        // stripped below. `after` can carry realised_margin on settle events
        // and must never reach a dealer payload.
        after: buybackActivityLog.after,
      })
      .from(buybackActivityLog)
      .where(eq(buybackActivityLog.request_id, requestId))
      .orderBy(desc(buybackActivityLog.created_at));

    return successResponse({
      ...dealerView,
      submit_gate: gate,
      info_request: infoBanner,
      final_offer: offer,
      // Margin/vendor events are dropped server-side, not hidden in the client.
      activity: visibleActivityForDealer(activity).map(
        ({ action, role, created_at }) => ({ action, role, created_at }),
      ),
    });
  },
);

const patchSchema = z.object({
  pickup_address_id: z.string().uuid().nullable(),
});

/**
 * PATCH /api/buyback/requests/:id — set the pickup address on a draft.
 *
 * The intake page's address cards used to be cosmetic: the selection lived only
 * in React state and the batch kept pickup_address_id NULL forever. Sprint 1 is
 * order-level pickup (one batch per request), so this writes the request's
 * batch. The address must be the dealer's own — an attacker-chosen id would let
 * one dealer route a pickup to another's premises.
 */
export const PATCH = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    const actor = await requireDealer();
    const request = await loadOwnRequest(actor, requestId);
    const body = patchSchema.parse(await req.json());

    const [deal] = await db
      .select({ status: buybackDeals.status })
      .from(buybackDeals)
      .where(eq(buybackDeals.request_id, request.id))
      .limit(1);
    if (!deal) throw new NotFoundError("Deal not found.");
    if (deal.status !== "DRAFT") {
      throw new TransitionError(
        "The pickup address can only be changed while the request is a draft.",
      );
    }

    if (body.pickup_address_id) {
      const [addr] = await db
        .select({ id: buybackPickupAddresses.id })
        .from(buybackPickupAddresses)
        .where(
          and(
            eq(buybackPickupAddresses.id, body.pickup_address_id),
            eq(buybackPickupAddresses.entity_id, actor.entityId!),
            eq(buybackPickupAddresses.active, true),
          ),
        )
        .limit(1);
      if (!addr) throw new NotFoundError("Pickup address not found.");
    }

    await db
      .update(buybackBatches)
      .set({ pickup_address_id: body.pickup_address_id })
      .where(eq(buybackBatches.request_id, request.id));

    return successResponse({ request_id: request.id, pickup_address_id: body.pickup_address_id });
  },
);

/**
 * Turns the stored line/unit id arrays into the labels the banner shows:
 * "For these batteries: 60V 120Ah · Working — Unit 2".
 */
async function describeInfoRequest(info: typeof infoRequests.$inferSelect) {
  const lineIds = info.target_line_ids ?? [];
  const unitIds = info.target_unit_ids ?? [];

  if (unitIds.length === 0) {
    return {
      id: info.id,
      note: info.note,
      checklist: info.checklist as string[],
      target_line_ids: lineIds,
      target_units: [],
      created_at: info.created_at,
    };
  }

  // IN with one parameter per id, not `= ANY(${unitIds}::uuid[])` — the
  // postgres-js driver does not serialize a JS array through a raw sql
  // template into a Postgres array (same failure as the decision route's
  // assertLinesBelong, found live).
  const rows = await db.execute(sql`
    SELECT
      u.id           AS unit_id,
      u.unit_no,
      bl.id          AS line_id,
      bl.quantity,
      bl.condition,
      cv.voltage,
      cv.ah
    FROM buyback_units u
    JOIN buyback_lines bl     ON bl.id = u.line_id
    JOIN catalog_variants cv  ON cv.id = bl.variant_id
    WHERE u.id IN (${sql.join(unitIds.map((id) => sql`${id}::uuid`), sql`, `)})
    ORDER BY cv.voltage, u.unit_no
  `);

  const units = (rows as unknown as Array<Record<string, unknown>>).map((r) => {
    const label = formatBatteryLine({
      id: String(r.line_id),
      quantity: Number(r.quantity),
      condition: r.condition as "WORKING" | "DEAD",
      voltage: r.voltage as string,
      ah: r.ah as string,
    });
    return {
      unit_id: String(r.unit_id),
      line_id: String(r.line_id),
      // "60V 120Ah · Working — Unit 2" — names the exact battery, not the request.
      label: `${label.specLabel} · ${label.condition} — Unit ${r.unit_no}`,
    };
  });

  return {
    id: info.id,
    note: info.note,
    checklist: info.checklist as string[],
    target_line_ids: lineIds,
    target_units: units,
    created_at: info.created_at,
  };
}

async function currentFinalOffer(dealId: string, offerVersion: number) {
  const [offer] = await db
    .select()
    .from(finalOffers)
    .where(and(eq(finalOffers.deal_id, dealId), eq(finalOffers.version_no, offerVersion)))
    .limit(1);

  if (!offer) return null;

  const rows = await db.execute(sql`
    SELECT
      fol.line_id,
      fol.price_per_unit,
      bl.quantity,
      bl.condition,
      cv.voltage,
      cv.ah
    FROM final_offer_lines fol
    JOIN buyback_lines bl    ON bl.id = fol.line_id
    JOIN catalog_variants cv ON cv.id = bl.variant_id
    WHERE fol.final_offer_id = ${offer.id}
    ORDER BY cv.voltage
  `);

  const lines = (rows as unknown as Array<Record<string, unknown>>).map((r) => {
    const f = formatBatteryLine({
      id: String(r.line_id),
      quantity: Number(r.quantity),
      condition: r.condition as "WORKING" | "DEAD",
      voltage: r.voltage as string,
      ah: r.ah as string,
    });
    return {
      line_id: String(r.line_id),
      label: `${f.specLabel} · ${f.condition}`,
      quantity: Number(r.quantity),
      price_per_unit: Number(r.price_per_unit),
      line_total: Number(r.quantity) * Number(r.price_per_unit),
    };
  });

  return {
    id: offer.id,
    version_no: offer.version_no,
    status: offer.status,
    note: offer.note,
    sent_at: offer.sent_at,
    lines,
    total: lines.reduce((sum, l) => sum + l.line_total, 0),
  };
}
