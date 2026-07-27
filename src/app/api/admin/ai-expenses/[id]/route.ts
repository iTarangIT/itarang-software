/**
 * E-106 — PATCH /api/admin/ai-expenses/[id]
 *
 * Admin-only. Corrects a recorded AI expense — primarily the department /
 * project tag the AI may have misclassified, but vendor/amount/date/description
 * are editable too.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { expenseSubmissions } from "@/lib/db/schema";
import { requireApiAdmin } from "@/lib/auth/requireApiAdmin";
import { isNextRedirectError, errorMessage } from "@/lib/api-utils";
import { EXPENSE_DEPARTMENT_VALUES } from "@/lib/expenses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PatchSchema = z
  .object({
    department: z.enum(EXPENSE_DEPARTMENT_VALUES).optional(),
    project_tag: z.string().trim().max(80).nullable().optional(),
    vendor: z.string().trim().max(160).nullable().optional(),
    amount: z.coerce.number().positive().max(100_000_000).optional(),
    expense_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    // E-216 — let the needs-attention panel clear a flag without editing a
    // field, for the case where the extraction was right and the flag was
    // merely cautious (e.g. a genuinely un-numbered receipt).
    needs_attention: z.boolean().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "No fields to update" });

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const guard = await requireApiAdmin();
    if (!guard.ok) return guard.response;

    const { id } = await ctx.params;
    const body = await req.json();
    const parsed = PatchSchema.safeParse(body);
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
    const d = parsed.data;

    const update: Record<string, unknown> = { updated_at: new Date() };
    if (d.department !== undefined) update.department = d.department;
    if (d.project_tag !== undefined) update.project_tag = d.project_tag || null;
    if (d.vendor !== undefined) update.vendor = d.vendor || null;
    if (d.amount !== undefined) update.amount = d.amount.toFixed(2);
    if (d.expense_date !== undefined) update.expense_date = d.expense_date;
    if (d.description !== undefined) update.description = d.description || null;

    // E-216 — an admin who corrects any field has, by definition, dealt with
    // whatever the flag was warning about, so clear it rather than making them
    // do it as a second step. An explicit `needs_attention` in the body still
    // wins, so the panel can also flag a row back up.
    const editedAField = Object.keys(update).length > 1;
    if (d.needs_attention !== undefined) {
      update.needs_attention = d.needs_attention;
      if (!d.needs_attention) update.attention_reason = null;
    } else if (editedAField) {
      update.needs_attention = false;
      update.attention_reason = null;
    }

    const [row] = await db
      .update(expenseSubmissions)
      .set(update)
      .where(eq(expenseSubmissions.id, id))
      .returning({ id: expenseSubmissions.id });

    if (!row) {
      return NextResponse.json(
        { success: false, error: { message: "Not found" } },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true, id: row.id });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    const msg = errorMessage(e);
    console.error("[ai-expenses PATCH] error:", msg);
    return NextResponse.json(
      { success: false, error: { message: msg } },
      { status: 500 },
    );
  }
}
