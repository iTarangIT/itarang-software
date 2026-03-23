import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { consentRecords, coBorrowers } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const { leadId } = await params;
        const { channel } = await req.json();

        const cob = await db.select().from(coBorrowers).where(eq(coBorrowers.lead_id, leadId)).limit(1);
        if (!cob.length) {
            return NextResponse.json({ success: false, error: { message: 'Co-borrower not found' } }, { status: 404 });
        }

        const token = crypto.randomBytes(32).toString('hex');
        const consentLink = `${process.env.NEXT_PUBLIC_APP_URL || 'https://tarang.com'}/coborrowerconsent/${leadId}/${token}`;

        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
        const seq = Math.floor(Math.random() * 10000).toString().padStart(4, '0');

        await db.insert(consentRecords).values({
            id: `CONSENT-${dateStr}-${seq}`,
            lead_id: leadId,
            consent_for: 'co_borrower',
            consent_type: channel,
            consent_status: 'link_sent',
            consent_token: token,
            consent_link_url: consentLink,
            consent_link_sent_at: now,
            created_at: now,
            updated_at: now,
        });

        // TODO: Send actual SMS/WhatsApp via Twilio

        return NextResponse.json({ success: true, sentAt: now.toISOString() });
    } catch (error) {
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
