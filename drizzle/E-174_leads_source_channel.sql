-- E-174 — Lead origin channel marker
--
-- Adds leads.source_channel: the channel a lead was CREATED through. Set to
-- 'whatsapp' for customer leads created by the post-approval WhatsApp dealer
-- console (src/lib/whatsapp/customer-lead.ts createCustomerLead). NULL for
-- web/other origins (both web-dealer and WhatsApp leads share
-- lead_source='dealer_referral', so lead_source can't distinguish them).
--
-- Why it's needed: the admin KYC review gate hides documents until a coupon is
-- consumed (web "Submit for Verification"). WhatsApp leads have no coupon step,
-- so this column lets the admin UI unlock documents for WhatsApp leads once the
-- consent is admin-verified — without affecting the web flow.
--
-- Additive + idempotent — safe to re-run.
-- Source of truth: this file. Mirrored in src/lib/db/schema.ts (leads).

ALTER TABLE leads ADD COLUMN IF NOT EXISTS source_channel varchar(20);
