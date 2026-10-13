-- =============================================================================
-- E-339 — LOG OF EVERY CUSTOMER KYC FILE OPEN (tracker ID 166)
-- =============================================================================
-- WHY. Business decided on 10 Oct that files open only for Admin, the owner of
-- the lead or account, the Sales Head and the CEO, and that every open of a KYC
-- file is written down: who, which file, when. Admin can see the log.
--
-- WHAT. One append-only table, written by /api/files (src/lib/storage/
-- fileAuthz.ts logFileOpen) for every request for a customer lead file
-- (documents/kyc/<lead id>/…, documents/leads/<lead id>/…), allowed or
-- refused, by login or by signed link. Read by Admin › Settings › KYC file
-- opens (/api/admin/file-access-log).
--
-- The code never requires this table: a failed insert is logged to the
-- server log and the open goes ahead (or is refused) as decided.
--
-- Additive + idempotent. Re-running is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS file_access_log (
    id          bigserial PRIMARY KEY,
    opened_at   timestamptz NOT NULL DEFAULT now(),
    bucket      varchar(64)  NOT NULL,
    object_key  text         NOT NULL,
    lead_id     varchar(255),
    user_id     uuid,
    role        varchar(64),
    -- 'session' | 'signed_link'
    via         varchar(16)  NOT NULL,
    allowed     boolean      NOT NULL,
    ip          varchar(64)
);

CREATE INDEX IF NOT EXISTS file_access_log_opened_idx ON file_access_log (opened_at DESC);
CREATE INDEX IF NOT EXISTS file_access_log_lead_idx   ON file_access_log (lead_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS file_access_log_user_idx   ON file_access_log (user_id, opened_at DESC);
