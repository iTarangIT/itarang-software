import { db } from '@/lib/db';
import { couponAuditLog } from '@/lib/db/schema';

type CouponAction = 'created' | 'allocated' | 'reserved' | 'released' | 'used' | 'expired' | 'revoked';

interface LogCouponActionParams {
    couponId: string;
    action: CouponAction;
    oldStatus?: string | null;
    newStatus?: string | null;
    leadId?: string | null;
    performedBy?: string | null;
    ipAddress?: string | null;
    notes?: string | null;
}

export async function logCouponAction(params: LogCouponActionParams): Promise<void> {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const seq = Math.floor(Math.random() * 100000).toString().padStart(5, '0');
    const id = `CAUDIT-${dateStr}-${seq}`;

    try {
        await db.insert(couponAuditLog).values({
            id,
            coupon_id: params.couponId,
            action: params.action,
            old_status: params.oldStatus ?? null,
            new_status: params.newStatus ?? null,
            lead_id: params.leadId ?? null,
            performed_by: params.performedBy ?? null,
            ip_address: params.ipAddress ?? null,
            notes: params.notes ?? null,
            created_at: now,
        });
    } catch (error) {
        console.error('[CouponAudit] Failed to log action:', error);
    }
}

export async function logCouponActionsBulk(entries: LogCouponActionParams[]): Promise<void> {
    if (!entries.length) return;

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');

    const values = entries.map((params, i) => {
        const seq = (Math.floor(Math.random() * 100000) + i).toString().padStart(5, '0');
        return {
            id: `CAUDIT-${dateStr}-${seq}`,
            coupon_id: params.couponId,
            action: params.action,
            old_status: params.oldStatus ?? null,
            new_status: params.newStatus ?? null,
            lead_id: params.leadId ?? null,
            performed_by: params.performedBy ?? null,
            ip_address: params.ipAddress ?? null,
            notes: params.notes ?? null,
            created_at: now,
        };
    });

    try {
        for (let i = 0; i < values.length; i += 100) {
            await db.insert(couponAuditLog).values(values.slice(i, i + 100));
        }
    } catch (error) {
        console.error('[CouponAudit] Failed to bulk log actions:', error);
    }
}
