-- E-393 — LinkedIn Outreach module for the Sales Head (23 Nov 2026).
--
-- Spec: tasks/linkedin-outreach-dev-plan.md (v0.2). Search runs through Bright
-- Data (public profile data, never touches the LinkedIn account); invites and
-- messages run through Unipile against one connected account per li_accounts
-- row. Nothing is sent without an li_approvals row whose hashes match what the
-- send ticker is about to send (src/lib/linkedin/workers/sendTick.ts).
--
-- Provider keys (Bright Data token, Unipile DSN + key, webhook secrets) live in
-- li_provider_credentials, sealed with src/lib/security/secretBox.ts
-- (APP_SECRETS_ENC_KEY). Each environment's database holds its own keys.
--
-- Strictly additive + idempotent: new tables only, no change to an existing one.

CREATE TABLE IF NOT EXISTS li_provider_credentials (
  provider varchar(20) NOT NULL,            -- brightdata | unipile
  kind varchar(32) NOT NULL,                -- api_token | dsn | api_key | webhook_secret | dataset_id
  ciphertext text NOT NULL,
  iv text NOT NULL,
  tag text NOT NULL,
  last4 varchar(8) NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, kind)
);

CREATE TABLE IF NOT EXISTS li_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  provider varchar(20) NOT NULL DEFAULT 'unipile',
  provider_account_id text,                 -- Unipile account_id once connected
  status varchar(16) NOT NULL DEFAULT 'pending', -- pending | ok | challenge | restricted | paused
  status_reason text,
  owner_user_id uuid,
  warmup_started_at timestamptz,
  last_health_at timestamptz,
  last_polled_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS li_accounts_provider_account_uniq
  ON li_accounts (provider, provider_account_id) WHERE provider_account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS li_settings (
  account_id uuid PRIMARY KEY REFERENCES li_accounts(id) ON DELETE CASCADE,
  invites_per_day integer NOT NULL DEFAULT 15,
  messages_per_day integer NOT NULL DEFAULT 30,
  gap_min_minutes integer NOT NULL DEFAULT 3,
  gap_max_minutes integer NOT NULL DEFAULT 9,
  send_start varchar(5) NOT NULL DEFAULT '10:00',   -- IST, HH:MM
  send_end varchar(5) NOT NULL DEFAULT '18:30',
  send_days varchar(20) NOT NULL DEFAULT '1,2,3,4,5,6', -- ISO weekday, 1 = Monday
  warmup_week1_invites integer NOT NULL DEFAULT 5,
  warmup_week2_invites integer NOT NULL DEFAULT 10,
  poll_interval_minutes integer NOT NULL DEFAULT 45,
  invite_expiry_days integer NOT NULL DEFAULT 21,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS li_search_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keywords text NOT NULL,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  account_id uuid REFERENCES li_accounts(id) ON DELETE SET NULL,
  provider varchar(20) NOT NULL DEFAULT 'brightdata',
  provider_job_id text,
  status varchar(12) NOT NULL DEFAULT 'queued', -- queued | running | done | failed
  error text,
  result_count integer NOT NULL DEFAULT 0,
  triggered_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS li_search_runs_status_idx ON li_search_runs (status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS li_search_runs_job_uniq
  ON li_search_runs (provider, provider_job_id) WHERE provider_job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS li_prospects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id text NOT NULL,                 -- LinkedIn public identifier (URL slug)
  public_url text NOT NULL,
  provider_id text,                         -- Unipile provider_id, resolved on first use
  full_name text,
  first_name text,
  headline text,
  company text,
  city text,
  source varchar(16) NOT NULL DEFAULT 'brightdata', -- brightdata | manual
  raw_json jsonb,
  do_not_contact boolean NOT NULL DEFAULT false,
  do_not_contact_reason text,
  lead_id varchar(50),                      -- matched CRM lead, if any
  connection_state varchar(12),             -- none | pending | connected
  connection_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS li_prospects_profile_uniq ON li_prospects (profile_id);
CREATE UNIQUE INDEX IF NOT EXISTS li_prospects_url_uniq ON li_prospects (public_url);
CREATE INDEX IF NOT EXISTS li_prospects_company_idx ON li_prospects (lower(company));

CREATE TABLE IF NOT EXISTS li_search_results (
  run_id uuid NOT NULL REFERENCES li_search_runs(id) ON DELETE CASCADE,
  prospect_id uuid NOT NULL REFERENCES li_prospects(id) ON DELETE CASCADE,
  fit_score integer,
  fit_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, prospect_id)
);

CREATE TABLE IF NOT EXISTS li_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name text NOT NULL,
  content_type text,
  size_bytes integer,
  storage_path text NOT NULL,
  storage_url text NOT NULL,
  sha256 varchar(64) NOT NULL,
  uploaded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS li_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  account_id uuid NOT NULL REFERENCES li_accounts(id),
  template text NOT NULL DEFAULT '',
  invite_note text,
  attachment_id uuid REFERENCES li_attachments(id) ON DELETE SET NULL,
  status varchar(12) NOT NULL DEFAULT 'draft', -- draft | approved | running | paused | stopped | done
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS li_campaigns_status_idx ON li_campaigns (status);

CREATE TABLE IF NOT EXISTS li_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES li_campaigns(id) ON DELETE CASCADE,
  template_hash varchar(64) NOT NULL,
  note_hash varchar(64) NOT NULL,
  attachment_hash varchar(64) NOT NULL,     -- 'none' when no attachment
  prospect_count integer NOT NULL,
  approved_by uuid,
  approved_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  void_reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS li_approvals_live_uniq
  ON li_approvals (campaign_id) WHERE voided_at IS NULL;

CREATE TABLE IF NOT EXISTS li_campaign_prospects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES li_campaigns(id) ON DELETE CASCADE,
  prospect_id uuid NOT NULL REFERENCES li_prospects(id) ON DELETE CASCADE,
  state varchar(16) NOT NULL DEFAULT 'selected',
  rendered_message text,
  rendered_note text,
  missing_fields text,
  next_action_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  invite_sent_at timestamptz,
  accepted_at timestamptz,
  message_sent_at timestamptz,
  seen_at timestamptz,
  replied_at timestamptz,
  stopped_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS li_campaign_prospects_uniq
  ON li_campaign_prospects (campaign_id, prospect_id);
CREATE INDEX IF NOT EXISTS li_campaign_prospects_due_idx
  ON li_campaign_prospects (state, next_action_at);
-- A prospect cannot be live in two campaigns at once.
CREATE UNIQUE INDEX IF NOT EXISTS li_campaign_prospects_one_live_uniq
  ON li_campaign_prospects (prospect_id)
  WHERE state IN ('approved', 'queued', 'invite_sent', 'accepted', 'message_sent', 'seen');

CREATE TABLE IF NOT EXISTS li_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES li_accounts(id) ON DELETE CASCADE,
  provider_chat_id text NOT NULL,
  prospect_id uuid REFERENCES li_prospects(id) ON DELETE SET NULL,
  campaign_id uuid REFERENCES li_campaigns(id) ON DELETE SET NULL,
  last_message_at timestamptz,
  last_inbound_at timestamptz,
  unread boolean NOT NULL DEFAULT false,
  sentiment varchar(12),                    -- positive | neutral | negative
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS li_conversations_chat_uniq
  ON li_conversations (account_id, provider_chat_id);

CREATE TABLE IF NOT EXISTS li_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES li_conversations(id) ON DELETE CASCADE,
  provider_message_id text NOT NULL,
  direction varchar(8) NOT NULL,            -- in | out
  body text,
  attachment_name text,
  campaign_prospect_id uuid REFERENCES li_campaign_prospects(id) ON DELETE SET NULL,
  sent_by uuid,
  sent_at timestamptz NOT NULL,
  seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS li_messages_provider_uniq ON li_messages (provider_message_id);
CREATE INDEX IF NOT EXISTS li_messages_conv_idx ON li_messages (conversation_id, sent_at);

-- Admin replies typed in the inbox: queued, sent by the send ticker under the same pacing.
CREATE TABLE IF NOT EXISTS li_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES li_conversations(id) ON DELETE CASCADE,
  body text NOT NULL,
  attachment_id uuid REFERENCES li_attachments(id) ON DELETE SET NULL,
  status varchar(10) NOT NULL DEFAULT 'queued', -- queued | sent | failed
  error text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS li_outbox_status_idx ON li_outbox (status, created_at);

CREATE TABLE IF NOT EXISTS li_action_log (
  id bigserial PRIMARY KEY,
  account_id uuid REFERENCES li_accounts(id) ON DELETE SET NULL,
  action varchar(24) NOT NULL,              -- invite | message | reply | poll | health | search | refused | pause
  ok boolean NOT NULL,
  prospect_id uuid,
  campaign_id uuid,
  detail text,
  actor_id uuid,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS li_action_log_caps_idx ON li_action_log (account_id, action, at);
