-- E-171 — Multi-org Zoho invoice sync (add Delhi entity).
--
-- The Zoho login behind the invoice sync owns TWO organizations, both named
-- "ITARANG TECHNOLOGIES LLP":
--   * 60060919257 — Haryana (the only org synced until now)
--   * 60064046518 — Delhi   (newly added)
--
-- The hourly sync now pulls invoices from every configured org into the single
-- zoho_invoices table, so the CEO dashboard totals are company-wide. This adds
-- an organization_id tag per row so we can tell which entity an invoice came
-- from (and break totals down by entity later if needed).
--
-- Additive only; safe to re-run. Zoho invoice_id is globally unique across a
-- login's orgs, so the existing unique index on zoho_invoice_id still holds.

ALTER TABLE "zoho_invoices"
    ADD COLUMN IF NOT EXISTS "organization_id" varchar(64);

CREATE INDEX IF NOT EXISTS "zoho_invoices_organization_id_idx"
    ON "zoho_invoices" ("organization_id");
