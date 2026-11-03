/**
 * PATCH /api/dashboard/ceo/invoices/[id]/payment
 *
 * Record what has been collected against an OLD ZOHO invoice.
 *
 * ID 200 f (Kartik, 2 Nov): Vyapar is the only source of payments for Drive /
 * Vyapar invoices — the weekly Sale Report upload sets their amount paid, and
 * anything wrong there is fixed in Vyapar. This button stays only for the
 * Zoho-era invoices still counted in Accounts Receivable, so Finance can clear
 * them. A Drive / Vyapar invoice is refused with that explanation.
 *
 * WHERE IT IS KEPT
 *   The Zoho sync rewrites zoho_invoices.balance, so the payment lives in
 *   zoho_invoice_payments (E-369) and is taken off the Zoho balance by the
 *   receivables union (revenueSource.ts). Without E-369 the route says the
 *   database change is pending.
 *
 * `amount_paid` IS ABSOLUTE, NOT AN INCREMENT
 *   Two people recording the same ₹50,000 payment must leave the invoice at
 *   ₹50,000 collected, not ₹100,000. An absolute figure is idempotent; an
 *   increment is a race with money in it.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { salesInvoices, zohoInvoices } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import { errorMessage, isNextRedirectError } from "@/lib/api-utils";
import { isOverpaid } from "@/lib/sales/paymentStatus";
import { hasZohoInvoicePayments } from "@/lib/sales/ledgerTables";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set(["ceo", "admin", "finance_controller"]);

const BodySchema = z.object({
  /** Total collected against this invoice so far (in the CRM), in INR. Absolute. */
  amount_paid: z.number().nonnegative().finite(),
  payment_reference: z.string().trim().max(255).nullable().optional(),
  /** yyyy-mm-dd. Defaults to today when an amount is recorded. */
  last_payment_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
});

const fail = (message: string, status: number) =>
  NextResponse.json({ success: false, error: { message } }, { status });

const VYAPAR_PAYMENTS_MESSAGE =
  "Payments on Drive and Vyapar invoices come from the weekly Vyapar Sale Report upload. Fix the payment in Vyapar and upload the report.";

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireAuth();
    if (!ALLOWED_ROLES.has((user.role || "").toLowerCase())) return fail("FORBIDDEN", 403);

    const { id } = await ctx.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return fail("Not an invoice id.", 400);

    const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message: "Validation failed",
            details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          },
        },
        { status: 400 },
      );
    }

    const [zoho] = await db
      .select({ id: zohoInvoices.id, total: zohoInvoices.total, balance: zohoInvoices.balance, status: zohoInvoices.status })
      .from(zohoInvoices)
      .where(eq(zohoInvoices.id, id))
      .limit(1);
    if (!zoho) {
      const [drive] = await db.select({ id: salesInvoices.id }).from(salesInvoices).where(eq(salesInvoices.id, id)).limit(1);
      return drive ? fail(VYAPAR_PAYMENTS_MESSAGE, 409) : fail("No invoice with that id.", 404);
    }
    if (zoho.status === "void") return fail("That invoice is void.", 409);
    if (!(await hasZohoInvoicePayments())) {
      return fail("Payments on old Zoho invoices need a database update (E-369) that is not applied here yet.", 503);
    }

    // What Zoho itself still says is owed: the most the CRM can record.
    const owed = Number(zoho.balance ?? zoho.total ?? 0);
    const amountPaid = parsed.data.amount_paid;
    if (isOverpaid(amountPaid, owed)) {
      return fail(
        `Collected (₹${amountPaid.toFixed(2)}) is more than the balance Zoho shows (₹${owed.toFixed(2)}). Record the excess as a credit, not against this invoice.`,
        400,
      );
    }

    const paidOn = amountPaid > 0 ? (parsed.data.last_payment_date ?? new Date().toISOString().slice(0, 10)) : null;
    await db.execute(sql`
      INSERT INTO zoho_invoice_payments (invoice_id, amount_paid, payment_reference, last_payment_date, recorded_by, updated_at)
      VALUES (${id}::uuid, ${amountPaid.toFixed(2)}, ${parsed.data.payment_reference ?? null}, ${paidOn}::date, ${user.id}, now())
      ON CONFLICT (invoice_id) DO UPDATE SET
        amount_paid = EXCLUDED.amount_paid,
        payment_reference = EXCLUDED.payment_reference,
        last_payment_date = EXCLUDED.last_payment_date,
        recorded_by = EXCLUDED.recorded_by,
        updated_at = now()
    `);

    return NextResponse.json({
      success: true,
      data: {
        id,
        amount_paid: amountPaid.toFixed(2),
        balance: Math.max(owed - amountPaid, 0).toFixed(2),
        last_payment_date: paidOn,
      },
    });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    return fail(errorMessage(e), 500);
  }
}
