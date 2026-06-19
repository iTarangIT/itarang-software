// Stable identity for the "Discord Bot" service user that owns AI-dialer
// campaigns created through the bot API (/api/bot/*). Kept as a fixed UUID so
// bot routes can attribute campaigns deterministically without a lookup.
//
// This id MUST match the row inserted by drizzle/E-170_discord_bot_service_user.sql.
// The users table lives on AWS RDS — apply that migration there (pgAdmin), not
// Supabase. Until it's applied, bot-created campaigns still work but their
// triggered_by → users.name join resolves to NULL (no display name).
export const DISCORD_BOT_USER_ID = "d15c0b07-0000-4000-8000-000000000001";
export const DISCORD_BOT_USER_EMAIL = "discord-bot@itarang.com";
export const DISCORD_BOT_USER_NAME = "Discord Bot";

// Marker written into a bot campaign's region_filter so CRM views (and the
// `?source=bot` filter on GET /api/bot/campaigns) can identify bot-origin runs.
export const BOT_CAMPAIGN_SOURCE = "discord-bot";
