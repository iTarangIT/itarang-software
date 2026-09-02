/**
 * E-280 — PATCH /api/dashboard/ceo/invoices/[id]/payment
 *
 * Record what has been collected against a Drive-sourced sales invoice.
 *
 * WHY THIS EXISTS AT ALL
 *   Zoho knew what had been paid because payments were applied inside Zoho and
 *   the sync pulled them back. A PDF filed in Drive knows nothing of the sort:
 *   it carries a "Balance Due" printed at issue time, which is a snapshot and
 *   is wrong the moment anything is paid against it. So for Drive invoices the
 *   CRM becomes the system of record for collection, and this is where finance
 *   says so.
 *
 * DRIVE ROWS ONLY
 *   A Zoho invoice's payment state still belongs to Zoho: the hourly sync
 *   rewrites `balance` and `status` on every run, so anything written here
 *   would be silently reverted within the hour. Rather than let someone record
 *   a payment that quietly disappears, a Zoho row is refused with an
 *   explanation.
 *
 * `amount_paid` IS ABSOLUTE, NOT AN INCREMENT
 *   Two people recording the same ₹50,000 payment must leave the invoice at
 *   ₹50,000 collected, not ₹100,000. An absolute figure is idempotent; an
 *   increment is a race with money in it.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { salesInvoices } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import { errorMessage, isNextRedirectError } from "@/lib/api-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set(["ceo", "admin", "finance_controller"]);

const BodySchema = z.object({
  /** Total collected against this invoice so far, in INR. Absolute. */
  amount_paid: z.number().nonnegative().finite(),
  payment_reference: z.string().trim().max(255).nullable().optional(),
  /** yyyy-mm-dd. Defaults to today when an amount is recorded. */
  last_payment_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
});

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireAuth();
    if (!ALLOWED_ROLES.has((user.role || "").toLowerCase())) {
      return NextResponse.json(
        { success: false, error: { message: "FORBIDDEN" } },
        { status: 403 },
      );
    }

    const { id } = await ctx.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message:
              "That is not a Drive invoice id. A Zoho invoice's payment state is owned by Zoho and cannot be edited here.",
          },
        },
        { status: 400 },
      );
    }

    const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message: "Validation failed",
            details: parsed.error.issues.map((i) => ({
              path: i.path.join("."),
              message: i.message,
            })),
          },
        },
        { status: 400 },
      );
    }

    const [invoice] = await db
      .select({
        id: salesInvoices.id,
        total: salesInvoices.total,
        status: salesInvoices.status,
      })
      .from(salesInvoices)
      .where(eq(salesInvoices.id, id))
      .limit(1);

    if (!invoice) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message:
              "No Drive invoice with that id. Payments on Zoho-synced invoices are recorded in Zoho.",
          },
        },
        { status: 404 },
      );
    }
    if (invoice.status === "void") {
      return NextResponse.json(
        { success: false, error: { message: "That invoice is void." } },
        { status: 409 },
      );
    }

    const total = Number(invoice.total ?? 0);
    const amountPaid = parsed.data.amount_paid;

    // Refused rather than clamped. Balance is derived as total - amount_paid
    // and is SUMmed across every invoice for the Outstanding figure, so a
    // negative one here would quietly cancel out somebody else's genuine
    // receivable. An overpayment is a credit, not this invoice's balance.
    if (amountPaid > total + 0.005) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message: `Collected (₹${amountPaid.toFixed(2)}) is more than the invoice total (₹${total.toFixed(2)}). Record the excess as a credit, not against this invoice.`,
          },
        },
        { status: 400 },
      );
    }

    // Half a paisa of tolerance so a floating-point round trip does not leave a
    // fully-settled invoice reading as partially paid for ever.
    const settled = amountPaid >= total - 0.005;
    const status = amountPaid <= 0 ? "sent" : settled ? "paid" : "partially_paid";

    const [row] = await db
      .update(salesInvoices)
      .set({
        amount_paid: amountPaid.toFixed(2),
        status,
        payment_reference: parsed.data.payment_reference ?? null,
        last_payment_date:
          amountPaid > 0
            ? (parsed.data.last_payment_date ?? new Date().toISOString().slice(0, 10))
            : null,
        payment_marked_by: user.id,
        updated_at: new Date(),
      })
      .where(eq(salesInvoices.id, id))
      .returning();

    return NextResponse.json({
      success: true,
      data: {
        id: row.id,
        status: row.status,
        amount_paid: row.amount_paid,
        balance: (total - amountPaid).toFixed(2),
        last_payment_date: row.last_payment_date,
      },
    });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    return NextResponse.json(
      { success: false, error: { message: errorMessage(e) } },
      { status: 500 },
    );
  }
}
