-- Facilitation fee payment tracking for finance leads
CREATE TABLE IF NOT EXISTS facilitation_payments (
    id VARCHAR(255) PRIMARY KEY,
    lead_id VARCHAR(255) NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    payment_method VARCHAR(30),

    -- Fee calculation
    facilitation_fee_base_amount DECIMAL(10, 2) NOT NULL DEFAULT 1500.00,
    coupon_code VARCHAR(50),
    coupon_id VARCHAR(255),
    coupon_discount_type VARCHAR(20), -- flat, percentage
    coupon_discount_value DECIMAL(10, 2),
    coupon_discount_amount DECIMAL(10, 2) DEFAULT 0,
    facilitation_fee_final_amount DECIMAL(10, 2) NOT NULL,

    -- Razorpay QR
    razorpay_qr_id VARCHAR(255),
    razorpay_qr_status VARCHAR(30), -- active, closed, expired
    razorpay_qr_image_url TEXT,
    razorpay_qr_short_url TEXT,
    razorpay_qr_expires_at TIMESTAMPTZ,

    -- Payment
    razorpay_payment_id VARCHAR(255),
    razorpay_order_id VARCHAR(255),
    razorpay_payment_status VARCHAR(30),
    utr_number_manual VARCHAR(100),
    payment_screenshot_url TEXT,

    -- Status
    facilitation_fee_status VARCHAR(30) NOT NULL DEFAULT 'UNPAID',
    -- UNPAID, QR_GENERATED, PAYMENT_PENDING_CONFIRMATION, PAID, FAILED, EXPIRED

    -- Timestamps
    payment_paid_at TIMESTAMPTZ,
    payment_verified_at TIMESTAMPTZ,
    payment_verification_source VARCHAR(30), -- webhook, poll, manual

    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS facilitation_payments_lead_id_idx ON facilitation_payments(lead_id);
CREATE INDEX IF NOT EXISTS facilitation_payments_status_idx ON facilitation_payments(facilitation_fee_status);
CREATE INDEX IF NOT EXISTS facilitation_payments_rzp_qr_idx ON facilitation_payments(razorpay_qr_id);

-- Add discount fields to coupon_codes table
ALTER TABLE coupon_codes ADD COLUMN IF NOT EXISTS discount_type VARCHAR(20) DEFAULT 'flat';
ALTER TABLE coupon_codes ADD COLUMN IF NOT EXISTS discount_value DECIMAL(10, 2) DEFAULT 0;
ALTER TABLE coupon_codes ADD COLUMN IF NOT EXISTS max_discount_cap DECIMAL(10, 2);
ALTER TABLE coupon_codes ADD COLUMN IF NOT EXISTS min_amount DECIMAL(10, 2);
