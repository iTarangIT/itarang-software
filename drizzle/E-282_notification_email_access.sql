-- E-282: per-type control of which notifications ALSO go out by email.
--
-- WHY
--   E-231 gave admins a switch on the in-app bell and said so in its own header:
--   "SCOPE IS THE IN-APP BELL ONLY. Email, WhatsApp and SMS are untouched — a
--   blocked recipient still receives the email emit.ts sends, and emailWorthy()
--   remains the only switch on that channel."
--
--   emailWorthy() (src/lib/notifications/catalog.ts) is a hard-coded module
--   constant: a NO_EMAIL Set of 15 strings. Every one of the other ~180
--   notification types is emailed to every resolved recipient, and the only way
--   to change that is to edit source and redeploy. This table is that switch,
--   moved out of the source file and onto a settings screen.
--
-- NO ROW = THE CODE DEFAULT, NOT "ENABLED"
--   This is the one place E-282 deliberately differs from E-231. There, absence
--   meant ENABLED, because the code had no opinion. Here the code DOES have an
--   opinion — emailWorthy() — and it is a good one: the NO_EMAIL entries each
--   carry a reason (auction.outbid can fire several times inside one second;
--   auction.lot_published/ending_soon/won already have a bespoke HTML mail with
--   the battery photo, so emailing them here would send BOTH).
--
--   So a row exists only where a human made a decision, and it OVERRIDES the
--   code. `enabled` therefore has NO DEFAULT: an INSERT that does not state the
--   answer is a bug, not a row that means "on".
--
-- SAFE TO SKIP AT DEPLOY
--   src/lib/notifications/email-access.ts fails OPEN to an EMPTY override map,
--   which resolves every type through emailWorthy() — i.e. exactly today's
--   behaviour. A missing table, a dropped connection or a slow query is
--   indistinguishable from the app as it shipped before this migration. That
--   matters here more than usual: there is no migration runner in this project
--   (see MIGRATION_CHECKLIST.md) and migrations have silently stopped applying
--   on prod before, around E-145 by that file's own account.
--
--   The contrast is E-280/E-281, which ARE required before their code deploys
--   because schema.ts names their columns in a bare select. Nothing here is
--   selected by any other query.
--
-- SHIPS EMPTY. No seed, no backfill. Day-1 behaviour is byte-identical to today,
--   and the screen switches the channel over decision by decision (cf. E-226,
--   E-231).
--
-- WHY PER-TYPE AND NOT PER-DASHBOARD
--   emit.ts has no per-role notion of email at all: emailTargets() collects the
--   address of EVERY resolved target of an audience and sends one message. A
--   (dashboard, type) key like E-231's would therefore be unenforceable — the
--   screen would offer a toggle the emitter cannot honour. Per-type is the
--   granularity the send path actually has.
--
-- WHY PER-TYPE AND NOT PER-CATEGORY
--   Same three reasons as E-231: category is DERIVED from `type` (catalog.ts
--   categorize()), "System" is the catch-all for every UNMAPPED type, and
--   category-off plus type-on has no non-arbitrary precedence. The category
--   checkbox on the screen writes N per-type rows.
--
-- WHAT THIS TABLE CANNOT SILENCE, BY CONSTRUCTION
--   Only the generic mail emit() sends. The 15 bespoke senders in src/lib/email/
--   (password reset, password-change OTP, dealer/NBFC/vendor welcome
--   credentials, dealer agreement + expiry reminder, FI / VKYC / recovery agent
--   links, auction lot mails, manual handoff) and sendNbfcEventEmail()
--   (src/lib/nbfc/event-mailer.ts) call sendEmail() directly and never consult
--   emailWorthy(). They are structurally out of reach of this screen — which is
--   the property E-231's header demanded. On top of that, EMAIL_LOCKED in
--   catalog.ts pins a small set of emit() types (agreement, consent, sanction,
--   disbursal) whose email is the only copy an external party gets; the save
--   route rejects a change to one of those by name.
--
-- Additive and idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS notification_email_access (
  notification_type varchar(50)  NOT NULL,
  -- NO DEFAULT, on purpose. See "NO ROW = THE CODE DEFAULT" above.
  enabled           boolean      NOT NULL,
  updated_by        text,
  updated_at        timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT notification_email_access_pkey PRIMARY KEY (notification_type)
);

COMMENT ON TABLE notification_email_access IS
  'E-282: explicit per-type overrides for the generic email channel emit() sends. '
  'NO ROW = the code default in emailWorthy() (src/lib/notifications/catalog.ts). '
  'Unlike notification_access (E-231), absence does NOT mean enabled — it means '
  '"nobody has overridden the code for this type". Read by '
  'src/lib/notifications/email-access.ts, which fails OPEN to an empty map.';

COMMENT ON COLUMN notification_email_access.notification_type IS
  'E-282: notifications.type verbatim — both the modern <domain>.<event> form and '
  'the legacy flat types (kyc_accepted, inventory_assigned, delivery_confirmed). '
  'varchar(50) to match notifications.type and notification_access exactly; a '
  'longer string is truncated by emit.ts safeType() and would become ungovernable.';

COMMENT ON COLUMN notification_email_access.enabled IS
  'E-282: true = email this type, false = do not. Overrides BOTH emailWorthy() and '
  'the per-recipient `email: false` overrides in events.ts, so the settings screen '
  'never claims something the emitter contradicts. It cannot override EMAIL_LOCKED, '
  'and it has no effect at all on the in-app bell (that is E-231) or on the bespoke '
  'senders in src/lib/email/.';

COMMENT ON COLUMN notification_email_access.updated_by IS
  'E-282: users.id AS TEXT, matching notification_access.updated_by on the sibling '
  'tab (which joins u.id::text = na.updated_by). Per-save history is additionally '
  'written to audit_logs with action=''notification_email_access.updated''.';

-- NO SECONDARY INDEX, deliberately. The only read is "give me every override"
-- (SELECT with no WHERE), bounded at ~200 rows and cached in process for 60s.
-- The primary key already covers the upsert. Do not add one.
