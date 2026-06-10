-- E-163 — Per-NBFC Notification Channels (BRD Addendum V0.3.1 §15.5).
--
-- Additive + NON-BREAKING. Each NBFC may connect its own Email (SMTP) / SMS /
-- WhatsApp gateway. The channel RESOLVER (src/lib/notifications/resolve-channel.ts)
-- falls back to the platform-global env transport whenever a tenant has no row
-- or leaves a channel on 'itarang_default' — so every existing send keeps using
-- the global gateway exactly as before until an NBFC opts in.
--
-- v1 note: gateway secrets are stored as-is; column-level encryption is a
-- backlog hardening item (tracked in the Phase-2 plan), not a v1 blocker.

CREATE TABLE IF NOT EXISTS nbfc_notification_channels (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES nbfc_tenants(id),

  -- Email
  email_mode      varchar(16) NOT NULL DEFAULT 'itarang_default', -- itarang_default | own_smtp
  email_from      text,
  email_from_name text,
  smtp_host       text,
  smtp_port       integer,
  smtp_user       text,
  smtp_pass       text,
  smtp_secure     boolean NOT NULL DEFAULT false,

  -- SMS
  sms_provider    varchar(24) NOT NULL DEFAULT 'itarang_default', -- itarang_default | gupshup | decentro
  sms_api_key     text,
  sms_source      text,                                            -- sender id / source number
  sms_dlt_template_id text,

  -- WhatsApp
  whatsapp_enabled  boolean NOT NULL DEFAULT false,
  whatsapp_provider varchar(24),                                   -- gupshup | cloud_api | ...
  whatsapp_waba_id  text,
  whatsapp_api_key  text,
  whatsapp_from     text,
  whatsapp_templates jsonb,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS nbfc_notification_channels_tenant_unique
  ON nbfc_notification_channels (tenant_id);

COMMENT ON TABLE nbfc_notification_channels IS
  'Per-NBFC Email/SMS/WhatsApp gateway config (E-163, §15.5). Absent row or *_default mode ⇒ platform-global env gateway.';
