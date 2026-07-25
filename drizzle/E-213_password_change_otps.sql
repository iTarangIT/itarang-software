------------------------------------------------------------------------------
-- E-213: password_change_otps — OTP gate for the in-app "Change Password"
-- modal (header dropdown → 4-digit code to the registered email → verify →
-- set the new password). There is NO current-password field: control of the
-- registered mailbox is the proof of identity.
--
-- WHY A NEW TABLE INSTEAD OF REUSING AN EXISTING OTP TABLE:
--   All three existing OTP tables are LEAD-scoped, not USER-scoped.
--   consent_otp_verifications is keyed (lead_id, consent_for) with lead_id
--   NOT NULL, and on the email channel it already stores an EMAIL ADDRESS in a
--   column literally named `phone` (src/lib/kyc/consent-service.ts) — a shape
--   we should not propagate. calc_otp_verifications and otp_confirmations key
--   on created_by + phone. None of them can express "this OTP belongs to this
--   user account". The MECHANICS are reused verbatim (sha256-at-rest, 10-min
--   TTL, 3 sends / 30-min cooldown, 3 attempts / 5-min lock, single-use);
--   only the shape is new.
--
-- WHY THIS AND NOT E-212's password_reset_tokens:
--   That flow is UNAUTHENTICATED and mails a 256-bit link to someone who
--   cannot log in. This one runs INSIDE an authenticated session, so it needs
--   no anti-enumeration contract and must not log the user out.
--
-- SECURITY SHAPE (same as password_reset_tokens, E-212):
--   Only sha256(code) is stored, so a full read of this table cannot forge a
--   password change. `consumed_at` is claimed with a conditional
--   UPDATE ... RETURNING, which doubles as the race mutex for a
--   double-submitted form. `email` is stored lower-cased for AUDIT ONLY —
--   every lookup goes via user_id, because users.email can be mixed-case
--   (see the comment in src/app/api/auth/change-password/route.ts).
--
-- Additive, idempotent, new table only. Nothing existing is touched.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS password_change_otps (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- users.id, which IS the Supabase auth user id (set at activation).
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Lower-cased email read from `users` at send time. Audit only (see header).
  email           text NOT NULL,
  otp_hash        varchar(64) NOT NULL,          -- sha256(code) hex
  expires_at      timestamptz NOT NULL,
  send_count      integer NOT NULL DEFAULT 1,
  attempt_count   integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,                   -- set after N wrong attempts
  verified_at     timestamptz,                   -- code accepted
  consumed_at     timestamptz,                   -- password actually changed
  delivery_status varchar(20) NOT NULL DEFAULT 'sent', -- sent|dev_hardcoded|failed
  requested_ip    varchar(64),
  requested_ua    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- "The one open session for this user" — send-otp and verify-otp both start here.
CREATE INDEX IF NOT EXISTS password_change_otps_open_idx
  ON password_change_otps (user_id, created_at DESC)
  WHERE verified_at IS NULL AND consumed_at IS NULL;

-- confirm's atomic claim looks for a VERIFIED-but-unconsumed session.
CREATE INDEX IF NOT EXISTS password_change_otps_verified_idx
  ON password_change_otps (user_id, created_at DESC)
  WHERE verified_at IS NOT NULL AND consumed_at IS NULL;

-- Rolling-window throttle and the opportunistic prune both scan this.
CREATE INDEX IF NOT EXISTS password_change_otps_user_created_idx
  ON password_change_otps (user_id, created_at DESC);

COMMENT ON TABLE password_change_otps IS
  'E-213: 4-digit email OTP sessions gating the in-app Change Password modal. Only sha256(code) is stored.';
COMMENT ON COLUMN password_change_otps.email IS
  'Lower-cased email read from users at send time. Audit only — never used to look the user up.';
COMMENT ON COLUMN password_change_otps.verified_at IS
  'Stamped when the correct code is entered. The password has NOT changed yet at this point.';
COMMENT ON COLUMN password_change_otps.consumed_at IS
  'Claimed by a conditional UPDATE when the password actually changes. Distinct from verified_at so the audit trail shows codes entered but abandoned.';
