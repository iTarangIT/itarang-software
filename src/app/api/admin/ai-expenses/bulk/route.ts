/**
 * E-172 — POST /api/admin/ai-expenses/bulk
 *
 * Admin-only bulk invoice import. Accepts 1–10 invoice files in a single
 * multipart request and, per file, sequentially: uploads to Supabase Storage,
 * runs AI extraction, dedups by invoice number (skipping duplicates), and
 * inserts an approved AI expense row. Returns a per-file summary.
 *
 * The client chunks larger selections into batches of ≤5 and calls this route
 * per chunk so each invocation stays well under the function timeout.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { expenseSubmissions } from "@/lib/db/schema";
import { requireApiAdmin } from "@/lib/auth/requireApiAdmin";
import { isNextRedirectError, errorMessage } from "@/lib/api-utils";
import { createClient } from "@/lib/supabase/server";
import { extractInvoice } from "@/lib/ai/invoices/extractInvoice";
import { resolveBucket } from "@/lib/expenses/resolveBucket";
import { resolveDepartment } from "@/lib/expenses/departmentRules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ALLOWED_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);
const MAX_FILES = 10;
const MAX_SIZE = 5 * 1024 * 1024;

type SkippedRow = { file: string; invoice_number: string | null; reason: string };
type ErrorRow = { file: string; reason: string };
type ImportedRow = {
  id: string;
  file: string;
  invoice_number: string | null;
  vendor: string | null;
  amount: number;
};

export async function POST(req: NextRequest) {
  try {
    const guard = await requireApiAdmin();
    if (!guard.ok) return guard.response;
    const user = guard.user;

    const formData = await req.formData();
    const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);

    if (files.length === 0) {
      return NextResponse.json(
        { success: false, error: { message: "No files uploaded" } },
        { status: 400 },
      );
    }
    if (files.length > MAX_FILES) {
      return NextResponse.json(
        { success: false, error: { message: `At most ${MAX_FILES} files per request` } },
        { status: 400 },
      );
    }

    const supabase = await createClient();

    // Existing project tags (any department) so the model reuses tags.
    const tagRows = await db
      .selectDistinct({ tag: expenseSubmissions.project_tag })
      .from(expenseSubmissions)
      .where(isNotNull(expenseSubmissions.project_tag))
      .orderBy(expenseSubmissions.project_tag)
      .limit(100);
    const existingTags = tagRows.map((r) => r.tag).filter(Boolean) as string[];

    const imported: ImportedRow[] = [];
    const skipped: SkippedRow[] = [];
    const errors: ErrorRow[] = [];
    const warnings: string[] = [];

    // Catches duplicates within the same batch (DB lookup catches cross-batch).
    const seenInBatch = new Set<string>();

    for (const file of files) {
      try {
        if (!ALLOWED_TYPES.has(file.type)) {
          errors.push({ file: file.name, reason: "Unsupported file type" });
          continue;
        }
        if (file.size > MAX_SIZE) {
          errors.push({ file: file.name, reason: "File exceeds 5MB" });
          continue;
        }

        const buffer = Buffer.from(await file.arrayBuffer());
        const ext = file.name.split(".").pop() || "bin";
        const path = `expenses/${user.id}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
        const { error: uploadError } = await supabase.storage
          .from("documents")
          .upload(path, buffer, { contentType: file.type, upsert: false });
        if (uploadError) {
          errors.push({ file: file.name, reason: `Upload failed: ${uploadError.message}` });
          continue;
        }
        const { data: urlData } = supabase.storage.from("documents").getPublicUrl(path);

        const extracted = await extractInvoice(buffer, file.type, file.name, { existingTags });

        if (extracted.amount == null) {
          errors.push({ file: file.name, reason: "Could not read an amount from the invoice" });
          continue;
        }

        const invoiceNumber = extracted.invoice_number?.trim() || null;
        if (!invoiceNumber) {
          warnings.push(`${file.name}: no invoice number found — imported without dedup.`);
        } else {
          const key = invoiceNumber.toLowerCase();
          if (seenInBatch.has(key)) {
            skipped.push({ file: file.name, invoice_number: invoiceNumber, reason: "duplicate" });
            continue;
          }
          const [dup] = await db
            .select({ id: expenseSubmissions.id })
            .from(expenseSubmissions)
            .where(
              and(
                eq(expenseSubmissions.source, "ai"),
                sql`lower(${expenseSubmissions.invoice_number}) = ${key}`,
              ),
            )
            .limit(1);
          if (dup) {
            skipped.push({ file: file.name, invoice_number: invoiceNumber, reason: "duplicate" });
            continue;
          }
          seenInBatch.add(key);
        }

        // E-218 — same resolver as the Drive scanner, so a bill hand-uploaded
        // here and the same bill picked up by a folder scan land in the same
        // bucket.
        const bucket = resolveBucket({
          vendor: extracted.vendor,
          description: extracted.description,
          project_tag: extracted.project_tag,
          aiBucket: extracted.bucket,
          aiConfidence: extracted.bucket_confidence,
        });

        // E-224 — and the same for the department, which is why it is resolved
        // AFTER the bucket: the rule that keeps raw material off the Tech budget
        // is stated in terms of the bucket.
        const department = resolveDepartment({
          vendor: extracted.vendor,
          description: extracted.description,
          project_tag: extracted.project_tag,
          bucket: bucket.bucket,
          aiDepartment: extracted.department,
          aiConfidence: extracted.department_confidence,
        }).department;

        let inserted: { id: string } | undefined;
        try {
          [inserted] = await db
            .insert(expenseSubmissions)
            .values({
              submitted_by: user.id,
              category: "Invoice",
              amount: extracted.amount.toFixed(2),
              description: extracted.description ?? null,
              bill_url: urlData.publicUrl,
              bill_storage_path: path,
              status: "approved",
              approved_by: user.id,
              approved_at: new Date(),
              department,
              project_tag: extracted.project_tag ?? null,
              bucket: bucket.bucket,
              bucket_source: bucket.source,
              vendor: extracted.vendor ?? null,
              expense_date: extracted.date ?? null,
              source: "ai",
              ai_raw: extracted,
              invoice_number: invoiceNumber,
              file_name: file.name,
            })
            .returning({ id: expenseSubmissions.id });
        } catch (e: unknown) {
          // Unique-index race backstop (E-172 partial unique on AI invoice number).
          if (typeof e === "object" && e !== null && (e as { code?: string }).code === "23505") {
            skipped.push({ file: file.name, invoice_number: invoiceNumber, reason: "duplicate" });
            continue;
          }
          throw e;
        }

        imported.push({
          id: inserted?.id ?? "",
          file: file.name,
          invoice_number: invoiceNumber,
          vendor: extracted.vendor ?? null,
          amount: extracted.amount,
        });
      } catch (e: unknown) {
        errors.push({ file: file.name, reason: errorMessage(e) });
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        imported: imported.length,
        importedRows: imported,
        skipped,
        errors,
        warnings,
      },
    });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    const msg = errorMessage(e);
    console.error("[ai-expenses/bulk] error:", msg);
    return NextResponse.json(
      { success: false, error: { message: msg } },
      { status: 500 },
    );
  }
}
