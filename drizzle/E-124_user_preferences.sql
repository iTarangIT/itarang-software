-- E-124: user_preferences — per-rep saved filters / defaults
--
-- BRD §0.13. Stores arbitrary per-user preferences as JSONB keyed by
-- pref_key. Examples: saved-filter sets on Admin Dashboard / Lead Queue,
-- preferred tab on Lead Queue, default page size, etc.
--
-- UNIQUE (user_id, pref_key) gives upsert-by-key without versioning.

CREATE TABLE IF NOT EXISTS user_preferences (
  pref_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  pref_key varchar(100) NOT NULL,
  pref_value jsonb NOT NULL,
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS user_preferences_user_key_uniq
  ON user_preferences (user_id, pref_key);
