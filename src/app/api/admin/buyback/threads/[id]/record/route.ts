/**
 * POST /api/admin/buyback/threads/:id/record   (BRD M10)
 *
 * Records what a vendor said, PER SKU. Three kinds:
 *
 *   counter — they came back with per-line prices  → VENDOR_NEGOTIATING
 *   agree   — they accepted (at our ask, or at their own counter) → VENDOR_AGREED
 *   reject  — they are out                          → thread LOST, deal unmoved
 *
 * There is no vendor login in v1 (BRD M24): an admin types in what arrived by
 * email. That is why every one of these is an admin action.
 *
 * TWO THINGS THE DESIGN PROTOTYPE GETS WRONG AND THIS DOES NOT:
 *
 *  1. Its `venRespond` accepts per-line amounts and then AVERAGES them into one
 *     number (`perLine.reduce((a,l)=>a+l.amt,0)/perLine.length`). That destroys
 *     the itemization the whole system is built on (P5) — and an average is not
 *     even a price anyone agreed to. Here the per-line prices are stored as
 *     given, on vendor_thread_lines.
 *
 *  2. It lets an admin agree below the floor after showing a red banner. Here a
 *     below-floor agreement is REFUSED (422). The way forward is to reopen the
 *     dealer leg — which is what BRD §2's "below floor → DEALER_REOPENED" means.
 *
 * "First AGREED wins, others auto-LOST" is atomic, and not because this code is
 * careful: `vendor_threads_one_agreed_per_deal` is a partial UNIQUE index, so if
 * two admins agree with two different vendors at the same instant, the second
 * transaction fails at the database. A deal cannot end up owing its batteries to
 * two buyers.
 */

import { and, eq, ne, notInArray, sql } from "drizzle-orm";
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import {
  negotiationRoundLines,
  negotiationRounds,
  vendorThreadLines,
  vendorThreads,
} from "@/lib/db/schema";
import { requireBuybackAdmin } from "@/lib/buyback/auth";
import { NotFoundError, ValidationError } from "@/lib/buyback/errors";
import { assertClearsFloor } from "@/lib/buyback/floor";
import { nextRoundNo } from "@/lib/buyback/queries";
import { applyTransition, loadDealForUpdate, recordActivity } from "@/lib/buyback/transition";
import { threadsForDeal } from "@/lib/buyback/vendors";

export const runtime = "nodejs";

const bodySchema = z.object({
  kind: z.enum(["counter", "agree", "reject"]),
  /** Per-SKU, always. Required for a counter; optional for an agree (defaults to the standing prices). */
  lines: z
    .array(
      z.object({
        line_id: z.string().uuid(),
        price: z.number().positive(),
      }),
    )
    .optional(),
  note: z.string().max(2000).optional(),
});

/** The thread, its deal, and the request it belongs to. */
async function loadThread(threadId: string) {
  const rows = await db.execute(sql`
    SELECT
      vt.id, vt.deal_id, vt.vendor_id, vt.status, vt.quotation_no,
      bd.request_id, bd.floor_total,
      br.request_no,
      a.business_entity_name AS vendor_name,
      a.contact_email        AS vendor_email
    FROM vendor_threads vt
    JOIN buyback_deals bd    ON bd.id = vt.deal_id
    JOIN buyback_requests br ON br.id = bd.request_id
    JOIN scrap_vendors sv    ON sv.id = vt.vendor_id
    JOIN accounts a          ON a.id = sv.entity_id
    WHERE vt.id = ${threadId}
    LIMIT 1
  `);

  const row = (rows as unknown as Array<Record<string, unknown>>)[0];
  if (!row) throw new NotFoundError("Vendor thread not found.");

  return {
    id: String(row.id),
    dealId: String(row.deal_id),
    vendorId: String(row.vendor_id),
    status: String(row.status) as "SENT" | "COUNTERED" | "AGREED" | "LOST",
    quotationNo: (row.quotation_no as string) ?? null,
    requestId: String(row.request_id),
    requestNo: String(row.request_no),
    floorTotal: row.floor_total as string | null,
    vendorName: String(row.vendor_name),
    vendorEmail: (row.vendor_email as string) ?? null,
  };
}

