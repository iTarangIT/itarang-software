-- =============================================================================
-- E-327 — DEALER ONBOARDING: one "last real action" date (tracker ID 122, 2026-10-05)
-- =============================================================================
-- WHY. Onboarding "stalled" (7 days waiting on the dealer / 2 working days on
-- us) and the 21-day drop-out review count from
--     COALESCE(last_action_at, updated_at)
-- and that clock was wrong in both directions:
--   * last_action_at was written ONCE — when an application is created from a
--     converted lead (fromConvertedLead.ts) — and never again. Those dealers
--     showed stalled at day 7 and reached drop-out at day 21 however active
--     they were.
--   * every other application fell back to updated_at, which the 15-minute
--     agreement sweep rewrote on every check. A dealer waiting to sign never
--     showed stalled and never reached drop-out.
--
-- WHAT CHANGED (additive: one column, three triggers).
--
--   dealer_onboarding_applications.agreement_last_checked_at  timestamptz
--     The sweep's own "last checked" marker (autoRefreshSweep.ts). Not in
--     schema.ts on purpose — read and written through raw SQL, so code that
--     runs against a database without this file keeps working.
--
--   trigger dealer_onboarding_last_action (BEFORE INSERT OR UPDATE)
--     Keeps last_action_at at the last write that changed something a PERSON
--     changes: details, documents, status, review, correction, agreement sent
--     or signed, approval. Bookkeeping does not count — the columns in
--     `ignored` below: timestamps of the row itself, the sweep's marker, the
--     provider's raw payload and signing link, cached PDF links, stamp ids,
--     the WhatsApp session pointer and the lead link. An agreement that merely
--     EXPIRED is the clock running out, not an action.
--     A caller that sets last_action_at itself is left alone.
--     A DB trigger rather than app code, for the same reason as E-304: some
--     forty statements across the admin routes, the wizard and the WhatsApp
--     flows write this table, and a clock that depends on every one of them
--     remembering is how it broke.
--
--   trigger dealer_onboarding_documents_last_action (AFTER INSERT)
--     An uploaded document is an action on its application. The dealer's
--     correction link and the admin upload write only this table.
--
--   trigger dealer_correction_rounds_last_action (AFTER UPDATE)
--     A correction round the dealer submits is an action.
--
-- The readers are unchanged (src/lib/onboarding/clock.ts). E-328 recomputes
-- last_action_at for existing rows; apply it right after this file.
--
-- last_action_at is `timestamp` (no zone) holding UTC, as the application
-- writes it; the triggers write UTC explicitly so a session in another time
-- zone cannot skew the clock.
--
-- Safe in either order: old code on a new DB works (the triggers only maintain
-- a column the old code already reads), and new code on an old DB behaves as
-- before. DDL: additive + idempotent. Re-running is a no-op.
-- =============================================================================

DO $do$
BEGIN
    ALTER TABLE dealer_onboarding_applications
        ADD COLUMN IF NOT EXISTS agreement_last_checked_at timestamptz;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: dealer_onboarding_applications does not exist';
END;
$do$;

CREATE OR REPLACE FUNCTION dealer_onboarding_last_action_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
    ignored text[] := ARRAY[
        'updated_at', 'last_action_timestamp', 'last_action_at', 'last_action_by',
        'agreement_last_checked_at',
        'provider_raw_response', 'provider_signing_url',
        'signed_agreement_url', 'signed_agreement_storage_path',
        'audit_trail_url', 'audit_trail_storage_path',
        'stamp_certificate_ids', 'stamp_status',
        'agreement_failed_at',
        'wa_session_id', 'originating_dealer_lead_id'
    ];
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.last_action_at := COALESCE(NEW.last_action_at, (now() AT TIME ZONE 'UTC'));
        RETURN NEW;
    END IF;

    -- The caller set it explicitly (E-328, a document upload, a correction).
    IF NEW.last_action_at IS DISTINCT FROM OLD.last_action_at THEN
        RETURN NEW;
    END IF;

    -- An agreement expiring is time passing, not somebody acting.
    IF lower(COALESCE(NEW.agreement_status, '')) = 'expired'
       AND NEW.agreement_status IS DISTINCT FROM OLD.agreement_status THEN
        ignored := ignored || ARRAY[
            'agreement_status', 'agreement_expired_at', 'review_status', 'completion_status'
        ];
    END IF;

    IF (to_jsonb(NEW) - ignored) IS DISTINCT FROM (to_jsonb(OLD) - ignored) THEN
        NEW.last_action_at := (now() AT TIME ZONE 'UTC');
    END IF;
    RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION dealer_onboarding_child_last_action_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
    IF TG_TABLE_NAME = 'dealer_correction_rounds' THEN
        -- Only the dealer handing the round back; requesting, applying and
        -- cancelling it are admin routes that update the application itself.
        IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status <> 'submitted' THEN
            RETURN NULL;
        END IF;
    END IF;
    UPDATE dealer_onboarding_applications
       SET last_action_at = (now() AT TIME ZONE 'UTC')
     WHERE id = NEW.application_id;
    RETURN NULL;
END;
$fn$;

DO $do$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'dealer_onboarding_last_action'
           AND tgrelid = 'dealer_onboarding_applications'::regclass
    ) THEN
        CREATE TRIGGER dealer_onboarding_last_action
            BEFORE INSERT OR UPDATE ON dealer_onboarding_applications
            FOR EACH ROW EXECUTE FUNCTION dealer_onboarding_last_action_fn();
    END IF;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: dealer_onboarding_applications does not exist';
END;
$do$;

DO $do$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'dealer_onboarding_documents_last_action'
           AND tgrelid = 'dealer_onboarding_documents'::regclass
    ) THEN
        CREATE TRIGGER dealer_onboarding_documents_last_action
            AFTER INSERT ON dealer_onboarding_documents
            FOR EACH ROW EXECUTE FUNCTION dealer_onboarding_child_last_action_fn();
    END IF;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: dealer_onboarding_documents does not exist';
END;
$do$;

DO $do$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'dealer_correction_rounds_last_action'
           AND tgrelid = 'dealer_correction_rounds'::regclass
    ) THEN
        CREATE TRIGGER dealer_correction_rounds_last_action
            AFTER UPDATE ON dealer_correction_rounds
            FOR EACH ROW EXECUTE FUNCTION dealer_onboarding_child_last_action_fn();
    END IF;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: dealer_correction_rounds does not exist';
END;
$do$;
