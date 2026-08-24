/**
 * E-258 — one scrap consignment, from iTarang's side.
 *
 *   GET   — the deal, its batteries, the photographs and the negotiation
 *   POST  — the moves: counter | accept | reject | pay | record-offline-payment
 *
 * WHO MAY TRANSACT. Reading is open to the full admin role set; every move
 * that names a price, accepts one, or moves money is gated to `admin` and
 * `ceo`. That is the same bar `approve-winning-bid` holds — this endpoint
 * decides how much iTarang pays and then pays it.
 *
 * "PAY" IS A PAYOUT, NOT A CHECKOUT. Razorpay Checkout collects money into the
 * iTarang account; it cannot send money out, so it cannot settle a purchase
 * from an NBFC. The money leg is a RazorpayX payout (src/lib/razorpayx.ts),
 * with an explicit, attributed offline record for the environments where
 * RAZORPAYX_* is unset and for the transfers that really do happen in a bank
 * portal. See src/lib/nbfc/scrap/payment.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { clientError, validationError } from "@/lib/nbfc/http-error";
import {
  resolveAdminActor,
  statusFromError,
  ADMIN_ROLES,
} from "@/lib/nbfc/admin/auth";
import {
  getConsignment,
  markConsignmentReceived,
  respondToConsignment,
} from "@/lib/nbfc/scrap/consignment";
import { getScrapPaymentTiming } from "@/lib/nbfc/scrap/payment-settings";
import {
  payConsignment,
  recordOfflinePayment,
  refreshPayout,
} from "@/lib/nbfc/scrap/payment";
import {
  notifyScrapAgreed,
  notifyScrapClosed,
  notifyScrapCountered,
  notifyScrapPaid,
} from "@/lib/nbfc/scrap/notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * TWO GATES, NOT ONE. Haggling over a rate and wiring the money are different
 * decisions and were wrongly held to the same bar: a single `{admin, ceo}` set
 * left the sales_head who is notified of every new consignment staring at "you
 * can see this deal but not price or pay for it", with nobody to hand it to.
 *
 * NEGOTIATE — counter, accept, decline. Deliberately the same four roles as
 * ADMIN_AUDIENCE_ROLES, the people the submission notification already goes to:
 * if a role is worth telling about a new lot, it is worth letting them answer
 * it. Nothing here moves money — an accepted rate is a payable that still needs
 * someone below to release it.
 *
 * PAY — the RazorpayX payout and the offline record. Unchanged at {admin, ceo}:
 * the same bar `approve-winning-bid` holds, because this is company money
 * leaving the account.
 */
const SCRAP_NEGOTIATE_ROLES = new Set([
  "admin",
  "ceo",
  "business_head",
  "sales_head",
]);
const SCRAP_PAY_ROLES = new Set(["admin", "ceo"]);
const MONEY_ACTIONS = new Set([
  "pay",
  "refresh-payment",
  "record-offline-payment",
]);

/**
 * [E-259] Recording that a lot arrived is a warehouse fact, not a treasury
 * one, so it sits with the negotiate set. It does gate the payout under a
 * post_lot term — which is the reason it is admin-side only and the selling
 * NBFC cannot set it.
 */
const RECEIVE_ACTION = "mark-received";

