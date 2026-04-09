import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { couponBatches, couponCodes, accounts } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { requireRole } from '@/lib/auth-utils';
import { z } from 'zod';

const createBatchSchema = z.object({
    dealer_id: z.string().min(1),
    batch_name: z.string().min(3).max(200),
    count: z.number().int().min(1).max(10000),
    prefix: z.string().min(2).max(10).regex(/^[A-Z0-9-]+$/i).optional(),
    coupon_value: z.number().min(0).default(0),
    discount_type: z.enum(['flat', 'percentage']).default('flat'),
    expiry_date: z.string().optional(), // ISO date
});

function generatePrefix(dealerCode: string): string {
    return dealerCode.replace(/[^A-Z0-9]/gi, '').slice(-6).toUpperCase() || 'COUPON';
}

export async function POST(req: NextRequest) {
    try {
        const user = await requireRole(['admin', 'ceo', 'business_head']);
        const body = await req.json();
        const result = createBatchSchema.safeParse(body);

        if (!result.success) {
            return NextResponse.json({
                success: false,
                error: { message: 'Validation failed', details: result.error.issues },
            }, { status: 400 });
        }

        const data = result.data;

        // Verify dealer exists
        const dealerRows = await db.select({ id: accounts.id })
            .from(accounts).where(eq(accounts.id, data.dealer_id)).limit(1);

        if (!dealerRows.length) {
            return NextResponse.json({ success: false, error: { message: 'Dealer not found' } }, { status: 404 });
        }

        const prefix = data.prefix?.toUpperCase() || generatePrefix(data.dealer_id);
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
        const seq = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
        const batchId = `BATCH-${dateStr}-${seq}`;

        const expiryDate = data.expiry_date ? new Date(data.expiry_date) : null;

        // Create batch
        await db.insert(couponBatches).values({
            id: batchId,
            name: data.batch_name,
            dealer_id: data.dealer_id,
            prefix,
            coupon_value: String(data.coupon_value),
            total_quantity: data.count,
            expiry_date: expiryDate,
            status: 'active',
            created_by: user.id,
            created_at: now,
            updated_at: now,
        });

        // Generate coupon codes
        const coupons = [];
        for (let i = 1; i <= data.count; i++) {
            const seqStr = i.toString().padStart(4, '0');
            const code = `${prefix}-${seqStr}`;
            const couponId = `COUPON-${batchId.slice(6)}-${seqStr}`;

            coupons.push({
                id: couponId,
                code,
                batch_id: batchId,
                dealer_id: data.dealer_id,
                status: 'available' as const,
                credits_available: 1,
                discount_type: data.discount_type,
                discount_value: String(data.coupon_value),
                expires_at: expiryDate,
                created_at: now,
            });
        }

        // Bulk insert in chunks of 100
        for (let i = 0; i < coupons.length; i += 100) {
            await db.insert(couponCodes).values(coupons.slice(i, i + 100));
        }

        return NextResponse.json({
            success: true,
            data: {
                batchId,
                prefix,
                totalCoupons: data.count,
                expiryDate: expiryDate?.toISOString() || null,
                sampleCodes: coupons.slice(0, 3).map(c => c.code),
            },
            message: `Batch created with ${data.count} coupons`,
        });
    } catch (error: any) {
        console.error('[Create Batch] Error:', error);
        if (error?.code === '23505') {
            return NextResponse.json({ success: false, error: { message: 'Duplicate coupon codes detected. Try a different prefix.' } }, { status: 409 });
        }
        return NextResponse.json({ success: false, error: { message: error?.message || 'Server error' } }, { status: 500 });
    }
}
