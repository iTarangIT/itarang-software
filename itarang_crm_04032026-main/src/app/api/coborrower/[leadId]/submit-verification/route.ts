import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { kycVerifications } from '@/lib/db/schema';

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const { leadId } = await params;

        const verificationTypes = ['aadhaar', 'pan', 'bank', 'address', 'mobile'];
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');

        const verifications = [];
        for (const type of verificationTypes) {
            const seq = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
            await db.insert(kycVerifications).values({
                id: `KYCVER-COB-${dateStr}-${seq}`,
                lead_id: leadId,
                verification_type: `coborrower_${type}`,
                status: 'initiating',
                api_provider: 'decentro',
                submitted_at: now,
                created_at: now,
                updated_at: now,
            });

            verifications.push({
                type: `coborrower_${type}`,
                label: `Co-Borrower ${type.charAt(0).toUpperCase() + type.slice(1)} Verification`,
                status: 'initiating',
                last_update: now.toISOString(),
                failed_reason: null,
            });
        }

        // TODO: Trigger actual third-party API calls

        return NextResponse.json({
            success: true,
            verificationsInitiated: verificationTypes.length,
            verifications,
        });
    } catch (error) {
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
