import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { consentRecords, leads } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const { leadId } = await params;
        const { channel } = await req.json(); // 'sms' or 'whatsapp'

        const lead = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
        if (!lead.length) {
            return NextResponse.json({ success: false, error: { message: 'Lead not found' } }, { status: 404 });
        }

        const phone = lead[0].phone || lead[0].owner_contact;
        if (!phone) {
            return NextResponse.json({ success: false, error: { message: 'No phone number available' } }, { status: 400 });
        }

        // Generate consent token
        const token = crypto.randomBytes(32).toString('hex');
        const consentLink = `${process.env.NEXT_PUBLIC_APP_URL || 'https://tarang.com'}/consent/${leadId}/${token}`;

        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
        const seq = Math.floor(Math.random() * 10000).toString().padStart(4, '0');

        // Create consent record
        await db.insert(consentRecords).values({
            id: `CONSENT-${dateStr}-${seq}`,
            lead_id: leadId,
            consent_for: 'primary',
            consent_type: channel,
            consent_status: 'link_sent',
            consent_token: token,
            consent_link_url: consentLink,
            consent_link_sent_at: now,
            created_at: now,
            updated_at: now,
        });

        // Update lead consent status
        await db.update(leads)
            .set({ consent_status: 'link_sent', updated_at: now })
            .where(eq(leads.id, leadId));

        // TODO: Integrate with Twilio/WhatsApp API to actually send the message
        // SMS: `Complete your loan consent: ${consentLink}. Valid for 24 hours. -iTarang`

        return NextResponse.json({
            success: true,
            sentAt: now.toISOString(),
            channel,
        });
    } catch (error) {
        console.error('[Send Consent] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
