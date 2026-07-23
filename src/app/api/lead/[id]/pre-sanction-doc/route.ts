/**
 * POST /api/lead/[id]/pre-sanction-doc  (multipart/form-data)
 *
 * Step-4 pre-sanction document bucket (dealer). Uploads up to a few files at a
 * time (all formats: image/video/zip/pdf) and returns bucket items the client
 * appends to its ≤10 list (persisted into product_selections.pre_sanction_doc_urls
 * on submit/draft).
 *
 *   mode=separate → each file becomes its own item.
 *   mode=combine  → merge the selected image/PDF files into ONE PDF (one item).
 *
 * Body: files[] (1+), mode ('separate' | 'combine').
 * Role: dealer, must own the lead (mirrors /api/lead/[id]/product-photo).
 */
import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads, productSelections } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { uploadFileToStorage } from "@/lib/storage";
import { combineToPdf, isCombinable } from "@/lib/pdf/combine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB per file (videos allowed)

interface BucketItem {
  url: string;
  name: string;
  type: string;
  size: number;
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "file";
}
function extOf(name: string, fallback: string): string {
  const e = (name.split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return e || fallback;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireRole(["dealer"]);
    const { id: leadId } = await params;

    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (!lead) {
      return NextResponse.json(
        { ok: false, error: "Lead not found" },
        { status: 404 },
      );
    }
    if (lead.dealer_id !== user.dealer_id) {
      return NextResponse.json({ ok: false, error: "Access denied" }, { status: 403 });
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json(
        { ok: false, error: "Expected multipart/form-data" },
        { status: 400 },
      );
    }

    const mode = String(form.get("mode") ?? "separate") === "combine" ? "combine" : "separate";
    const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length === 0) {
      return NextResponse.json(
        { ok: false, error: "At least one file is required" },
        { status: 400 },
      );
    }
    for (const f of files) {
      if (f.size > MAX_BYTES) {
        return NextResponse.json(
          { ok: false, error: `'${f.name}' exceeds the 50 MB limit` },
          { status: 400 },
        );
      }
    }

    const folder = `leads/${leadId}/pre-sanction-docs`;

    // Combine mode — merge image/PDF files into one PDF item.
    if (mode === "combine") {
      const bad = files.find((f) => !isCombinable(f.type, f.name));
      if (bad) {
        return NextResponse.json(
          { ok: false, error: `Only images and PDFs can be combined ('${bad.name}' can't).` },
          { status: 400 },
        );
      }
      const inputs = await Promise.all(
        files.map(async (f) => ({
          buffer: Buffer.from(await f.arrayBuffer()),
          type: f.type,
          name: f.name,
        })),
      );
      const pdf = await combineToPdf(inputs);
      const fileName = `combined_${Date.now()}.pdf`;
      const { url } = await uploadFileToStorage({
        fileBuffer: pdf,
        fileName,
        folder,
        contentType: "application/pdf",
        upsert: true,
      });
      const item: BucketItem = {
        url,
        name: `Combined (${files.length} docs).pdf`,
        type: "application/pdf",
        size: pdf.length,
      };
      return NextResponse.json({ ok: true, items: [item] });
    }

    // Separate mode — one item per file.
    const items: BucketItem[] = [];
    for (const f of files) {
      const buffer = Buffer.from(await f.arrayBuffer());
      const type = f.type || "application/octet-stream";
      const fileName = `${Date.now()}_${safeName(f.name)}`.replace(
        /(\.[a-z0-9]+)?$/i,
        (m) => m || `.${extOf(f.name, "bin")}`,
      );
      const { url } = await uploadFileToStorage({
        fileBuffer: buffer,
        fileName,
        folder,
        contentType: type,
        upsert: true,
      });
      items.push({ url, name: f.name, type, size: f.size });
    }
    return NextResponse.json({ ok: true, items });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

/**
 * PATCH /api/lead/[id]/pre-sanction-doc  (application/json)
 *
 * Persist the FULL pre-sanction bucket list onto the lead's latest
 * product_selections row. Lets the dealer add/remove pre-sanction docs at any
 * time — including after the Step-4 selection is frozen (readOnly), when Save
 * Draft / Submit are unavailable. No-ops (persisted:false) if no selection row
 * exists yet; Save Draft / Submit will persist it in that case.
 *
 * Body: { items: [{ url, name, type, size }] }  (max 10).
 * Role: dealer, must own the lead.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireRole(["dealer"]);
    const { id: leadId } = await params;

    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (!lead) {
      return NextResponse.json({ ok: false, error: "Lead not found" }, { status: 404 });
    }
    if (lead.dealer_id !== user.dealer_id) {
      return NextResponse.json({ ok: false, error: "Access denied" }, { status: 403 });
    }

    let body: { items?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "Expected JSON body" }, { status: 400 });
    }

    const raw = Array.isArray(body.items) ? body.items : [];
    if (raw.length > 10) {
      return NextResponse.json(
        { ok: false, error: "Up to 10 items only" },
        { status: 400 },
      );
    }
    // Keep only well-formed bucket items.
    const items: BucketItem[] = raw
      .filter((it): it is Record<string, unknown> => !!it && typeof it === "object")
      .map((it) => ({
        url: String(it.url ?? ""),
        name: String(it.name ?? "file"),
        type: String(it.type ?? "application/octet-stream"),
        size: Number(it.size ?? 0) || 0,
      }))
      .filter((it) => it.url);

    // Target the most-recent selection row (the submitted one, once frozen).
    const [row] = await db
      .select({ id: productSelections.id })
      .from(productSelections)
      .where(eq(productSelections.lead_id, leadId))
      .orderBy(desc(productSelections.created_at))
      .limit(1);

    if (!row) {
      return NextResponse.json({ ok: true, persisted: false, items });
    }

    await db
      .update(productSelections)
      .set({ pre_sanction_doc_urls: items, updated_at: new Date() })
      .where(eq(productSelections.id, row.id));

    return NextResponse.json({ ok: true, persisted: true, items });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Save failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
