/**
 * E-106 — /api/admin/ai-expenses
 *
 * Admin-only.
 *  - POST: persist an admin-reviewed AI invoice expense. Saved as approved +
 *    source='ai' so it counts immediately on the CEO dashboard.
 *  - GET:  list recorded AI expenses for the tracker table.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { expenseSubmissions, users } from "@/lib/db/schema";
import { requireApiAdmin } from "@/lib/auth/requireApiAdmin";
import { isNextRedirectError, errorMessage } from "@/lib/api-utils";
import { EXPENSE_DEPARTMENT_VALUES } from "@/lib/expenses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  vendor: z.string().trim().max(160).optional().nullable(),
  amount: z.coerce.number().positive().max(100_000_000),
  expense_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "expense_date must be yyyy-mm-dd")
    .optional()
    .nullable(),
  description: z.string().trim().max(2000).optional().nullable(),
  department: z.enum(EXPENSE_DEPARTMENT_VALUES),
  project_tag: z.string().trim().min(1).max(80).optional().nullable(),
  invoice_number: z.string().trim().max(120).optional().nullable(),
  file_name: z.string().trim().max(255).optional().nullable(),
  bill_url: z.string().url().optional().nullable(),
  bill_storage_path: z.string().max(512).optional().nullable(),
  ai_raw: z.any().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const guard = await requireApiAdmin();
    if (!guard.ok) return guard.response;
    const user = guard.user;

    const body = await req.json();
    const parsed = CreateSchema.safeParse(body);
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
    const now = new Date();

    const invoiceNumber = d.invoice_number?.trim() || null;

    // Dedup: skip an AI invoice whose number already exists (case-insensitive).
    if (invoiceNumber) {
      const [dup] = await db
        .select({ id: expenseSubmissions.id })
        .from(expenseSubmissions)
        .where(
          and(
            eq(expenseSubmissions.source, "ai"),
            sql`lower(${expenseSubmissions.invoice_number}) = lower(${invoiceNumber})`,
          ),
        )
        .limit(1);
      if (dup) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: "DUPLICATE_INVOICE",
              message: `Invoice ${invoiceNumber} is already recorded.`,
            },
          },
          { status: 409 },
        );
      }
    }

    let inserted: { id: string } | undefined;
    try {
      [inserted] = await db
        .insert(expenseSubmissions)
        .values({
          submitted_by: user.id,
          // category is NOT NULL; AI expenses are categorised by department/project.
          category: "Invoice",
          amount: d.amount.toFixed(2),
          description: d.description ?? null,
          bill_url: d.bill_url ?? null,
          bill_storage_path: d.bill_storage_path ?? null,
          status: "approved",
          approved_by: user.id,
          approved_at: now,
          department: d.department,
          project_tag: d.project_tag ?? null,
          vendor: d.vendor ?? null,
          expense_date: d.expense_date ?? null,
          source: "ai",
          ai_raw: d.ai_raw ?? null,
          invoice_number: invoiceNumber,
          file_name: d.file_name?.trim() || null,
        })
        .returning({ id: expenseSubmissions.id });
    } catch (e: unknown) {
      // Unique-index race backstop (E-172 partial unique on AI invoice number).
      if (typeof e === "object" && e !== null && (e as { code?: string }).code === "23505") {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: "DUPLICATE_INVOICE",
              message: `Invoice ${invoiceNumber ?? ""} is already recorded.`,
            },
          },
          { status: 409 },
        );
      }
      throw e;
    }

    return NextResponse.json({ success: true, id: inserted?.id });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    const msg = errorMessage(e);
    console.error("[ai-expenses POST] error:", msg);
    return NextResponse.json(
      { success: false, error: { message: msg } },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  try {
    const guard = await requireApiAdmin();
    if (!guard.ok) return guard.response;

    // E-214 — ?needs_attention=1 backs the needs-attention panel. Same route
    // and same shape as the full tracker list, so the two cannot disagree
    // about what a row looks like.
    const onlyAttention = req.nextUrl.searchParams.get("needs_attention") === "1";
    const conds = [eq(expenseSubmissions.source, "ai")];
    if (onlyAttention) conds.push(eq(expenseSubmissions.needs_attention, true));

    const rows = await db
      .select({
        id: expenseSubmissions.id,
        vendor: expenseSubmissions.vendor,
        amount: expenseSubmissions.amount,
        description: expenseSubmissions.description,
        department: expenseSubmissions.department,
        project_tag: expenseSubmissions.project_tag,
        invoice_number: expenseSubmissions.invoice_number,
        file_name: expenseSubmissions.file_name,
        expense_date: expenseSubmissions.expense_date,
        bill_url: expenseSubmissions.bill_url,
        created_at: expenseSubmissions.created_at,
        // E-214 — provenance + flag, so the tracker can mark which rows came
        // from Drive and why any of them need a look.
        drive_file_id: expenseSubmissions.drive_file_id,
        needs_attention: expenseSubmissions.needs_attention,
        attention_reason: expenseSubmissions.attention_reason,
        // E-215 — `amount` above is INR; these say what the document said, so
        // the tracker can show "$200 @ 86.4" rather than a bare rupee figure.
        currency: expenseSubmissions.currency,
        original_amount: expenseSubmissions.original_amount,
        fx_rate: expenseSubmissions.fx_rate,
        submitter_name: users.name,
      })
      .from(expenseSubmissions)
      .leftJoin(users, eq(expenseSubmissions.submitted_by, users.id))
      .where(and(...conds))
      .orderBy(desc(expenseSubmissions.created_at))
      .limit(200);

    return NextResponse.json({ success: true, data: rows });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    return NextResponse.json(
      { success: false, error: { message: errorMessage(e) } },
      { status: 500 },
    );
  }
}
