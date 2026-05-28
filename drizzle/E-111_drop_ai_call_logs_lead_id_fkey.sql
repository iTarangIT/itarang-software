-- E-111: Drop the misaligned ai_call_logs.lead_id foreign key
--
-- Background:
--   The live DB carries a constraint `ai_call_logs_lead_id_fkey` that
--   references `leads(id)`. The application, however, writes dealer lead
--   IDs (DL-…) into `ai_call_logs.lead_id` — those rows live in
--   `dealer_leads`, not `leads`. Every new INSERT from the AI dialer
--   pipeline fails with:
--     "Key (lead_id)=(DL-…) is not present in table 'leads'."
--   The transcript-analysis path runs anyway because the surrounding
--   try/catch in upsertAiCallLog absorbs it, but the call log row is
--   never persisted — so the campaign drawer, transcript viewer, and
--   the new cost analytics dashboard all miss data.
--
--   schema.ts (the source-of-truth per CLAUDE.md) declares no FK on this
--   column; the relations file maps lead_id → dealerLeads.id, and bolna
--   itself stores lead_id as a soft FK. The DB-level FK was almost
--   certainly added by an old `db:push` run, then carried forward — the
--   exact drift CLAUDE.md flags.
--
-- Action:
--   Drop the constraint. Future inserts work; existing data stays.
--   Strictly additive in spirit (a constraint removal that unblocks
--   inserts the app has always intended to perform), idempotent.

DO $do$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ai_call_logs_lead_id_fkey'
      AND conrelid = 'ai_call_logs'::regclass
  ) THEN
    ALTER TABLE ai_call_logs DROP CONSTRAINT ai_call_logs_lead_id_fkey;
    RAISE NOTICE 'Dropped ai_call_logs_lead_id_fkey';
  ELSE
    RAISE NOTICE 'ai_call_logs_lead_id_fkey not present — skipping';
  END IF;
END
$do$;
