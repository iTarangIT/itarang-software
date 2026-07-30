-- E-217 — Widen the live-attack taxonomy recorded in security_events.
--
-- E-216 created the table with six detectable event types. The detection layer
-- now covers a much broader set:
--
--   Payload rules  (src/lib/security/detect.ts)
--     sql_injection, xss, path_traversal, null_byte, scanner_ua,
--     sensitive_unauth, command_injection, ssrf, lfi_rfi, jndi_injection,
--     nosql_injection, crlf_injection, proto_pollution, xxe, open_redirect,
--     sensitive_file_probe, method_abuse
--
--   Volumetric / behavioural rules  (src/lib/security/rate-watch.ts)
--     rate_flood, path_enumeration, auth_bruteforce
--
-- NO structural change is required — `event_type` is varchar(32) and the longest
-- new value ('sensitive_file_probe') is 20 characters, with no CHECK constraint
-- or enum to widen. This migration therefore only:
--
--   1. refreshes the column comment so the DB documents the real taxonomy, and
--   2. adds a (event_type, occurred_at DESC) index — the volumetric rules make
--      security_events grow far faster than the payload rules alone did, and the
--      dashboard now filters by attack type.
--
-- Additive + idempotent. Re-running this file is a no-op.

DO $do$
BEGIN
  EXECUTE $c$
    COMMENT ON COLUMN "security_events"."event_type" IS
      'Payload rules: sql_injection | xss | path_traversal | null_byte | scanner_ua | sensitive_unauth | command_injection | ssrf | lfi_rfi | jndi_injection | nosql_injection | crlf_injection | proto_pollution | xxe | open_redirect | sensitive_file_probe | method_abuse. Volumetric rules: rate_flood | path_enumeration | auth_bruteforce. Legacy: burst.'
  $c$;
EXCEPTION
  WHEN undefined_table THEN RAISE NOTICE 'skip: security_events not present (apply E-216 first)';
  WHEN undefined_column THEN RAISE NOTICE 'skip: security_events.event_type not present';
END;
$do$;

DO $do$
BEGIN
  CREATE INDEX IF NOT EXISTS "security_events_type_occurred_idx"
    ON "security_events" ("event_type", "occurred_at" DESC);
EXCEPTION
  WHEN undefined_table THEN RAISE NOTICE 'skip: security_events not present (apply E-216 first)';
END;
$do$;
