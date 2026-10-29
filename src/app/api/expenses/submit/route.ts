/**
 * E-105 — POST /api/expenses/submit
 *
 * Accepts a multipart/form-data submission from any authenticated user.
 * Uploads the bill to Supabase Storage (`documents` bucket) and inserts a
 * row in expense_submissions with status='pending'. CEO approval is
 * required (see /api/admin/expenses/[id]/approve) before the amount
 * shows up in "Other Business Expenses (MTD)" on the CEO dashboard.
 *
 * ID 197 (PJP phase 1): a Travel or Vehicle/Fuel claim also sends
 * `travel_days` — JSON [{ day, note }], today or up to 31 days back. Each day
 * is judged by the person's verified visits that day (ID 196): Supported or
 * Not supported, a note required for Not supported. A day already in another
 * pending or approved claim of the same category is refused. The days are
 * saved with the claim (E-364); expense_date = the earliest day. The CRM never
 * fills or prices the claim — the CEO decides. Before E-364 the days are
 * ignored and the claim saves as before.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { expenseSubmissions } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import { createClient } from "@/lib/supabase/server";
import { isS3Backend, putObject, filesProxyPath } from "@/lib/storage/s3";
import { resolveBucket } from "@/lib/expenses/resolveBucket";
import { checkClaimDays, dayMissingNote, needsTravelProof, type DayVerdict } from "@/lib/expenses/travelProof";
import { daysAlreadyClaimed, dayEvidence, hasClaimDays, insertClaimDays } from "@/lib/expenses/travelProofStore";
import { istDay } from "@/lib/visits/verifiedCapture";

const TravelDays = z
  .array(z.object({ day: z.string(), note: z.string().max(1000).nullable().optional() }))
  .max(31);

const fail = (message: string, status: number) =>
  NextResponse.json({ success: false, error: { message } }, { status });

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

    // ID 197: the day(s) a Travel / Vehicle/Fuel claim covers, judged before
    // anything is stored.
    let claimDays: Array<{ day: string; verdict: DayVerdict; note: string | null }> = [];
    if (needsTravelProof(parsed.data.category) && (await hasClaimDays())) {
      let raw: unknown = [];
      try {
        raw = JSON.parse(String(formData.get("travel_days") ?? "[]"));
      } catch {
        return fail("The travel days could not be read.", 400);
      }
      const daysParsed = TravelDays.safeParse(raw);
      if (!daysParsed.success) return fail("The travel days could not be read.", 400);
      const check = checkClaimDays(daysParsed.data.map((d) => d.day), istDay(new Date()));
      if (!check.ok) return fail(check.message, 422);
      const taken = await daysAlreadyClaimed(user.id, parsed.data.category, check.days);
      if (taken.length > 0) {
        return fail(`Already in another ${parsed.data.category} claim (pending or approved): ${taken.join(", ")}.`, 409);
      }
      const notes = new Map(daysParsed.data.map((d) => [d.day, d.note?.trim() || null]));
      for (const day of check.days) {
        const ev = await dayEvidence(user.id, day);
        claimDays.push({ day, verdict: ev.verdict, note: notes.get(day) ?? null });
      }
      const missing = dayMissingNote(claimDays);
      if (missing) return fail(`${missing} has no verified visit: add a note saying what the travel was for.`, 422);
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

    const bucket = resolveBucket({
      category: parsed.data.category,
      description: parsed.data.description,
    });

    const inserted = await db.transaction(async (tx) => {
     const [row] = await tx
      .insert(expenseSubmissions)
      .values({
        submitted_by: user.id,
        category: parsed.data.category,
        amount: parsed.data.amount.toFixed(2),
        description: parsed.data.description ?? null,
        bill_url: billUrl,
        bill_storage_path: billStoragePath,
        status: "pending",
        // E-218 — rules only, no model call: the chosen category already maps
        // cleanly onto a bucket, and a staff expense form is not worth an
        // OpenAI round-trip.
        bucket: bucket.bucket,
        bucket_source: bucket.source,
        // ID 197: a travel claim is dated by its earliest day.
        ...(claimDays.length ? { expense_date: claimDays[0]!.day } : {}),
      })
      .returning({ id: expenseSubmissions.id });
     if (row && claimDays.length) {
       // Re-checked inside the transaction: two submits racing for one day.
       const taken = await daysAlreadyClaimed(user.id, parsed.data.category, claimDays.map((d) => d.day), tx);
       if (taken.length > 0) throw new Error(`Already in another ${parsed.data.category} claim: ${taken.join(", ")}.`);
       await insertClaimDays(tx, { expenseId: row.id, userId: user.id, category: parsed.data.category, days: claimDays });
     }
     return row;
    });

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

