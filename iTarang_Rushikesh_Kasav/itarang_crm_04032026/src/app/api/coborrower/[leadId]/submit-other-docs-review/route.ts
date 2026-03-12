import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { otherDocumentRequests } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
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
