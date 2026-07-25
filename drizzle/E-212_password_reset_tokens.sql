------------------------------------------------------------------------------
-- E-212: password_reset_tokens — self-service "Forgot password?" links.
--
-- WHY OUR OWN TABLE AND NOT SUPABASE'S RECOVERY LINK:
--   This app keeps TWO password stores. Supabase Auth is authoritative for
--   login (login/page.tsx calls signInWithPassword), but `users.password_hash`
--   (bcrypt) + `users.must_change_password` mirror it on RDS and drive the
--   middleware's forced-reset gate. A Supabase-issued recovery link only
--   updates Supabase; the RDS mirror would silently drift and NBFC first-login
--   users would keep bouncing to /change-password. Owning the token lets ONE
--   endpoint write BOTH stores in a known order (Supabase first, RDS second).
--
-- SECURITY SHAPE (same as nbfc_doc_requests.act_token_hash, E-200):
--   The raw 32-byte token exists ONLY in the emailed URL. We store sha256(raw),
--   so a full read of this table cannot forge a reset. Single-use: `used_at` is
--   claimed with a conditional UPDATE, which doubles as the race mutex for a
--   double-submitted form. `invalidated_at` is stamped on older live tokens
--   when a new one is issued, so there is one live link per account and it is
--   always the newest — the common real sequence is "click Share, nothing
--   arrives in 20s, click Share again", and leaving both live would mean two
--   account-takeover credentials in flight for zero benefit.
--
--   `email` is stored lower-cased for AUDIT ONLY. It is never used to look the
--   user back up — see the case-sensitivity comment in
--   src/app/api/auth/change-password/route.ts. All lookups go via `user_id`.
--
-- Additive, idempotent, new table only. Nothing existing is touched.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- users.id, which IS the Supabase auth user id (set at activation).
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Lower-cased email as typed at request time. Audit only (see header).
  email           text NOT NULL,
  token_hash      varchar(64) NOT NULL,          -- sha256(raw) hex
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,                   -- consumed by a real reset
  invalidated_at  timestamptz,                   -- superseded by a newer token
  requested_ip    varchar(64),
  requested_ua    text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Lookup path for GET/POST /api/auth/reset-password. UNIQUE both enforces
-- "one row per token" and serves the lookup.
CREATE UNIQUE INDEX IF NOT EXISTS password_reset_tokens_hash_key
  ON password_reset_tokens (token_hash);

-- The per-account throttle counts rows in a rolling window; this serves it.
CREATE INDEX IF NOT EXISTS password_reset_tokens_user_created_idx
  ON password_reset_tokens (user_id, created_at DESC);

-- "Live tokens for this user" — the supersede sweep on each new issue.
CREATE INDEX IF NOT EXISTS password_reset_tokens_live_idx
  ON password_reset_tokens (user_id)
  WHERE used_at IS NULL AND invalidated_at IS NULL;

COMMENT ON TABLE password_reset_tokens IS
  'E-212: single-use forgot-password tokens. Only sha256(raw) is stored; the raw token exists only in the emailed URL.';
COMMENT ON COLUMN password_reset_tokens.invalidated_at IS
  'Stamped when a newer token supersedes this one. Distinct from used_at so the audit trail shows which links were actually clicked.';
COMMENT ON COLUMN password_reset_tokens.email IS
  'Lower-cased email as typed at request time. Audit only — never used to look the user up (users.email can be mixed-case).';
