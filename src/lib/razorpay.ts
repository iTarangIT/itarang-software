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

// ───────────────────────── e-Mandate (E-NACH) ──────────────────────────────
// Razorpay recurring e-mandate via Orders + Tokens. iTarang creates a customer
// and an `emandate` order; the customer authorises it through Razorpay Checkout
// (a ₹0/₹1 auth transaction); the resulting token IS the registered mandate.
// The signature-verified webhook (token.confirmed / order.paid) is the source of
// truth — see /api/payments/razorpay/emandate-webhook. Used by the NBFC E-NACH
// "iTarang Razorpay (managed)" handoff (BRD Addendum V0.2 §9, managed variant).

export interface EmandateCustomerParams {
  name: string;
  email?: string | null;
  contact?: string | null;
  notes?: Record<string, string>;
}

/**
 * Create (or reuse) a Razorpay customer for e-mandate authorisation. Razorpay
 * rejects a duplicate (same contact/email) with BAD_REQUEST_ERROR; we surface
 * the existing customer instead of failing the registration.
 */
export async function createEmandateCustomer(
  params: EmandateCustomerParams,
): Promise<{ id: string }> {
  const rzp = getRazorpay();
  try {
    const c = await rzp.customers.create({
      name: params.name || "Customer",
      email: params.email || undefined,
      contact: params.contact || undefined,
      fail_existing: 0, // return the existing customer instead of erroring
      notes: params.notes,
    } as any);
    return { id: c.id };
  } catch (e: any) {
    // Defensive: if fail_existing isn't honoured, try to recover the id.
    const existingId = e?.error?.metadata?.customer_id;
    if (existingId) return { id: existingId };
    throw e;
  }
}

export interface EmandateOrderParams {
  customerId: string;
  /** Hard ceiling per debit, in paise. Defaults to ₹1,00,00,000. */
  maxAmountPaise?: number;
  /** Auth-transaction amount in paise (0 or 100). Default 0. */
  authAmountPaise?: number;
  /** Mandate expiry as a unix epoch (seconds). Default ~10 years out. */
  expireAt?: number;
  /** Correlation ref stored in notes so the webhook can find the mandate. */
  enachRef: string;
  leadId: string;
  nbfcId: number;
  bankAccountName?: string | null;
}

export interface EmandateOrderResponse {
  order_id: string;
  amount: number;
  currency: string;
  customer_id: string;
  key_id: string;
}

/**
 * Create an `emandate` order whose authorisation registers a recurring mandate.
 * `as_presented` frequency suits variable EMI debits driven by the NBFC later
 * (Phase 2 execution is out of scope here — registration only).
 */
export async function createEmandateOrder(
  params: EmandateOrderParams,
): Promise<EmandateOrderResponse> {
  const rzp = getRazorpay();
  const order = await rzp.orders.create({
    amount: params.authAmountPaise ?? 0,
    currency: "INR",
    method: "emandate",
    customer_id: params.customerId,
    payment_capture: true,
    receipt: params.enachRef.slice(0, 40),
    notes: {
      itarang_enach_ref: params.enachRef,
      itarang_lead_id: params.leadId,
      itarang_nbfc_id: String(params.nbfcId),
    },
    token: {
      max_amount: params.maxAmountPaise ?? 100_00_00_000,
      expire_at:
        params.expireAt ?? Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600,
      frequency: "as_presented",
      ...(params.bankAccountName
        ? { bank_account: { beneficiary_name: params.bankAccountName } }
        : {}),
    },
  } as any);
  return {
    order_id: order.id,
    amount: Number(order.amount) || 0,
    currency: order.currency || "INR",
    customer_id: params.customerId,
    key_id: process.env.RAZORPAY_KEY_ID || "",
  };
}

/** Fetch a registered token (reconciliation fallback when a webhook is missed). */
export async function fetchEmandateToken(customerId: string, tokenId: string) {
  return getRazorpay().customers.fetchToken(customerId, tokenId);
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
