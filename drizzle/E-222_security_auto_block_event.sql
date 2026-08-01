-- E-222 — Record the auto-block event type in security_events.
--
-- The live-attack layer now BANS a source IP after repeated blocked attacks
-- (src/lib/security/blocklist.ts) and writes an `ip_blocked` row when a request
-- from a banned IP is refused.
--
-- NO structural change is required — `event_type` is varchar(32), 'ip_blocked'
-- is 10 characters, and the column has no CHECK constraint or enum to widen.
-- This migration only refreshes the column comment so the database documents
-- the real taxonomy, matching what E-217 did for the volumetric rules.
--
-- The richer attacker profile that now ships with every event (source-IP
-- provenance, client fingerprint, geo, behavioural flags, ban state) lives in
-- the existing `evidence` jsonb column and needs no DDL at all.
--
-- Additive + idempotent. Re-running this file is a no-op.

DO $do$
BEGIN
  EXECUTE $c$
    COMMENT ON COLUMN "security_events"."event_type" IS
      'Payload rules: sql_injection | xss | path_traversal | null_byte | scanner_ua | sensitive_unauth | command_injection | ssrf | lfi_rfi | jndi_injection | nosql_injection | crlf_injection | proto_pollution | xxe | open_redirect | sensitive_file_probe | method_abuse. Volumetric rules: rate_flood | path_enumeration | auth_bruteforce. Auto-block: ip_blocked. Legacy: burst.'
  $c$;
EXCEPTION
  WHEN undefined_table THEN RAISE NOTICE 'skip: security_events not present (apply E-216 first)';
  WHEN undefined_column THEN RAISE NOTICE 'skip: security_events.event_type not present';
END;
$do$;

DO $do$
BEGIN
  EXECUTE $c$
    COMMENT ON COLUMN "security_events"."evidence" IS
      'Rule evidence (the matched payload) plus request context keyed by: net (source-IP provenance + proxy chain), client (sender software fingerprint), geo (CDN-reported location), request, flags (behavioural tells), ban (auto-block state), body_sample, provenance (middleware-raised vs hand-POSTed to the ingest API — decides whether ip is observed or merely claimed).'
  $c$;
EXCEPTION
  WHEN undefined_table THEN RAISE NOTICE 'skip: security_events not present (apply E-216 first)';
  WHEN undefined_column THEN RAISE NOTICE 'skip: security_events.evidence not present';
END;
$do$;
