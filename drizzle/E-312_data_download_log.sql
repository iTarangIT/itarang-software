-- E-312 — data download log (tracker ID 58, handover P0-3).
--
-- One row per export a user downloads: who, which dataset, which filters, how
-- many rows. Rep exports are limited to the rep's own leads; this log is how a
-- manager sees what left the CRM (Reports › Data downloads rules).
--
-- DDL: additive + idempotent. One NEW table, no change to any existing one.
-- NOT mirrored in schema.ts: the writer (src/lib/exports/downloadLog.ts) is a
-- raw, fail-tolerant INSERT, so an unapplied host logs one warning and the
-- download still works. Either deploy order is safe.

CREATE TABLE IF NOT EXISTS data_download_log (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      text         NOT NULL,
    user_role    varchar(40),
    dataset      varchar(80)  NOT NULL,
    row_count    integer      NOT NULL DEFAULT 0,
    own_only     boolean      NOT NULL DEFAULT false,
    filters      jsonb        NOT NULL DEFAULT '{}'::jsonb,
    created_at   timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS data_download_log_user_idx
    ON data_download_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS data_download_log_created_idx
    ON data_download_log (created_at DESC);
