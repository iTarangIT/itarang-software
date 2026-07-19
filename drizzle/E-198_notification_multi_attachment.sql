------------------------------------------------------------------------------
-- E-198: buyback_notification_events.attachment_s3_keys — more than one file.
--
-- The vendor quotation email is supposed to carry the battery PHOTOS, so a
-- recycler can judge condition without logging in (item 14). It could not: the
-- event row has ONE attachment_s3_key, so exactly one file could ride with a
-- message. The photos were instead base64-inlined INTO the quotation PDF, which
-- is why they were capped at two per line and rendered at 54x40px — a size at
-- which a swollen cell and a healthy one look identical, which defeats the
-- entire point of sending them.
--
-- The mailer never had this limit: sendEmail() has always taken
-- `attachments: MailAttachment[]`. Only the event row did.
--
-- WHY A COLUMN AND NOT `payload`:
--   payload is jsonb and would have held the keys with no migration. But
--   attachment_s3_key is deliberately its own column, snapshotted at emit time,
--   for the reason the transition.ts docblock gives: the dispatcher must never
--   re-derive what it sends — a photo can be deleted or re-uploaded between the
--   transition and the send, and the audit trail must record what actually went
--   out. Attachments are not "extra context for the message body"; they ARE the
--   message. Hiding them in payload would put the same fact in two shapes.
--
-- THE SINGULAR COLUMN STAYS. It carries the quotation PDF, whose absence is
-- fatal (dispatch.ts throws rather than send a "please quote" with no
-- quotation). The array carries evidence, whose absence is not: a missing photo
-- must not strand the email. Two columns, two failure policies — that
-- difference is the reason not to merge them.
--
-- Additive + idempotent. No backfill: every existing row's attachments are
-- already correctly described by the singular column, and NULL here means "no
-- extra files", which is true of all of them.
--
-- No-ops with a NOTICE where the buyback tables do not exist (production).
------------------------------------------------------------------------------

DO $do$ BEGIN
  ALTER TABLE buyback_notification_events
    ADD COLUMN IF NOT EXISTS attachment_s3_keys text[];

  COMMENT ON COLUMN buyback_notification_events.attachment_s3_keys IS
    'E-198 — additional S3 keys to attach, beyond attachment_s3_key. Snapshotted at emit time like the recipient, so the dispatcher never re-derives what it sends. Used for the battery photos on a vendor quotation: a scrap buyer judges condition from them, and they used to be base64-inlined into the PDF (capped at 2/line, rendered 54x40px) because the event could only name one file. NULL means no extra files. Unlike attachment_s3_key — whose absence is fatal, because the quotation IS the email — a missing key here is skipped, not retried: evidence is not worth stranding the message over.';
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'buyback_notification_events does not exist here yet (E-185 not applied) — skipping E-198';
END; $do$;
