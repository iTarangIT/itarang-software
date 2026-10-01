export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealerAgreementDocuments } from "@/lib/db/schema";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";
import { readAgreementPdf } from "@/lib/agreement/executedAgreementStore";

type RouteContext = {
  params: Promise<{ dealerId: string; docId: string }>;
};

/**
 * Download ONE manually uploaded agreement file by its own storage key — how a
 * second audit trail, or a file still waiting for approval, is read at all
 * (the canonical download routes only ever serve the first of each kind).
 */
export async function GET(_req: NextRequest, context: RouteContext) {
  const auth = await requireSalesHead();
  if (!auth.ok) return auth.response;
  try {
    const { dealerId, docId } = await context.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(docId)) {
      return NextResponse.json({ success: false, message: "Document not found" }, { status: 404 });
    }

    const [doc] = await db
      .select()
      .from(dealerAgreementDocuments)
      .where(and(eq(dealerAgreementDocuments.id, docId), eq(dealerAgreementDocuments.application_id, dealerId)))
      .limit(1);
    if (!doc) {
      return NextResponse.json({ success: false, message: "Document not found" }, { status: 404 });
    }

    const buffer = await readAgreementPdf(doc.storage_bucket, doc.storage_path);
    if (!buffer || buffer.byteLength === 0) {
      return NextResponse.json(
        { success: false, message: "The file is no longer in storage." },
        { status: 404 }
      );
    }

    // Header-safe name: the original where it is plain ASCII, else the kind.
    const fallback = `${doc.kind.replace(/_/g, "-")}-${dealerId}.pdf`;
    const safeName = (doc.file_name ?? "").replace(/[^A-Za-z0-9._ -]/g, "_").trim() || fallback;

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${safeName}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error: unknown) {
    console.error("AGREEMENT DOCUMENT DOWNLOAD ERROR:", error);
    return NextResponse.json(
      { success: false, message: (error instanceof Error && error.message) || "Download failed" },
      { status: 500 }
    );
  }
}
