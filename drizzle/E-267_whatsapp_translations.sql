-- E-267 — WhatsApp outbound translation cache.
--
-- Backs src/lib/whatsapp/translate.ts. Every bot message is authored in English
-- inline in the flow code; when the admin picks Hindi / Hinglish at
-- /admin/settings/whatsapp/language, the translating adapter localises the
-- RENDERED string at send time via Gemini and stores the result here, keyed by
-- sha256(kind + "\n" + english_text) + language, so each distinct string is
-- translated once per process fleet rather than once per process.
--
-- NOT required for the code to run: every read/write of this table is guarded
-- and an unapplied environment degrades to an in-memory cache with one warning.
-- The admin setting itself lives in app_settings (key `whatsapp_language`) and
-- needs no migration.
--
-- Additive, idempotent; re-running is a no-op.

CREATE TABLE IF NOT EXISTS whatsapp_translations (
  id              bigserial PRIMARY KEY,
  source_hash     varchar(64)  NOT NULL,
  language        varchar(16)  NOT NULL,           -- 'hindi' | 'hinglish'
  kind            varchar(16)  NOT NULL,           -- body | button | row_title | row_desc | list_button | caption
  source_text     text         NOT NULL,
  translated_text text         NOT NULL,
  model           varchar(64),
  hit_count       integer      NOT NULL DEFAULT 0,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  last_used_at    timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_translations_hash_lang_uidx
  ON whatsapp_translations (source_hash, language);

COMMENT ON TABLE whatsapp_translations IS
  'E-267: Gemini translation cache for outbound WhatsApp bot copy (English source → chosen language). Safe to truncate; entries are re-created on demand.';
