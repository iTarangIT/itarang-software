-- E-170: Backfill stored Supabase public URLs -> authenticated /api/files proxy paths.
--
-- Part of the Supabase Storage -> AWS S3 migration. After STORAGE_BACKEND=s3,
-- new uploads store "/api/files/<bucket>/<key>" (served by src/app/api/files/...).
-- This rewrites the EXISTING absolute Supabase URLs in database-2 so old docs
-- also resolve from S3 instead of Supabase.
--
-- Transform (host-agnostic, so it works against any project's URLs):
--   https://<anything>/storage/v1/object/public/<rest>   ->   /api/files/<rest>
-- All 12 URL-bearing columns point at general buckets (documents,
-- dealer-documents, call-recordings); none hold nbfc-documents URLs (those
-- already use /nbfc-uploads/...), so no nbfc special-case is needed.
--
-- IDEMPOTENT: the WHERE guard matches only rows still containing the Supabase
-- prefix, so re-running is a no-op. SAFE/ADDITIVE: no schema change, only
-- in-place URL string rewrites. The S3 objects these point to were already
-- copied (scripts/copy-manifest-to-s3.mjs), so the new paths resolve.
--
-- EXCLUDED on purpose (still reference Supabase; served via the proxy's
-- Supabase fallback / not rendered as document links):
--   * dealer_onboarding_applications.provider_raw_response (verbatim provider audit blob)
--   * leads.kyc_draft_data (transient in-progress draft state)
--
-- ROLLBACK: snapshot the affected columns first (scripts/_snapshot-url-columns.mjs);
-- the transform is not cleanly reversible (original host is dropped).
--
-- Each statement is wrapped so a missing table/column on a divergent DB is
-- skipped rather than aborting the whole migration.

DO $do$
DECLARE
  -- table, column, is_jsonb
  r RECORD;
  targets TEXT[][] := ARRAY[
    ARRAY['ai_call_logs',                 'recording_url',       'f'],
    ARRAY['consent_records',              'generated_pdf_url',   'f'],
    ARRAY['consent_records',              'signed_consent_url',  'f'],
    ARRAY['dealer_onboarding_applications','signed_agreement_url','f'],
    ARRAY['dealer_onboarding_applications','audit_trail_url',    'f'],
    ARRAY['dealer_onboarding_documents',  'file_url',            'f'],
    ARRAY['kyc_documents',                'file_url',            'f'],
    ARRAY['other_document_requests',      'file_url',            'f'],
    ARRAY['product_selections',           'battery_photo_urls',  't'],
    ARRAY['product_selections',           'charger_photo_urls',  't']
  ];
  t TEXT; c TEXT; is_json BOOLEAN;
  i INT;
BEGIN
  FOR i IN 1 .. array_length(targets, 1) LOOP
    t := targets[i][1]; c := targets[i][2]; is_json := targets[i][3] = 't';
    BEGIN
      IF is_json THEN
        EXECUTE format(
          'UPDATE %I SET %I = regexp_replace(%I::text, ''https?://[^/]+/storage/v1/object/public/'', ''/api/files/'', ''g'')::jsonb
             WHERE %I::text LIKE ''%%/storage/v1/object/public/%%''', t, c, c, c);
      ELSE
        EXECUTE format(
          'UPDATE %I SET %I = regexp_replace(%I, ''https?://[^/]+/storage/v1/object/public/'', ''/api/files/'', ''g'')
             WHERE %I LIKE ''%%/storage/v1/object/public/%%''', t, c, c, c);
      END IF;
      RAISE NOTICE 'backfilled %.%', t, c;
    EXCEPTION
      WHEN undefined_table OR undefined_column THEN
        RAISE NOTICE 'skip %.% (missing on this DB)', t, c;
    END;
  END LOOP;
END
$do$;
