import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { facilitationPayments } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { verifyWebhookSignature } from '@/lib/razorpay';
import { confirmRefurbPaymentFromWebhook } from '@/lib/nbfc/recovery/refurb-payments';

export async function POST(req: NextRequest) {
    try {
        const body = await req.text();
        const signature = req.headers.get('x-razorpay-signature');

        if (!signature) {
            return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
        }

        // Verify webhook signature
        try {
            const isValid = verifyWebhookSignature(body, signature);
            if (!isValid) {
                console.error('[Razorpay Webhook] Invalid signature');
                return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
            }
        } catch {
            console.error('[Razorpay Webhook] Signature verification failed');
            return NextResponse.json({ error: 'Signature verification failed' }, { status: 401 });
        }

        const event = JSON.parse(body);
        const eventType = event.event;

        // [E-271] Refurbishment-lot advance / balance paid through Checkout.
        // Routed on the order's notes (same purpose-keying as wallet-webhook),
        // so a closed browser tab still confirms the money. Idempotent.
        if (eventType === 'payment.captured' || eventType === 'order.paid') {
            const pay = event.payload?.payment?.entity;
            const purpose = String(pay?.notes?.itarang_purpose ?? '');
            if (purpose === 'refurb_advance' || purpose === 'refurb_balance') {
                const result = await confirmRefurbPaymentFromWebhook({
                    lot_id: String(pay.notes.lot_id ?? ''),
                    leg: purpose === 'refurb_advance' ? 'advance' : 'balance',
                    order_id: String(pay.order_id ?? ''),
                    payment_id: String(pay.id ?? ''),
                    amount_paise: Number(pay.amount ?? 0),
                });
                return NextResponse.json({ status: result, purpose });
            }
        }

        // Handle QR code payment events
        if (eventType === 'qr_code.credited') {
            const qrEntity = event.payload?.qr_code?.entity;
            const paymentEntity = event.payload?.payment?.entity;

            if (!qrEntity?.id) {
                return NextResponse.json({ status: 'ignored', reason: 'no qr_code id' });
            }

            // Find facilitation payment by QR ID
            const rows = await db.select()
                .from(facilitationPayments)
                .where(eq(facilitationPayments.razorpay_qr_id, qrEntity.id))
                .limit(1);

            if (!rows.length) {
                console.warn(`[Razorpay Webhook] No payment found for QR ${qrEntity.id}`);
                return NextResponse.json({ status: 'ignored', reason: 'no matching payment record' });
            }

            const payment = rows[0];

            // Don't overwrite if already PAID
            if (payment.facilitation_fee_status === 'PAID') {
                return NextResponse.json({ status: 'already_processed' });
            }

            // Update payment as PAID
            await db.update(facilitationPayments)
                .set({
                    facilitation_fee_status: 'PAID',
                    razorpay_payment_id: paymentEntity?.id || null,
                    razorpay_payment_status: paymentEntity?.status || 'captured',
                    razorpay_qr_status: qrEntity.status || 'closed',
                    payment_paid_at: new Date(),
                    payment_verified_at: new Date(),
                    payment_verification_source: 'webhook',
                    updated_at: new Date(),
                })
                .where(eq(facilitationPayments.id, payment.id));

            console.log(`[Razorpay Webhook] Payment ${payment.id} marked as PAID via webhook`);
            return NextResponse.json({ status: 'ok', payment_id: payment.id });
        }

        if (eventType === 'qr_code.closed') {
            const qrEntity = event.payload?.qr_code?.entity;
            if (qrEntity?.id) {
                await db.update(facilitationPayments)
                    .set({
                        razorpay_qr_status: 'closed',
                        updated_at: new Date(),
                    })
                    .where(eq(facilitationPayments.razorpay_qr_id, qrEntity.id));
            }
            return NextResponse.json({ status: 'ok' });
        }

        // Acknowledge unhandled events
        return NextResponse.json({ status: 'ignored', event: eventType });
    } catch (error) {
        console.error('[Razorpay Webhook] Error:', error);
        return NextResponse.json({ error: 'Internal error' }, { status: 500 });
    }
}
