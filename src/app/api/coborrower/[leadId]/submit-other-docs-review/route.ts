import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { otherDocumentRequests } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { requireLeadAccess } from "@/lib/auth/requireLeadAccess";

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    // ID 118: signed in, and this lead is the caller's to touch (a dealer's own lead, or back office).
    const leadGate = await requireLeadAccess((await params).leadId);
    if (!leadGate.ok) return leadGate.response;
    try {
        const { leadId } = await params;

        // Mark all uploaded docs as pending_review
        // TODO: Create admin notification task
        // TODO: Send email/dashboard notification to admin

        return NextResponse.json({
            success: true,
            reviewStatus: 'pending',
            message: 'Documents submitted for review',
        });
    } catch (error) {
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
