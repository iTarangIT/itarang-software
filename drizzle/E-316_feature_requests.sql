-- E-316 — Feature Request & Approval module (2026-09-30).
--
-- CEO raises a feature request → Product Head reviews → Tech Head reviews and
-- assigns a developer → the developer walks it to Closed. Every comment, reply,
-- approval, rejection, send-back and attachment is kept forever: there is no
-- delete path in the app, comment edits keep the previous text, and every
-- transition writes an append-only event row.
--
-- Who may do what is NOT derived from users.role. It is the seat in
-- feature_request_members (requester | product_reviewer | tech_reviewer |
-- developer), so a third developer is one INSERT, not a code change.
--
-- DDL: additive + idempotent. Six NEW tables and one sequence; no change to any
-- existing table. MIRRORED in schema.ts, but only the /feature-requests module
-- reads these tables — an unapplied host breaks that module and nothing else.

CREATE SEQUENCE IF NOT EXISTS feature_request_code_seq START 1;

CREATE TABLE IF NOT EXISTS feature_request_members (
    user_id     uuid         PRIMARY KEY,
    seat        varchar(30)  NOT NULL,
    is_active   boolean      NOT NULL DEFAULT true,
    created_at  timestamptz  NOT NULL DEFAULT now(),
    updated_at  timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT feature_request_members_seat_chk
        CHECK (seat IN ('requester', 'product_reviewer', 'tech_reviewer', 'developer'))
);

CREATE TABLE IF NOT EXISTS feature_requests (
    id                     uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    code                   varchar(20)  NOT NULL
        DEFAULT ('FR-' || lpad(nextval('feature_request_code_seq')::text, 4, '0')),
    title                  text         NOT NULL,
    description            text         NOT NULL,
    priority               varchar(20)  NOT NULL DEFAULT 'medium',
    module                 varchar(120) NOT NULL,
    status                 varchar(40)  NOT NULL DEFAULT 'pending_product_review',
    current_owner_id       uuid,
    -- The stage a `changes_requested` request goes back to on resubmit.
    resubmit_to_status     varchar(40),
    assigned_developer_id  uuid,
    revision               integer      NOT NULL DEFAULT 1,
    created_by             uuid         NOT NULL,
    created_at             timestamptz  NOT NULL DEFAULT now(),
    updated_at             timestamptz  NOT NULL DEFAULT now(),
    closed_at              timestamptz,
    CONSTRAINT feature_requests_priority_chk
        CHECK (priority IN ('low', 'medium', 'high', 'critical'))
);

CREATE UNIQUE INDEX IF NOT EXISTS feature_requests_code_uq ON feature_requests (code);
CREATE INDEX IF NOT EXISTS feature_requests_status_idx ON feature_requests (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS feature_requests_owner_idx ON feature_requests (current_owner_id);

CREATE TABLE IF NOT EXISTS feature_request_comments (
    id                  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    feature_request_id  uuid         NOT NULL REFERENCES feature_requests (id),
    parent_id           uuid         REFERENCES feature_request_comments (id),
    author_id           uuid         NOT NULL,
    -- Role/seat at the time of writing, so history reads right after a reshuffle.
    author_role         varchar(50)  NOT NULL,
    body                text         NOT NULL,
    -- comment | approval | rejection | changes_requested | assignment |
    -- status_change | resubmission | reopen | created
    kind                varchar(30)  NOT NULL DEFAULT 'comment',
    edited_at           timestamptz,
    created_at          timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feature_request_comments_fr_idx
    ON feature_request_comments (feature_request_id, created_at);

CREATE TABLE IF NOT EXISTS feature_request_comment_edits (
    id             uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    comment_id     uuid         NOT NULL REFERENCES feature_request_comments (id),
    previous_body  text         NOT NULL,
    edited_by      uuid         NOT NULL,
    edited_at      timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feature_request_comment_edits_comment_idx
    ON feature_request_comment_edits (comment_id, edited_at);

-- feature_request_id is NULL between upload and the create/comment call that
-- claims the file; comment_id NULL means it hangs off the request itself.
CREATE TABLE IF NOT EXISTS feature_request_attachments (
    id                  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    feature_request_id  uuid         REFERENCES feature_requests (id),
    comment_id          uuid         REFERENCES feature_request_comments (id),
    uploaded_by         uuid         NOT NULL,
    file_name           text         NOT NULL,
    mime_type           varchar(150),
    size_bytes          integer      NOT NULL,
    storage_bucket      varchar(60)  NOT NULL,
    storage_key         text         NOT NULL,
    created_at          timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feature_request_attachments_fr_idx
    ON feature_request_attachments (feature_request_id, created_at);

CREATE TABLE IF NOT EXISTS feature_request_events (
    id                  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    feature_request_id  uuid         NOT NULL REFERENCES feature_requests (id),
    actor_id            uuid         NOT NULL,
    action              varchar(40)  NOT NULL,
    from_status         varchar(40),
    to_status           varchar(40),
    target_user_id      uuid,
    note                text,
    created_at          timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feature_request_events_fr_idx
    ON feature_request_events (feature_request_id, created_at);
