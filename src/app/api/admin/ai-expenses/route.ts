/**
 * E-106 — /api/admin/ai-expenses
 *
 * Admin-only.
 *  - POST: persist an admin-reviewed AI invoice expense. Saved as approved +
 *    source='ai' so it counts immediately on the CEO dashboard.
 *  - GET:  list recorded AI expenses for the tracker table.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { expenseSubmissions, users } from "@/lib/db/schema";
import { requireApiAdmin } from "@/lib/auth/requireApiAdmin";
import { isNextRedirectError, errorMessage } from "@/lib/api-utils";
import {
  EXPENSE_BUCKET_VALUES,
  EXPENSE_DEPARTMENT_VALUES,
  expenseDepartmentLabel,
} from "@/lib/expenses";
import { resolveBucket } from "@/lib/expenses/resolveBucket";
import { resolveDepartment } from "@/lib/expenses/departmentRules";
import { resolveMonthRange } from "@/lib/expenses/monthRange";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The table is a review surface, not a report — it pages by recency rather
 * than streaming the whole ledger. The response says when it hit this, so the
 * UI can tell the reviewer they are not looking at everything.
 */
const LIST_LIMIT = 200;

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
  // E-218 — optional: when the reviewer picked a bucket it is taken as their
  // decision, otherwise resolveBucket() derives one from the rules + whatever
  // the extractor suggested in ai_raw.
  bucket: z.enum(EXPENSE_BUCKET_VALUES).optional().nullable(),
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

    // E-218 — an explicit choice in the review form is a human decision and
    // must survive the backfill; otherwise derive it the same way every other
    // ingest path does.
    const aiRaw = (d.ai_raw ?? null) as {
      bucket?: string | null;
      bucket_confidence?: number | null;
    } | null;
    const bucket = d.bucket
      ? { bucket: d.bucket, source: "manual" as const }
      : resolveBucket({
          vendor: d.vendor,
          description: d.description,
          project_tag: d.project_tag,
          aiBucket: aiRaw?.bucket,
          aiConfidence: aiRaw?.bucket_confidence,
        });

    // E-229 — resolve the department the same way every other ingest path does.
    //
    // This route was the LAST write path that took a department on trust. The
    // Drive scan (driveScan.ts) and the bulk import (./bulk/route.ts) both run
    // resolveDepartment(); this one wrote `d.department` straight through. And
    // the value it received is, almost always, the extractor's own answer —
    // ExpenseTrackerView prefills the select from `ex.department` and the
    // reviewer usually confirms without touching it. So the one classifier
    // mistake E-224 was written to correct could still walk in here, one
    // invoice at a time, and put another Trontek bill on the Tech budget.
    //
    // A named-vendor rule therefore beats the submitted value. It is a fact
    // about the vendor — Trontek sells cells, production buys them — not a
    // judgement about this invoice, so there is nothing for the form to
    // usefully disagree with. It is not silent either: the response says what
    // was changed and why, and PATCH /api/admin/ai-expenses/:id still lets a
    // human have the last word on a row that is genuinely an exception.
    //
    // No confidence is passed. `d.department` has already cleared the zod
    // enum and reflects what a reviewer had on screen, so the sub-0.5 floor —
    // which exists to catch a model guessing — would be the wrong test here.
    const resolvedDepartment = resolveDepartment({
      vendor: d.vendor,
      description: d.description,
      project_tag: d.project_tag,
      bucket: bucket.bucket,
      aiDepartment: d.department,
    });
    const departmentNote =
      resolvedDepartment.department === d.department
        ? null
        : `Filed under ${expenseDepartmentLabel(
            resolvedDepartment.department,
          )} rather than ${expenseDepartmentLabel(d.department)} — ${
            resolvedDepartment.detail ?? "rule"
          }.`;

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
          department: resolvedDepartment.department,
          project_tag: d.project_tag ?? null,
          bucket: bucket.bucket,
          bucket_source: bucket.source,
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

    return NextResponse.json({
      success: true,
      id: inserted?.id,
      // E-229 — what was actually stored, so the reviewer is told when a rule
      // overrode the department they submitted rather than finding out from
      // the dashboard later.
      department: resolvedDepartment.department,
      department_note: departmentNote,
    });
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

    // E-216 — ?needs_attention=1 backs the needs-attention panel. Same route
    // and same shape as the full tracker list, so the two cannot disagree
    // about what a row looks like.
    const onlyAttention = req.nextUrl.searchParams.get("needs_attention") === "1";
    const conds = [eq(expenseSubmissions.source, "ai")];
    if (onlyAttention) conds.push(eq(expenseSubmissions.needs_attention, true));

    // ?from=YYYY-MM&to=YYYY-MM — the tracker's month-range filter. Filtering
    // here rather than in the browser is not a preference: the list is capped
    // at LIST_LIMIT by recency, so a client-side filter would report an older
    // month as empty simply because its rows were never fetched.
    const parsed = resolveMonthRange(req.nextUrl.searchParams);
    if (!parsed.ok) {
      return NextResponse.json(
        { success: false, error: { message: parsed.error } },
        { status: 400 },
      );
    }
    const range = parsed.range;

    // COALESCE(expense_date, created_at::date) is the effective expense day —
    // the same expression the ZIP export filters on, so the table and the
    // Download button beside it can never disagree about a row's month.
    const effectiveDate = sql`COALESCE(${expenseSubmissions.expense_date}, ${expenseSubmissions.created_at}::date)`;
    if (range.startStr) conds.push(gte(effectiveDate, range.startStr));
    if (range.endStr) conds.push(lt(effectiveDate, range.endStr));

    const rows = await db
      .select({
        id: expenseSubmissions.id,
        vendor: expenseSubmissions.vendor,
        amount: expenseSubmissions.amount,
        description: expenseSubmissions.description,
        department: expenseSubmissions.department,
        project_tag: expenseSubmissions.project_tag,
        // E-218 — the coarse spend bucket + who decided it, so the tracker can
        // show it and let a reviewer correct it.
        bucket: expenseSubmissions.bucket,
        bucket_source: expenseSubmissions.bucket_source,
        invoice_number: expenseSubmissions.invoice_number,
        file_name: expenseSubmissions.file_name,
        expense_date: expenseSubmissions.expense_date,
        bill_url: expenseSubmissions.bill_url,
        created_at: expenseSubmissions.created_at,
        // E-216 — provenance + flag, so the tracker can mark which rows came
        // from Drive and why any of them need a look.
        drive_file_id: expenseSubmissions.drive_file_id,
        needs_attention: expenseSubmissions.needs_attention,
        attention_reason: expenseSubmissions.attention_reason,
        // E-217 — `amount` above is INR; these say what the document said, so
        // the tracker can show "$200 @ 86.4" rather than a bare rupee figure.
        currency: expenseSubmissions.currency,
        original_amount: expenseSubmissions.original_amount,
        fx_rate: expenseSubmissions.fx_rate,
        submitter_name: users.name,
      })
      .from(expenseSubmissions)
      .leftJoin(users, eq(expenseSubmissions.submitted_by, users.id))
      .where(and(...conds))
      // By the date the money was spent, not the date someone happened to
      // upload the PDF — otherwise the Date column reads unsorted, which is
      // confusing next to a filter that works on exactly that date. created_at
      // breaks ties so the order stays stable between requests.
      .orderBy(desc(effectiveDate), desc(expenseSubmissions.created_at))
      // One extra row is a probe: if it comes back, there is more behind it.
      .limit(LIST_LIMIT + 1);

    const capped = rows.length > LIST_LIMIT;

    return NextResponse.json({
      success: true,
      data: capped ? rows.slice(0, LIST_LIMIT) : rows,
      meta: { capped, limit: LIST_LIMIT, range: range.label },
    });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    return NextResponse.json(
      { success: false, error: { message: errorMessage(e) } },
      { status: 500 },
    );
  }
}
