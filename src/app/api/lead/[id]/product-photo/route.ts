// Dealer-captured product photos for Step 4 Sections B & C.
// Addendum V0.1 §5.1 — battery/charger serial close-up + unit photo.
// Single FormData POST: { file, kind: 'battery' | 'charger', label }.
// Returns { url } — the client appends it to battery_photo_urls /
// charger_photo_urls and sends them with the product-selection submit.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { requireRole } from "@/lib/auth-utils";
import { uploadFileToStorage } from "@/lib/storage";

const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/jpg"]);
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_KINDS = new Set(["battery", "charger"]);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireRole(["dealer"]);
    const { id: leadId } = await params;

    const form = await req.formData();
    const file = form.get("file") as File | null;
    const kind = String(form.get("kind") || "");
    const label = String(form.get("label") || "").trim() || "photo";

    if (!file) {
      return NextResponse.json(
        { success: false, error: { message: "file is required" } },
        { status: 400 },
      );
    }
    if (!ALLOWED_KINDS.has(kind)) {
      return NextResponse.json(
        { success: false, error: { message: "kind must be 'battery' or 'charger'" } },
        { status: 400 },
      );
    }
    if (!ALLOWED_TYPES.has(file.type)) {
      return NextResponse.json(
        { success: false, error: { message: "Only PNG and JPEG images are allowed" } },
        { status: 400 },
      );
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { success: false, error: { message: "Image must be 5 MB or smaller" } },
        { status: 400 },
      );
    }

    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (!lead) {
      return NextResponse.json(
        { success: false, error: { message: "Lead not found" } },
        { status: 404 },
      );
    }
    if (lead.dealer_id !== user.dealer_id) {
      return NextResponse.json(
        { success: false, error: { message: "Access denied" } },
        { status: 403 },
      );
    }

    const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
    const safeLabel = label.replace(/[^a-z0-9_-]/gi, "_").slice(0, 24) || "photo";
    const folder = `leads/${leadId}/product-photos`;
    const fileName = `${kind}_${safeLabel}_${Date.now()}.${ext}`;

    const buffer = Buffer.from(await file.arrayBuffer());
    const { url } = await uploadFileToStorage({
      fileBuffer: buffer,
      fileName,
      folder,
      contentType: file.type,
      upsert: true,
    });

    return NextResponse.json({ success: true, data: { url } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Upload failed";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
