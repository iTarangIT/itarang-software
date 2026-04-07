import Razorpay from 'razorpay';
import crypto from 'crypto';

let _razorpay: Razorpay | null = null;

function getRazorpay(): Razorpay {
    if (!_razorpay) {
        _razorpay = new Razorpay({
            key_id: process.env.RAZORPAY_KEY_ID!,
            key_secret: process.env.RAZORPAY_KEY_SECRET!,
        });
    }
    return _razorpay;
}

export interface CreateQrParams {
    amount: number; // in rupees (will be converted to paise)
    leadId: string;
    customerName: string;
    description?: string;
    expiresInMinutes?: number;
}

export interface QrCodeResponse {
    id: string;
    image_url: string;
    short_url: string;
    status: string;
    close_by: number;
    amount: number;
}

/**
 * Create a Razorpay UPI QR code for facilitation fee payment
 */
export async function createPaymentQr(params: CreateQrParams): Promise<QrCodeResponse> {
    const {
        amount,
        leadId,
        customerName,
        description = 'Facilitation Fee Payment',
        expiresInMinutes = 30,
    } = params;

    const amountInPaise = Math.round(amount * 100);
    const closeBy = Math.floor(Date.now() / 1000) + expiresInMinutes * 60;

    const qr = await getRazorpay().qrCode.create({
        type: 'upi_qr',
        name: customerName,
        usage: 'single_use',
        fixed_amount: true,
        payment_amount: amountInPaise,
        description,
        close_by: closeBy,
        notes: {
            lead_id: leadId,
            purpose: 'facilitation_fee',
        },
    });

    return {
        id: qr.id,
        image_url: qr.image_url,
        short_url: (qr as any).short_url || '',
        status: qr.status,
        close_by: qr.close_by ?? closeBy,
        amount: amountInPaise,
    };
}

/**
 * Fetch QR code status from Razorpay
 */
export async function fetchQrStatus(qrId: string) {
    return getRazorpay().qrCode.fetch(qrId);
}

/**
 * Close/expire a QR code
 */
export async function closeQrCode(qrId: string) {
    return getRazorpay().qrCode.close(qrId);
}

/**
 * Fetch payments received on a QR code
 */
export async function fetchQrPayments(qrId: string) {
    return getRazorpay().qrCode.fetchAllPayments(qrId, {});
}

/**
 * Verify Razorpay webhook signature
 */
export function verifyWebhookSignature(
    body: string,
    signature: string,
    secret?: string
): boolean {
    const webhookSecret = secret || process.env.RAZORPAY_WEBHOOK_SECRET!;
    const expectedSignature = crypto
        .createHmac('sha256', webhookSecret)
        .update(body)
        .digest('hex');
    return crypto.timingSafeEqual(
        Buffer.from(expectedSignature),
        Buffer.from(signature)
    );
}

/**
 * Calculate discount amount from coupon
 */
export function calculateDiscount(
    baseAmount: number,
    discountType: string | null,
    discountValue: number | null,
    maxDiscountCap: number | null
): number {
    if (!discountType || !discountValue) return 0;

    let discount = 0;
    if (discountType === 'flat') {
        discount = discountValue;
    } else if (discountType === 'percentage') {
        discount = (baseAmount * discountValue) / 100;
        if (maxDiscountCap && discount > maxDiscountCap) {
            discount = maxDiscountCap;
        }
    }

    return Math.min(discount, baseAmount);
}

export default getRazorpay;