export const POST = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: threadId } = await ctx.params;
    const actor = await requireBuybackAdmin();
    const body = bodySchema.parse(await req.json());

    const thread = await loadThread(threadId);

    if (thread.status === "AGREED" || thread.status === "LOST") {
      throw new ValidationError(
        `This thread is already ${thread.status}. Reopen the deal to re-engage this vendor.`,
      );
    }

    if (body.kind === "counter" && (!body.lines || body.lines.length === 0)) {
      // The one thing a vendor may not do is name a single number for the lot.
      throw new ValidationError(
        "A vendor counter must be itemized per battery variant — a lump-sum figure for the whole lot cannot be recorded.",
      );
    }

    const outcome = await db.transaction(async (tx) => {
      const deal = await loadDealForUpdate(tx, thread.requestId);
      if (!deal) throw new NotFoundError("Deal not found.");

      // ---------------------------------------------------------------- REJECT
      // A vendor dropping out changes the THREAD, not the deal — the other
      // vendors are still live. So no transition: an audit row, and that is all.
      if (body.kind === "reject") {
        await tx
          .update(vendorThreads)
          .set({
            status: "LOST",
            close_reason: body.note ?? "vendor declined",
            closed_at: new Date(),
            responded_at: new Date(),
            updated_at: new Date(),
          })
          .where(eq(vendorThreads.id, thread.id));

        await recordActivity({
          tx,
          requestId: thread.requestId,
          dealId: deal.id,
          actor: { id: actor.id, role: "admin" },
          action: "vendor_declined",
          before: { thread: thread.id, status: thread.status },
          after: { thread: thread.id, status: "LOST", vendor: thread.vendorName },
        });

        return { status: deal.status, thread_status: "LOST" as const };
      }

      // Write the per-SKU prices onto the thread's lines.
      const existing = await tx
        .select({ line_id: vendorThreadLines.line_id })
        .from(vendorThreadLines)
        .where(eq(vendorThreadLines.thread_id, thread.id));

      const known = new Set(existing.map((l) => l.line_id));

      for (const entry of body.lines ?? []) {
        if (!known.has(entry.line_id)) {
          throw new ValidationError("A priced line does not belong to this vendor's quotation.");
        }
      }

      // --------------------------------------------------------------- COUNTER
      if (body.kind === "counter") {
        for (const entry of body.lines!) {
          await tx
            .update(vendorThreadLines)
            .set({ counter_price: entry.price.toString(), updated_at: new Date() })
            .where(
              and(
                eq(vendorThreadLines.thread_id, thread.id),
                eq(vendorThreadLines.line_id, entry.line_id),
              ),
            );
        }

        await tx
          .update(vendorThreads)
          .set({ status: "COUNTERED", responded_at: new Date(), updated_at: new Date() })
          .where(eq(vendorThreads.id, thread.id));

        // The round, on the VENDOR leg — same tables as the dealer leg, itemized
        // the same way. `negotiation_rounds` has no amount column; the amounts
        // live on its *_lines child, so a lump sum is unrepresentable here too.
        const roundNo = await nextRoundNo(tx, deal.id, "VENDOR");

        const [round] = await tx
          .insert(negotiationRounds)
          .values({
            deal_id: deal.id,
            leg: "VENDOR",
            counterparty_id: thread.vendorId,
            round_no: roundNo,
            offered_by: actor.id,
            offered_by_role: "admin", // recorded BY an admin, ON BEHALF of the vendor
            note: body.note ?? null,
          })
          .returning({ id: negotiationRounds.id });

        await tx.insert(negotiationRoundLines).values(
          body.lines!.map((l) => ({
            round_id: round.id,
            line_id: l.line_id,
            offered_price_per_unit: l.price.toString(),
          })),
        );

        const result = await applyTransition({
          tx,
          dealId: deal.id,
          requestId: thread.requestId,
          currentStatus: deal.status,
          offerVersion: deal.offer_version,
          action: "record_vendor_counter",
          actor: { id: actor.id, role: "admin" },
          after: {
            thread: thread.id,
            vendor: thread.vendorName,
            round_no: roundNo,
            lines: body.lines,
          },
          // Several vendors may counter within one offer version, and one vendor
          // may counter repeatedly. Without a discriminator the second counter
          // would collide with the first on the unique key and be swallowed —
          // a vendor would counter and nobody would be told.
          eventDiscriminator: `${thread.id}:${roundNo}`,
          notificationPayload: {
            request_no: thread.requestNo,
            vendor_name: thread.vendorName,
            round_no: roundNo,
          },
        });

        return { status: result.to, thread_status: "COUNTERED" as const, round_no: roundNo };
      }

      // ----------------------------------------------------------------- AGREE
      // Default to the standing prices: their counter where they made one, our
      // ask where they did not. An admin can still override per line.
      const standing = await tx.execute(sql`
        SELECT vtl.line_id,
               COALESCE(vtl.counter_price, vtl.ask_price) AS price,
               bl.quantity
        FROM vendor_thread_lines vtl
        JOIN buyback_lines bl ON bl.id = vtl.line_id
        WHERE vtl.thread_id = ${thread.id}
      `);

      const override = new Map((body.lines ?? []).map((l) => [l.line_id, l.price]));

      const agreed = (
        standing as unknown as Array<{ line_id: string; price: string; quantity: number }>
      ).map((row) => ({
        line_id: row.line_id,
        quantity: Number(row.quantity),
        price: override.get(row.line_id) ?? Number(row.price),
      }));

      if (agreed.length === 0) {
        throw new ValidationError("This vendor's quotation has no lines to agree to.");
      }

      // THE FLOOR (M10). Refused, not warned about. Throws a 422 carrying the
      // shortfall so the admin can decide: push the vendor, or reopen the dealer
      // leg. There is deliberately no override.
      const floor = assertClearsFloor(agreed, thread.floorTotal);

      for (const line of agreed) {
        await tx
          .update(vendorThreadLines)
          .set({ agreed_price: line.price.toString(), updated_at: new Date() })
          .where(
            and(
              eq(vendorThreadLines.thread_id, thread.id),
              eq(vendorThreadLines.line_id, line.line_id),
            ),
          );
      }

      // The winner. If another thread on this deal is already AGREED, the partial
      // unique index rejects this UPDATE and the whole transaction rolls back.
      await tx
        .update(vendorThreads)
        .set({
          status: "AGREED",
          responded_at: new Date(),
          closed_at: new Date(),
          updated_at: new Date(),
        })
        .where(eq(vendorThreads.id, thread.id));

      // Everyone else, atomically, in the same transaction (M10).
      const losers = await tx
        .update(vendorThreads)
        .set({
          status: "LOST",
          close_reason: "another vendor agreed",
          closed_at: new Date(),
          updated_at: new Date(),
        })
        .where(
          and(
            eq(vendorThreads.deal_id, deal.id),
            ne(vendorThreads.id, thread.id),
            notInArray(vendorThreads.status, ["AGREED", "LOST"]),
          ),
        )
        .returning({ id: vendorThreads.id, vendor_id: vendorThreads.vendor_id });

      // Fill vendor_price into the locks — the ONE write E-186's fill-once
      // trigger permits. After this, every document and every report reads the
      // whole economics of the deal from a single row per SKU: what we pay the
      // dealer, our margin, and what the vendor pays us.
      for (const line of agreed) {
        await tx.execute(sql`
          UPDATE deal_line_locks
          SET vendor_price = ${line.price.toString()}
          WHERE deal_id = ${deal.id}
            AND line_id = ${line.line_id}
            AND offer_version = ${deal.offer_version}
        `);
      }

      // Who the losers are, for the courteous close (M10).
      const allThreads = await threadsForDeal(deal.id, tx);
      const lostIds = new Set(losers.map((l) => l.id));
      const closing = allThreads.filter((t) => lostIds.has(t.id) && t.vendor_email);

      const result = await applyTransition({
        tx,
        dealId: deal.id,
        requestId: thread.requestId,
        currentStatus: deal.status,
        offerVersion: deal.offer_version,
        action: "record_vendor_agreement",
        actor: { id: actor.id, role: "admin" },
        after: {
          thread: thread.id,
          vendor: thread.vendorName,
          agreed_total: floor.total,
          floor_total: floor.floor,
          lines: agreed,
          lost: losers.length,
        },
        // One state change, several messages: the admins get a portal ping, and
        // every losing vendor gets a courteous close (M10) — each its own event,
        // its own recipient, its own idempotency key.
        fanOut: [
          {
            party: "ADMIN",
            channel: "PORTAL",
            discriminator: "portal",
            payload: {
              request_no: thread.requestNo,
              vendor_name: thread.vendorName,
              agreed_total: floor.total,
              lost: losers.length,
            },
          },
          ...closing.map((t) => ({
            party: "VENDOR" as const,
            channel: "EMAIL" as const,
            recipientRef: t.vendor_email,
            discriminator: `lost:${t.id}`,
            payload: {
              kind: "vendor_lost",
              thread_id: t.id,
              vendor_name: t.vendor_name,
              quotation_no: t.quotation_no,
              // Note what is NOT here: the winning price. A losing vendor must
              // not learn what they were beaten by.
            },
          })),
        ],
      });

      return {
        status: result.to,
        thread_status: "AGREED" as const,
        agreed_total: floor.total,
        floor_total: floor.floor,
        lost_threads: losers.length,
      };
    });

    return successResponse({ thread_id: thread.id, ...outcome });
  },
);
