import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { otherDocumentRequests } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

/**
 * GET — Fetch all document requests for a lead (from admin "Request More Docs")
 */
export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ leadId: string }> }
) {
    try {
        const { leadId } = await params;
        const url = new URL(_req.url);
        const docFor = url.searchParams.get("doc_for") || "primary";

        const requests = await db
            .select()
            .from(otherDocumentRequests)
            .where(
                and(
                    eq(otherDocumentRequests.lead_id, leadId),
                    eq(otherDocumentRequests.doc_for, docFor)
                )
            );

        return NextResponse.json({
            success: true,
            data: requests.map(r => ({
                id: r.id,
                doc_label: r.doc_label,
                doc_key: r.doc_key,
                doc_for: r.doc_for,
                is_required: r.is_required,
                file_url: r.file_url,
                upload_status: r.upload_status,
                rejection_reason: r.rejection_reason,
                created_at: r.created_at,
                uploaded_at: r.uploaded_at,
            })),
        });
    } catch (error) {
        console.error("[Requested Docs] Error:", error);
        return NextResponse.json(
            { success: false, error: { message: "Failed to fetch requested docs" } },
            { status: 500 }
        );
    }
}

/**
 * POST — Upload a file for a requested document
 */
export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ leadId: string }> }
) {
    try {
        const { leadId } = await params;
        const formData = await req.formData();
        const file = formData.get("file") as File | null;
        const requestId = formData.get("requestId") as string;

        if (!file || !requestId) {
            return NextResponse.json(
                { success: false, error: { message: "File and requestId are required" } },
                { status: 400 }
            );
        }

        // Find the request
        const [request] = await db
            .select()
            .from(otherDocumentRequests)
            .where(
                and(
                    eq(otherDocumentRequests.id, requestId),
                    eq(otherDocumentRequests.lead_id, leadId)
                )
            )
            .limit(1);

        if (!request) {
            return NextResponse.json(
                { success: false, error: { message: "Document request not found" } },
                { status: 404 }
            );
        }

        // Upload to Supabase storage
        const { createClient } = await import("@supabase/supabase-js");
        const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
        const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
        const bucket = (process.env.CONSENT_STORAGE_BUCKET || "documents").trim();

        const supabase = createClient(supabaseUrl, serviceKey);
        const arrayBuffer = await file.arrayBuffer();
        const storagePath = `kyc/${leadId}/requested-docs/${requestId}-${Date.now()}.${file.name.split('.').pop()}`;

        const { error: uploadError } = await supabase.storage
            .from(bucket)
            .upload(storagePath, arrayBuffer, {
                contentType: file.type,
                upsert: true,
            });

        if (uploadError) {
            console.error("[Requested Docs] Upload error:", uploadError);
            return NextResponse.json(
                { success: false, error: { message: "File upload failed" } },
                { status: 500 }
            );
        }

        const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(storagePath);
        const fileUrl = urlData?.publicUrl || "";

        // Update the request record
        await db
            .update(otherDocumentRequests)
            .set({
                file_url: fileUrl,
                upload_status: "uploaded",
                uploaded_at: new Date(),
            })
            .where(eq(otherDocumentRequests.id, requestId));

        return NextResponse.json({
            success: true,
            fileUrl,
        });
    } catch (error) {
        console.error("[Requested Docs] Upload error:", error);
        return NextResponse.json(
            { success: false, error: { message: "Failed to upload document" } },
            { status: 500 }
        );
    }
}