/**
 * `resolveAdminActor` returns a uuid for a real session but a numeric
 * surrogate under the non-production test bypass, and every actor column this
 * flow writes (`paid_by`, `nbfc_audit_log.user_id`) is a uuid. A surrogate is
 * stored as NULL rather than blowing up the insert it rides along with.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const actorUuid = (id: string): string | null => (UUID_RE.test(id) ? id : null);

const ActionBody = z
  .object({
    action: z.enum([
      "counter",
      "accept",
      "reject",
      "mark-received",
      "pay",
      "refresh-payment",
      "record-offline-payment",
    ]),
    rate_per_battery: z.number().positive().max(10_000_000).optional(),
    // [E-261] item_id → rate: a counter that answers battery by battery
    // instead of with one number. Allowed on ANY lot, whichever way the NBFC
    // first priced it — that is the flexibility. Wins over `amount`.
    item_rates: z
      .record(z.string().uuid(), z.number().positive().max(10_000_000))
      .optional(),
    // [E-260] An itemised lot is countered with a total for the pile.
    amount: z.number().positive().max(1_000_000_000).optional(),
    message: z.string().max(2000).optional(),
    /** Bank reference or UTR — required for record-offline-payment. */
    reference: z.string().min(3).max(120).optional(),
  })
  .strict();

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await resolveAdminActor(req.headers);
    if (!(ADMIN_ROLES as readonly string[]).includes(actor.role)) {
      throw new Error("FORBIDDEN: not an admin");
    }
    const { id } = await ctx.params;
    const consignment = await getConsignment(id, null);
    if (!consignment) {
      return NextResponse.json(
        { ok: false, error: "NOT_FOUND: consignment not found" },
        { status: 404 },
      );
    }
    // The payment term is per-NBFC and read live, so the screen states it
    // rather than leaving the reader to guess why Pay is disabled.
    const { timing, is_set } = await getScrapPaymentTiming(consignment.tenant_id);

    return NextResponse.json({
      ok: true,
      consignment,
      can_negotiate: SCRAP_NEGOTIATE_ROLES.has(actor.role),
      can_pay: SCRAP_PAY_ROLES.has(actor.role),
      payment_timing: timing,
      payment_timing_is_set: is_set,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(e) },
      { status: statusFromError(msg) },
    );
  }
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await resolveAdminActor(req.headers);
    if (!SCRAP_NEGOTIATE_ROLES.has(actor.role)) {
      return NextResponse.json(
        {
          ok: false,
          error: `FORBIDDEN: role '${actor.role}' can view scrap consignments but not act on them`,
        },
        { status: 403 },
      );
    }
    const { id } = await ctx.params;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: invalid JSON" },
        { status: 400 },
      );
    }
    const parsed = ActionBody.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: validationError(parsed.error), issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const { action, rate_per_battery, amount, item_rates, message, reference } = parsed.data;

    if (action === RECEIVE_ACTION) {
      const consignment = await markConsignmentReceived({
        id,
        actor_user_id: actorUuid(actor.user_id),
      });
      return NextResponse.json({ ok: true, consignment });
    }

    // --- the money leg ---------------------------------------------------
    // Gated here rather than at the top of the handler: the narrower set
    // applies to only three of the six actions, and which one it is is not
    // known until the body has parsed.
    if (MONEY_ACTIONS.has(action) && !SCRAP_PAY_ROLES.has(actor.role)) {
      return NextResponse.json(
        {
          ok: false,
          error: `FORBIDDEN: role '${actor.role}' can negotiate this deal but not release the payment — an admin or the CEO pays`,
        },
        { status: 403 },
      );
    }

    if (action === "pay" || action === "refresh-payment") {
      const result =
        action === "pay"
          ? await payConsignment({
              consignment_id: id,
              actor_user_id: actorUuid(actor.user_id),
            })
          : await refreshPayout({
              consignment_id: id,
              actor_user_id: actorUuid(actor.user_id),
            });

      // Only a settled payment is news. A queued payout tells the NBFC nothing
      // it can act on and would land again minutes later when it clears.
      if (result.payment_status === "paid") {
        await notifyScrapPaid(result.consignment);
      }
      return NextResponse.json({ ok: true, ...result });
    }

    if (action === "record-offline-payment") {
      if (!reference) {
        return NextResponse.json(
          {
            ok: false,
            error: "BAD_REQUEST: a bank reference or UTR is required",
          },
          { status: 400 },
        );
      }
      const result = await recordOfflinePayment({
        consignment_id: id,
        actor_user_id: actorUuid(actor.user_id),
        reference,
        note: message ?? null,
      });
      await notifyScrapPaid(result.consignment);
      return NextResponse.json({ ok: true, ...result });
    }

    // --- the negotiation -------------------------------------------------
    const consignment = await respondToConsignment({
      id,
      party: "admin",
      tenant_id: null,
      actor_user_id: actorUuid(actor.user_id),
      kind: action,
      rate_per_battery: rate_per_battery ?? null,
      amount: amount ?? null,
      item_rates: item_rates ?? null,
      message: message ?? null,
    });

    if (action === "counter") {
      await notifyScrapCountered(consignment, "admin", rate_per_battery ?? null, amount ?? null);
    } else if (action === "accept") {
      await notifyScrapAgreed(consignment, "admin");
    } else {
      await notifyScrapClosed(consignment, "reject", message ?? null, "admin");
    }

    return NextResponse.json({ ok: true, consignment });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(e) },
      { status: statusFromError(msg) },
    );
  }
}
