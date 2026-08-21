-- E-255 — Google Drive mirror of every stored document.
--
-- One row per S3 object (logical bucket + key). Written by the storage helpers
-- the moment an object lands in S3, and by the backfill sweep for objects that
-- pre-date this feature. A row moves pending → uploading → done, or → failed
-- (with a backoff clock in next_attempt_at) and is retried by the ticker /
-- /api/cron/gdrive-mirror until it succeeds. Nothing here is on any read path
-- of the app — the S3 copy stays the one the CRM serves; the Drive copy is a
-- backup.
--
-- Idempotent and additive. Safe to re-run.

CREATE TABLE IF NOT EXISTS storage_drive_mirror (
    id                  bigserial PRIMARY KEY,
    bucket              varchar(64)  NOT NULL,
    object_key          text         NOT NULL,
    content_type        varchar(255),
    size_bytes          bigint,
    -- pending | uploading | done | failed | source_deleted
    status              varchar(16)  NOT NULL DEFAULT 'pending',
    attempts            integer      NOT NULL DEFAULT 0,
    next_attempt_at     timestamptz  NOT NULL DEFAULT now(),
    drive_file_id       text,
    drive_folder_id     text,
    drive_web_view_link text,
    drive_md5           text,
    last_error          text,
    mirrored_at         timestamptz,
    created_at          timestamptz  NOT NULL DEFAULT now(),
    updated_at          timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT storage_drive_mirror_bucket_key_uq UNIQUE (bucket, object_key)
);

-- The claim query: WHERE status IN ('pending','failed') AND next_attempt_at <= now()
CREATE INDEX IF NOT EXISTS storage_drive_mirror_due_idx
    ON storage_drive_mirror (status, next_attempt_at);

CREATE INDEX IF NOT EXISTS storage_drive_mirror_status_idx
    ON storage_drive_mirror (status);
