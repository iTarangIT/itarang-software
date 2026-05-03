import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { otherDocumentRequests } from "@/lib/db/schema";

// Dealer-side creation of an additional-document request row. Mirrors the
// admin "Request More Docs" flow but with the dealer as the requester so they
// can attach extras (e.g. NOC, salary slip) proactively. The row is created
// in 'not_uploaded' state and the caller is expected to immediately POST a
// file to /api/kyc/[leadId]/requested-docs with the returned id.

function slugifyLabel(label: string): string {
    const slug = label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 80);
    return slug || "other";
}

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ leadId: string }> }
) {
    try {
        const { leadId } = await params;
        const body = await req.json().catch(() => ({} as { doc_label?: string; doc_for?: string }));
        const docLabelRaw = String(body?.doc_label || "").trim();
        const docFor = String(body?.doc_for || "primary").toLowerCase() === "co_borrower"
            ? "co_borrower"
            : "primary";

        if (!docLabelRaw) {
            return NextResponse.json(
                { success: false, error: { message: "doc_label is required" } },
                { status: 400 }
            );
        }
        if (docLabelRaw.length > 120) {
            return NextResponse.json(
                { success: false, error: { message: "doc_label must be 120 characters or less" } },
                { status: 400 }
            );
        }

        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
        const seq = Math.floor(Math.random() * 10000).toString().padStart(4, "0");
        const id = `OTHERDOC-${dateStr}-${seq}`;

        await db.insert(otherDocumentRequests).values({
            id,
            lead_id: leadId,
            requested_by: null,
            doc_label: docLabelRaw,
            doc_key: slugifyLabel(docLabelRaw),
            doc_for: docFor,
            is_required: false,
            upload_status: "not_uploaded",
            created_at: now,
            updated_at: now,
        });

        return NextResponse.json({
            success: true,
            data: {
                id,
                doc_label: docLabelRaw,
                doc_key: slugifyLabel(docLabelRaw),
                doc_for: docFor,
                is_required: false,
                file_url: null,
                upload_status: "not_uploaded",
                rejection_reason: null,
                uploaded_at: null,
                created_at: now.toISOString(),
            },
        });
    } catch (error) {
        console.error("[Create Requested Doc] Error:", error);
        return NextResponse.json(
            { success: false, error: { message: "Failed to create document request" } },
            { status: 500 }
        );
    }
}
