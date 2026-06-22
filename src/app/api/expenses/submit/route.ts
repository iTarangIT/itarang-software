/**
 * E-105 — POST /api/expenses/submit
 *
 * Accepts a multipart/form-data submission from any authenticated user.
 * Uploads the bill to Supabase Storage (`documents` bucket) and inserts a
 * row in expense_submissions with status='pending'. CEO approval is
 * required (see /api/admin/expenses/[id]/approve) before the amount
 * shows up in "Other Business Expenses (MTD)" on the CEO dashboard.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { expenseSubmissions } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import { createClient } from "@/lib/supabase/server";
import { isS3Backend, putObject, filesProxyPath } from "@/lib/storage/s3";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_CATEGORIES = [
  "Travel",
  "Office",
  "Marketing",
  "Utilities",
  "Vehicle/Fuel",
  "Food/Hospitality",
  "Software/SaaS",
  "Misc",
] as const;

const SubmitSchema = z.object({
  category: z.enum(ALLOWED_CATEGORIES),
  amount: z.coerce.number().positive().max(10_000_000),
  description: z.string().max(2000).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const user = await requireAuth();

    const formData = await req.formData();
    const file = formData.get("bill") as File | null;
    const parsed = SubmitSchema.safeParse({
      category: formData.get("category"),
      amount: formData.get("amount"),
      description: formData.get("description") || undefined,
    });

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

    let billUrl: string | null = null;
    let billStoragePath: string | null = null;

    if (file && file.size > 0) {
      if (file.size > 5 * 1024 * 1024) {
        return NextResponse.json(
          { success: false, error: { message: "Bill must be ≤ 5MB" } },
          { status: 400 },
        );
      }
      const ext = file.name.split(".").pop() || "bin";
      const path = `expenses/${user.id}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
      const buffer = Buffer.from(await file.arrayBuffer());

      if (isS3Backend) {
        await putObject("documents", path, buffer, file.type);
        billUrl = filesProxyPath("documents", path);
        billStoragePath = path;
      } else {
        const supabase = await createClient();
        const { error: uploadError } = await supabase.storage
          .from("documents")
          .upload(path, buffer, { contentType: file.type, upsert: false });

        if (uploadError) {
          return NextResponse.json(
            { success: false, error: { message: `Upload failed: ${uploadError.message}` } },
            { status: 500 },
          );
        }
        const { data: urlData } = supabase.storage.from("documents").getPublicUrl(path);
        billUrl = urlData.publicUrl;
        billStoragePath = path;
      }
    }

    const [inserted] = await db
      .insert(expenseSubmissions)
      .values({
        submitted_by: user.id,
        category: parsed.data.category,
        amount: parsed.data.amount.toFixed(2),
        description: parsed.data.description ?? null,
        bill_url: billUrl,
        bill_storage_path: billStoragePath,
        status: "pending",
      })
      .returning({ id: expenseSubmissions.id });

    return NextResponse.json({ success: true, id: inserted?.id });
  } catch (e: any) {
    if (e?.digest?.startsWith?.("NEXT_REDIRECT")) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[expenses/submit] error:", msg);
    return NextResponse.json(
      { success: false, error: { message: msg } },
      { status: 500 },
    );
  }
}

