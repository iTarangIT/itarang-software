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

const onlyDigits10 = (s?: string | null) => (s || "").replace(/\D/g, "").slice(-10);

/**
 * Find an existing Razorpay customer by contact (or email). Used to recover the
 * id of a customer orphaned by a prior failed registration, when Razorpay's
 * duplicate error doesn't carry `metadata.customer_id`. Scans the most recent
 * page of customers (fallback-only path, so the unfiltered list is acceptable).
 */
async function findCustomerByContactOrEmail(
  contact?: string | null,
  email?: string | null,
): Promise<string | null> {
  const rzp = getRazorpay();
  const list = (await rzp.customers.all({ count: 100 })) as unknown as {
    items?: Array<{ id: string; contact?: string; email?: string }>;
  };
  const items = list?.items ?? [];
  const wantContact = onlyDigits10(contact);
  const wantEmail = (email || "").trim().toLowerCase();
  const match = items.find(
    (it) =>
      (wantContact && onlyDigits10(it.contact) === wantContact) ||
      (wantEmail && (it.email || "").trim().toLowerCase() === wantEmail),
  );
  return match?.id ?? null;
}

/**
 * Create (or reuse) a Razorpay customer for e-mandate authorisation. Razorpay
 * rejects a duplicate (same contact/email) with BAD_REQUEST_ERROR; we surface
 * the existing customer instead of failing the registration — first from the
 * error metadata, then (if absent) by looking the customer up by contact/email.
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
    // 1) Recover the id from the duplicate-error metadata (shape varies by SDK).
    const metaId =
      e?.error?.metadata?.customer_id ?? e?.metadata?.customer_id ?? null;
    if (metaId) return { id: metaId };
    // 2) Only on an "already exists" error, look the customer up directly. This
    //    rescues a customer orphaned by an earlier registration that failed at
    //    the order step (so no mandate row stored its id).
    const desc: string = e?.error?.description ?? e?.description ?? "";
    if (/already exists/i.test(desc)) {
      const found = await findCustomerByContactOrEmail(
        params.contact,
        params.email,
      ).catch(() => null);
      if (found) return { id: found };
    }
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
  /**
   * Mandate authorisation rail. Razorpay REQUIRES auth_type in the token block
   * for e-mandate orders; 'netbanking' has the broadest bank coverage and is the
   * most reliable in test mode (the customer picks their bank in Checkout).
   */
  authType?: "netbanking" | "debitcard" | "aadhaar";
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
      // auth_type is MANDATORY for an e-mandate order — omitting it makes
      // Razorpay reject the order with a 400. The customer chooses the actual
      // bank inside Checkout; we do NOT send a (partial) bank_account block,
      // since Razorpay requires the full account block if any is present.
      auth_type: params.authType ?? "netbanking",
      max_amount: params.maxAmountPaise ?? 100_00_00_000,
      expire_at:
        params.expireAt ?? Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600,
      frequency: "as_presented",
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

/** Fetch a payment — used by the confirm endpoint to read the registered
 *  token_id / bank details right after Checkout, without waiting for the
 *  (localhost-unreachable) webhook. */
export async function fetchPayment(paymentId: string) {
  return getRazorpay().payments.fetch(paymentId) as Promise<Record<string, any>>;
}

/**
 * Unwraps a Razorpay SDK rejection into a human-readable string. The SDK rejects
 * with a plain object `{ statusCode, error: { code, description, … } }` — NOT an
 * Error — so `String(err)` yields the useless "[object Object]". Prefer the
 * provider's `error.description`, then a nested message, then a JSON fallback.
 */
export function razorpayErrorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { error?: { description?: string; reason?: string }; message?: string };
    if (e.error?.description) return e.error.description;
    if (e.error?.reason) return e.error.reason;
    if (e.message) return e.message;
    try {
      return JSON.stringify(err);
    } catch {
      /* fall through */
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Verifies a Razorpay Checkout payment signature: HMAC-SHA256 of
 * `order_id|payment_id` keyed by RAZORPAY_KEY_SECRET (Razorpay's standard
 * client-handoff verification). Used by the server-verified confirm endpoint so
 * a registered mandate is never trusted on the client's word alone.
 */
export function verifyPaymentSignature(
  orderId: string,
  paymentId: string,
  signature: string,
  secret?: string,
): boolean {
  const keySecret = secret || process.env.RAZORPAY_KEY_SECRET!;
  const expected = crypto
    .createHmac("sha256", keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature || "");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
