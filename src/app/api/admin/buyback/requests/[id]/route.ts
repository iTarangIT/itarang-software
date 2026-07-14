/**
 * GET /api/admin/buyback/requests/:id
 *
 * The admin's full view: lines with photos and provenance, the itemized
 * negotiation thread, the current final offer, the margin/lock state, and the
 * complete activity log (unredacted — this is the admin side).
 *
 * Also returns `allowed_actions` straight from the state machine, so the UI's
 * ghosting is derived from the same table the server enforces. The screen cannot
 * offer a button the API would refuse, and vice versa.
 */

import { desc, eq, sql } from "drizzle-orm";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { buybackActivityLog, infoRequests } from "@/lib/db/schema";
import { requireBuybackAdmin } from "@/lib/buyback/auth";
import { NotFoundError } from "@/lib/buyback/errors";
import { formatBatteryLine } from "@/lib/buyback/format";
import { dealHeader, linesForRequest } from "@/lib/buyback/queries";
import { allowedActions, whyBlocked, REVIEW_ACTIONS } from "@/lib/buyback/state-machine";

export const runtime = "nodejs";

export const GET = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    await requireBuybackAdmin();

    const header = await dealHeader(requestId);
    if (!header) throw new NotFoundError("Request not found.");

    const lines = await linesForRequest(requestId);
    const units = await unitsFor(requestId);
    const photos = await photosFor(requestId);
    const provenance = await provenanceFor(requestId);
    const rounds = await negotiationThread(header.deal_id);
    const offers = await offerHistory(header.deal_id);

    const activity = await db
      .select()
      .from(buybackActivityLog)
      .where(eq(buybackActivityLog.request_id, requestId))
      .orderBy(desc(buybackActivityLog.created_at));

    const openInfo = await db
      .select()
      .from(infoRequests)
      .where(eq(infoRequests.request_id, requestId))
      .orderBy(desc(infoRequests.created_at));

    // The four review actions, each with the reason it is unavailable — that
    // reason IS the tooltip copy on the ghosted button (BRD M06).
    const reviewActionState = REVIEW_ACTIONS.map((action) => ({
      action,
      enabled: allowedActions(header.status, "admin").includes(action),
      blocked_reason: whyBlocked(header.status, action, "admin"),
    }));

    return successResponse({
      ...header,
      lines: lines.map((l) => ({
        ...l,
        // The shared formatter — the admin screen never re-templates a label.
        label: formatBatteryLine({
          id: l.id,
          quantity: l.quantity,
          condition: l.condition,
          voltage: l.voltage,
          ah: l.ah,
        }),
        units: units.filter((u) => u.line_id === l.id),
        photos: photos.filter((p) => p.line_id === l.id),
        provenance: provenance.filter((p) => p.line_id === l.id),
      })),
      negotiation: rounds,
      final_offers: offers,
      info_requests: openInfo,
      activity,
      allowed_actions: allowedActions(header.status, "admin"),
      review_actions: reviewActionState,
    });
  },
);

async function unitsFor(requestId: string) {
  const rows = await db.execute(sql`
    SELECT u.id, u.line_id, u.unit_no, u.status
    FROM buyback_units u
    JOIN buyback_lines bl   ON bl.id = u.line_id
    JOIN buyback_batches bb ON bb.id = bl.batch_id
    WHERE bb.request_id = ${requestId}
    ORDER BY u.unit_no
  `);
  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    line_id: String(r.line_id),
    unit_no: Number(r.unit_no),
    status: String(r.status),
  }));
}

async function photosFor(requestId: string) {
  const rows = await db.execute(sql`
    SELECT p.id, p.line_id, p.unit_id, p.s3_key_original, p.s3_key_display
    FROM buyback_photos p
    JOIN buyback_lines bl   ON bl.id = p.line_id
    JOIN buyback_batches bb ON bb.id = bl.batch_id
    WHERE bb.request_id = ${requestId}
    ORDER BY p.created_at
  `);
  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    line_id: String(r.line_id),
    unit_id: r.unit_id ? String(r.unit_id) : null,
    s3_key: String(r.s3_key_original),
  }));
}

async function provenanceFor(requestId: string) {
  const rows = await db.execute(sql`
    SELECT pr.*
    FROM provenance_records pr
    JOIN buyback_lines bl   ON bl.id = pr.line_id
    JOIN buyback_batches bb ON bb.id = bl.batch_id
    WHERE bb.request_id = ${requestId}
  `);
  return rows as unknown as Array<Record<string, unknown> & { line_id: string }>;
}

/**
 * The itemized negotiation thread. Every round carries its per-SKU lines — there
 * is no lump-sum column to fall back on, which is why the prototype's "Latest"
 * column showed "—" for itemized rounds and we don't have that bug.
 */
async function negotiationThread(dealId: string) {
  const rows = await db.execute(sql`
    SELECT
      nr.id,
      nr.round_no,
      nr.offered_by_role,
      nr.note,
      nr.created_at,
      coalesce(
        json_agg(
          json_build_object(
            'line_id', nrl.line_id,
            'price_per_unit', nrl.offered_price_per_unit,
            'quantity', bl.quantity,
            'condition', bl.condition,
            'voltage', cv.voltage,
            'ah', cv.ah
          ) ORDER BY cv.voltage
        ) FILTER (WHERE nrl.id IS NOT NULL),
        '[]'
      ) AS lines
    FROM negotiation_rounds nr
    LEFT JOIN negotiation_round_lines nrl ON nrl.round_id = nr.id
    LEFT JOIN buyback_lines bl            ON bl.id = nrl.line_id
    LEFT JOIN catalog_variants cv         ON cv.id = bl.variant_id
    WHERE nr.deal_id = ${dealId} AND nr.leg = 'DEALER'
    GROUP BY nr.id
    ORDER BY nr.round_no ASC
  `);

  return (rows as unknown as Array<Record<string, unknown>>).map((r) => {
    const lines = (r.lines as Array<Record<string, unknown>>).map((l) => {
      const f = formatBatteryLine({
        id: String(l.line_id),
        quantity: Number(l.quantity),
        condition: l.condition as "WORKING" | "DEAD",
        voltage: l.voltage as string,
        ah: l.ah as string,
      });
      return {
        line_id: String(l.line_id),
        label: `${f.specLabel} · ${f.condition}`,
        quantity: Number(l.quantity),
        price_per_unit: Number(l.price_per_unit),
      };
    });

    return {
      id: String(r.id),
      round_no: Number(r.round_no),
      offered_by_role: String(r.offered_by_role),
      note: (r.note as string) ?? null,
      created_at: r.created_at,
      lines,
      // Derived from the lines, so a per-SKU round always has a total to show.
      total: lines.reduce((sum, l) => sum + l.quantity * l.price_per_unit, 0),
    };
  });
}

async function offerHistory(dealId: string) {
  const rows = await db.execute(sql`
    SELECT
      fo.id, fo.version_no, fo.status, fo.note, fo.sent_at, fo.responded_at,
      coalesce(
        json_agg(
          json_build_object(
            'line_id', fol.line_id,
            'price_per_unit', fol.price_per_unit,
            'quantity', bl.quantity
          )
        ) FILTER (WHERE fol.id IS NOT NULL),
        '[]'
      ) AS lines
    FROM final_offers fo
    LEFT JOIN final_offer_lines fol ON fol.final_offer_id = fo.id
    LEFT JOIN buyback_lines bl      ON bl.id = fol.line_id
    WHERE fo.deal_id = ${dealId}
    GROUP BY fo.id
    ORDER BY fo.version_no DESC
  `);

  return rows as unknown as Array<Record<string, unknown>>;
}
