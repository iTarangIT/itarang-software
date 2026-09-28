-- E-311 — photos, PDFs and location pins for the WhatsApp Sales Assistant, and a
-- home for documents on DEALER leads.
--
-- DDL: additive + idempotent. Two NEW tables, no change to any existing one.
-- Safe to run any number of times, in either deploy order: the code that reads
-- these tables only runs when a rep sends media, and answers "I couldn't take
-- that file" if the table is missing — every other assistant path is untouched.
--
-- assistant_media
--   Every photo / PDF / location pin a rep sends the assistant. The file is
--   downloaded from Meta and stored in S3 the moment it arrives (Meta's media
--   URLs expire), before any Confirm. `ref` is the short id the model sees
--   ("m7k2q9"), unique per user; a tool resolves it for THAT user only.
--   `used_at` / `used_by_action_id` are set by the executor when a confirmed
--   action consumes it — an attachment is used once. "Pending for 15 minutes"
--   is `used_at IS NULL AND created_at > now() - 15 min` (partial index).
--   Channel-neutral name: the assistant core reads it, and the core may not
--   depend on the WhatsApp channel (isolation contract test).
--
-- dealer_lead_documents
--   Documents on a dealer lead (dealer_leads, "DL-…" ids). NOT lead_documents,
--   which belongs to the customer/loan `leads` family — a DL- id never exists
--   there. Written by the assistant's attach_document / create_lead / update_lead
--   on Confirm; shown in the lead page's "Documents & photos" tab.
--   `source` leaves room for a CRM upload later.

DO $do$
BEGIN
    CREATE TABLE IF NOT EXISTS assistant_media (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        ref                varchar(12)  NOT NULL,
        user_id            uuid         NOT NULL,
        channel            varchar(20)  NOT NULL DEFAULT 'whatsapp',
        source_message_id  uuid,
        kind               varchar(20)  NOT NULL,
        mime_type          varchar(100),
        byte_size          integer,
        file_name          text,
        storage_bucket     varchar(60),
        storage_key        text,
        caption            text,
        latitude           numeric(10, 7),
        longitude          numeric(10, 7),
        place_name         text,
        place_address      text,
        created_at         timestamptz  NOT NULL DEFAULT now(),
        used_at            timestamptz,
        used_by_action_id  uuid,
        CONSTRAINT assistant_media_channel_chk CHECK (channel IN ('whatsapp')),
        CONSTRAINT assistant_media_kind_chk CHECK (kind IN ('image', 'document', 'location')),
        CONSTRAINT assistant_media_file_chk CHECK (kind = 'location' OR storage_key IS NOT NULL),
        CONSTRAINT assistant_media_pin_chk CHECK (kind <> 'location' OR (latitude IS NOT NULL AND longitude IS NOT NULL))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS assistant_media_user_ref_uq
        ON assistant_media (user_id, ref);
    CREATE INDEX IF NOT EXISTS assistant_media_user_unused_idx
        ON assistant_media (user_id, created_at DESC) WHERE used_at IS NULL;

    COMMENT ON TABLE assistant_media IS
        'E-311. Photos / PDFs / location pins sent to the WhatsApp Sales Assistant. '
        'Stored on arrival; used once by a confirmed action (used_at).';

    CREATE TABLE IF NOT EXISTS dealer_lead_documents (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        dealer_lead_id  text         NOT NULL,
        doc_type        varchar(40)  NOT NULL,
        storage_bucket  varchar(60)  NOT NULL,
        storage_key     text         NOT NULL,
        mime_type       varchar(100),
        byte_size       integer,
        file_name       text,
        note            text,
        source          varchar(30)  NOT NULL DEFAULT 'crm',
        media_id        uuid,
        uploaded_by     uuid,
        created_at      timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT dealer_lead_documents_type_chk CHECK (doc_type IN (
            'gst_certificate', 'pan', 'shop_licence', 'shop_photo',
            'visiting_card', 'purchase_order', 'other')),
        CONSTRAINT dealer_lead_documents_source_chk CHECK (source IN ('whatsapp_assistant', 'crm'))
    );

    CREATE INDEX IF NOT EXISTS dealer_lead_documents_lead_idx
        ON dealer_lead_documents (dealer_lead_id, created_at DESC);

    COMMENT ON TABLE dealer_lead_documents IS
        'E-311. Documents on a dealer lead (dealer_leads.id, DL-…). Not lead_documents, '
        'which is the customer/loan leads family.';
END;
$do$;
