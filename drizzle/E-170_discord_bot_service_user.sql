-- E-170_discord_bot_service_user.sql
--
-- Seeds the "Discord Bot" service user that owns AI-dialer campaigns created
-- through the bot API (/api/bot/*). Gives bot-created campaigns a clear,
-- auditable "triggered by" identity in CRM history (campaigns list, detail
-- header) instead of a blank attribution.
--
-- The id is fixed and mirrored in src/lib/bot/constants.ts (DISCORD_BOT_USER_ID).
-- It is a pure data seed (no schema change) — the users table already exists.
--
-- Idempotent: ON CONFLICT (id) DO NOTHING. Safe to re-run.
--
-- ⚠ The users table lives on AWS RDS (not Supabase). Apply this via the
-- pgAdmin Query Tool against RDS.

INSERT INTO users (id, email, name, role, is_active, must_change_password)
VALUES (
  'd15c0b07-0000-4000-8000-000000000001',
  'discord-bot@itarang.com',
  'Discord Bot',
  'system',
  true,
  false
)
ON CONFLICT (id) DO NOTHING;
