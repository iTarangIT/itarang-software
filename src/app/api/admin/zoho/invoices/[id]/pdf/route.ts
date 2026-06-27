/**
 * E-174 — GET /api/admin/zoho/invoices/[id]/pdf
 *
 * CEO-only. Streams the real Zoho tax-invoice PDF for a synced invoice so the
 * CEO can open the actual invoice from a dashboard drill-down. [id] is the
 * zoho_invoice_id; we look up the owning organization_id locally (multi-org
 * login) and ask Zoho to render that invoice as a PDF.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { zohoInvoices } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import { fetchInvoicePdf } from "@/lib/zoho/invoices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isCeo(user: { role?: string; email?: string }): boolean {
  const role = (user.role || "").toLowerCase();
  const email = (user.email || "").toLowerCase();
  return role === "ceo" || role === "admin" || email === "sanchit@itarang.com";
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireAuth();
    if (!isCeo(user)) {
      return NextResponse.json(
        { success: false, error: { message: "FORBIDDEN: CEO only" } },
        { status: 403 },
      );
    }

    const { id } = await params;
    if (!id) {
      return NextResponse.json(
        { success: false, error: { message: "Missing invoice id" } },
        { status: 400 },
      );
    }

    const [row] = await db
      .select({
        organization_id: zohoInvoices.organization_id,
        invoice_number: zohoInvoices.invoice_number,
      })
      .from(zohoInvoices)
      .where(eq(zohoInvoices.zoho_invoice_id, id))
      .limit(1);

    if (!row) {
      return NextResponse.json(
        { success: false, error: { message: "Invoice not found" } },
        { status: 404 },
      );
    }

    const pdf = await fetchInvoicePdf(id, row.organization_id ?? undefined);
    const filename = `invoice-${row.invoice_number || id}.pdf`;

    return new NextResponse(pdf, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        // inline so the browser opens it in a new tab rather than downloading.
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e: unknown) {
    if (
      e &&
      typeof e === "object" &&
      "digest" in e &&
      String((e as { digest?: string }).digest).startsWith("NEXT_REDIRECT")
    ) {
      throw e;
    }
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { success: false, error: { message: msg } },
      { status: 500 },
    );
  }
}
