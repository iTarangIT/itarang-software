-- E-237 — Mirror, in the CRM, the assignment a human already made in NeoDove.
--
-- THE PROBLEM. Leads pushed to a NeoDove campaign reach the calling team but
-- stay unowned here: dealer_leads.current_owner_id is left NULL, so they appear
-- on nobody's dashboard. They are absent from every rep's /inside-sales "My Open
-- Leads" and read "Unassigned" in the /leads Owner column, while a NeoDove agent
-- is actively calling them. The CRM and the calling team disagree about who owns
-- twenty leads, and nothing in either system says so.
--
-- WHY THIS CANNOT BE SOLVED BY TALKING TO NEODOVE. Their Custom Integration
-- endpoint has NO assignee/agent/owner parameter — a key called `assignee` would
-- become an untyped custom field, not an assignment — and NeoDove has no read
-- API, so their agent list cannot be mirrored either (docs/neodove-contract.md
-- §2). Assignment on their side is campaign MEMBERS plus the campaign's
-- lead-distribution setting, both configured only in their UI. So this migration
-- adds nothing that is ever SENT anywhere. crm_owner_user_id records who, on OUR
-- side, owns the leads that a human has already pointed at a NeoDove agent.
--
-- ⚠ HOW THIS DIFFERS FROM mirror_config (E-225). mirror_config is DESCRIPTIVE —
-- it records NeoDove-side settings we cannot write, and nothing reads it back to
-- make a decision. crm_owner_user_id is ACTED ON: a push assigns leads to it.
-- It belongs in the same category as is_priority_dial (E-226), and the campaign
-- form must not present it inside the "recorded, never applied" block.
--
-- ⚠ EVERY READ MUST GO THROUGH to_jsonb. A missing column fails a statement at
-- PARSE time, not with zero rows, so naming crm_owner_user_id directly would
-- take all four push routes and the campaigns list down on any database where
-- this file has not been applied. Read it as
-- `to_jsonb(c) ->> 'crm_owner_user_id'`, exactly as getPriorityDialCampaign()
-- reads is_priority_dial (src/lib/neodove/pushOne.ts). Writes name the column
-- only on the code path that the operator can reach solely through UI that this
-- migration also enables.
--
-- NOTE these three columns ARE mirrored in src/lib/db/schema.ts — unlike E-224's
-- dealer_leads columns and E-226's lead_touchpoints columns, which are not.
-- The difference is not the migration state, it is HOW the table is accessed:
-- neodove_campaigns and neodove_lead_links are reached exclusively through raw
-- `sql` (verified: zero references outside schema.ts), so no bare
-- db.select().from() exists that Drizzle could expand into a column list naming
-- a column the database lacks. Same reasoning already recorded at schema.ts for
-- mirror_config and is_priority_dial.
--
-- TEXT, not uuid, and no foreign key: dealer_leads.current_owner_id is text
-- while users.id is uuid, so every join in this codebase already casts
-- (`owner.id::text = dl.current_owner_id`). Matching that type keeps the two
-- owner columns directly comparable; a cross-type FK is not expressible without
-- a generated cast column. Validity is enforced at write time in the API, the
-- same way current_owner_id's is.
--
-- Strictly additive and idempotent, per CLAUDE.md. Guarded: prod (db-2) has no
-- neodove_* tables at all until E-224 lands there, so this is a no-op there
-- rather than an error.

-- ── neodove_campaigns (E-224 — NOT on prod yet) ────────────────────────────
DO $do$
BEGIN
    ALTER TABLE neodove_campaigns
        ADD COLUMN IF NOT EXISTS crm_owner_user_id text;

    COMMENT ON COLUMN neodove_campaigns.crm_owner_user_id IS
        'users.id::text of the CRM user who should own leads pushed into this campaign - the CRM-side counterpart of the NeoDove campaign-member assignment, which has no API and can be neither read nor written from here. Nothing is ever sent to NeoDove. Read via to_jsonb (see E-237).';
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: neodove_campaigns absent (E-224 not applied)';
END;
$do$;

-- ── neodove_lead_links (E-224 — NOT on prod yet) ───────────────────────────
DO $do$
BEGIN
    -- Per-push bookkeeping. Without these the outcome is unknowable after the
    -- fact: dealer_leads.current_owner_id only ever shows the CURRENT owner, so
    -- one later reassignment erases the evidence that this push assigned
    -- anything at all. And the count cannot travel in the HTTP response either
    -- — push-batch acks BEFORE its drain runs in after().
    ALTER TABLE neodove_lead_links
        ADD COLUMN IF NOT EXISTS assigned_owner_id text,
        ADD COLUMN IF NOT EXISTS assigned_at       timestamptz;

    COMMENT ON COLUMN neodove_lead_links.assigned_owner_id IS
        'users.id::text assigned in the CRM as a result of THIS push. Historical: deliberately NOT kept in step with dealer_leads.current_owner_id if the lead is reassigned later.';

    COMMENT ON COLUMN neodove_lead_links.assigned_at IS
        'When the CRM-side assignment for this push landed. NULL = the push carried no assignment, or the assignment failed. Either way the push itself is unaffected.';

    -- Answers "who did this campaign assign leads to, and how many" for the
    -- campaign detail stat. Partial: the overwhelming majority of rows are from
    -- pushes that carried no assignment.
    CREATE INDEX IF NOT EXISTS neodove_lead_links_assigned_owner_idx
        ON neodove_lead_links (neodove_campaign_id, assigned_owner_id)
        WHERE assigned_owner_id IS NOT NULL;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: neodove_lead_links absent (E-224 not applied)';
END;
$do$;
