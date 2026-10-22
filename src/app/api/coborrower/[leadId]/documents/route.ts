import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { coBorrowerDocuments } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { requireLeadAccess } from "@/lib/auth/requireLeadAccess";
import { dealerViewableFiles } from "@/lib/storage/fileAuthz";

export async function GET(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    // ID 118: signed in, and this lead is the caller's to touch (a dealer's own lead, or back office).
    // ID 166: read-only list, so the dealer account's owner (ISR / ASM) reads it too.
    const leadGate = await requireLeadAccess((await params).leadId, { read: true });
    if (!leadGate.ok) return leadGate.response;
    try {
        const { leadId } = await params;
        const docs = await db.select().from(coBorrowerDocuments).where(eq(coBorrowerDocuments.lead_id, leadId));
        // ID 166 item 12: mark the files a dealer may not open (not its own upload).
        const viewable = await dealerViewableFiles(leadGate.user, leadId, docs.map((d) => d.document_url));
        return NextResponse.json({
            success: true,
            data: docs.map((d) => ({ ...d, file_viewable: viewable(d.document_url) })),
        });
    } catch (error) {
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
