/**
 * E-106 — POST /api/admin/ai-expenses/extract
 *
 * Admin-only. Accepts a multipart invoice/receipt (PDF or image), uploads it
 * to Supabase Storage, runs OpenAI vision extraction, and returns the bill URL
 * plus the extracted draft. No DB row is created here — the admin reviews the
 * draft and submits via POST /api/admin/ai-expenses.
 */
import { NextRequest, NextResponse } from "next/server";
import { isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { expenseSubmissions } from "@/lib/db/schema";
import { requireApiAdmin } from "@/lib/auth/requireApiAdmin";
import { isNextRedirectError, errorMessage } from "@/lib/api-utils";
import { createClient } from "@/lib/supabase/server";
import { extractInvoice } from "@/lib/ai/invoices/extractInvoice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);

export async function POST(req: NextRequest) {
  try {
    const guard = await requireApiAdmin();
    if (!guard.ok) return guard.response;
    const user = guard.user;

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file || file.size === 0) {
      return NextResponse.json(
        { success: false, error: { message: "No file uploaded" } },
        { status: 400 },
      );
    }
    if (!ALLOWED_TYPES.has(file.type)) {
      return NextResponse.json(
        { success: false, error: { message: "File must be a PDF or image (PNG/JPEG/WebP)" } },
        { status: 400 },
      );
    }
    if (file.size > 5 * 1024 * 1024) {
      return NextResponse.json(
        { success: false, error: { message: "File must be ≤ 5MB" } },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    // Upload the bill to Supabase Storage (same bucket/pattern as /api/expenses/submit).
    const supabase = await createClient();
    const ext = file.name.split(".").pop() || "bin";
    const path = `expenses/${user.id}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
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

    // Existing project tags (any department) so the model reuses tags.
    const tagRows = await db
      .selectDistinct({ tag: expenseSubmissions.project_tag })
      .from(expenseSubmissions)
      .where(isNotNull(expenseSubmissions.project_tag))
      .orderBy(expenseSubmissions.project_tag)
      .limit(100);
    const existingTags = tagRows.map((r) => r.tag).filter(Boolean) as string[];

    const extracted = await extractInvoice(buffer, file.type, file.name, {
      existingTags,
    });

    return NextResponse.json({
      success: true,
      data: {
        bill_url: urlData.publicUrl,
        bill_storage_path: path,
        file_name: file.name,
        extracted,
      },
    });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    const msg = errorMessage(e);
    console.error("[ai-expenses/extract] error:", msg);
    return NextResponse.json(
      { success: false, error: { message: msg } },
      { status: 500 },
    );
  }
}
