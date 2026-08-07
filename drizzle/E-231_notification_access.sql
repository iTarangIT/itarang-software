-- E-231: per-dashboard control of which notification types reach the in-app bell.
--
-- WHY
--   Every notification reaches every recipient. src/lib/notifications/emit.ts
--   resolves an audience down to logins and writes one `notifications` row per
--   person, unconditionally. Nothing anywhere decides whether a given dashboard
--   should see a given event.
--
--   Two things look like that switch and are not:
--     nbfc_users.notification_prefs  — five keys written by
--                                      NotificationPrefsSection.tsx and read by
--                                      NO producer. Dead UI; its keys are not
--                                      even real notifications.type values.
--     emailWorthy() in catalog.ts    — the only switch anyone consults, but a
--                                      hard-coded module constant, and it only
--                                      chooses email-vs-no-email. The bell row
--                                      is always written.
--
--   So this is the first real gate. Nothing to migrate off, nothing that breaks.
--
-- WHY A TABLE OF EXCEPTIONS AND NOT A FULL MATRIX
--   17 dashboards x ~140 types = ~2,380 rows that would all say "yes". Absence
--   of a row means ENABLED, so this table only ever holds decisions a human
--   actually made, and a newly-added notification type is on everywhere the
--   moment it exists — the same philosophy src/lib/notifications/catalog.ts
--   already applies to category and priority (derive, don't store, don't
--   backfill).
--
-- WHY DEFAULT-ON IS NOT NEGOTIABLE
--   There is no migration runner in this project (see MIGRATION_CHECKLIST.md);
--   migrations are applied by hand, per database, and have silently stopped
--   applying on prod before — around E-145, by that file's own account. If
--   absence meant DENIED, then an unapplied E-231, a dropped table or a failed
--   SELECT would turn the entire CRM bell off, everywhere, with no error
--   anywhere. With default-on, every one of those failure modes is
--   indistinguishable from today's behaviour. The reader in
--   src/lib/notifications/access.ts fails OPEN to match, deliberately.
--
-- WHY PER-TYPE AND NOT PER-CATEGORY
--   Category is DERIVED from `type` (catalog.ts categorize()), never stored.
--   Three consequences, any one of which sinks a category-level row:
--     1. A stored ('ceo','System',false) row would silently UNMUTE
--        nbfc.wallet_low the day somebody recategorises it out of System.
--     2. "System" is the catch-all for every UNMAPPED type
--        (typeFilterForCategory returns negate:true for it), so a category row
--        there would mean "mute all future unknown types" — fail-CLOSED, which
--        contradicts the paragraph above in the same table.
--     3. Category-off plus type-on has no non-arbitrary answer, and every
--        reader would have to implement the same precedence rule identically.
--   The category checkbox on the screen is a UI affordance that writes N
--   per-type rows. A Set membership test has no precedence rule to get wrong.
--
--   It also buys something for free: when a new type is added to an
--   already-muted category, that category renders MIXED rather than unchecked,
--   so the admin sees the new arrival instead of it being silently swallowed.
--
-- WHY `enabled` SURVIVES RE-ENABLING (never DELETE)
--   A pure deny-list would be smaller, but re-enabling would DELETE the row and
--   destroy the answer to "who turned this back on, and when". Re-enabling
--   upserts enabled=true instead. The hot path only ever reads
--   WHERE enabled = false, so the true rows cost it nothing — they are pure
--   audit.
--
-- WHY A COMPOSITE PRIMARY KEY
--   (dashboard, notification_type) IS the identity. A surrogate id would add a
--   column and a UNIQUE index to express the same thing. It is also the
--   ON CONFLICT target the save route needs.
--
-- SCOPE: THE IN-APP BELL ONLY. Email, WhatsApp and SMS are untouched — a
--   blocked recipient still receives the email emit.ts sends, and emailWorthy()
--   remains the only switch on that channel. This is deliberate: an admin must
--   not be able to silence an agreement link or an OTP from this screen.
--
-- SHIPS EMPTY, ON PURPOSE. No seed, no backfill. Day-1 behaviour is identical
--   to today; the gate switches itself on decision by decision (cf. E-226).
--
-- Additive and idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS notification_access (
  dashboard         varchar(50)  NOT NULL,
  notification_type varchar(50)  NOT NULL,
  enabled           boolean      NOT NULL DEFAULT true,
  updated_by        text,
  updated_at        timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT notification_access_pkey PRIMARY KEY (dashboard, notification_type),
  -- SHAPE, not vocabulary. emit.ts matches roles with LOWER(users.role)
  -- because seeded rows are inconsistently cased (see the comment at
  -- emit.ts resolve() case "roles"). A mixed-case row here would never match
  -- anything, so the gate would fail OPEN — i.e. appear to work while doing
  -- nothing at all, which is the single most dangerous silent failure this
  -- feature has. This makes it unrepresentable.
  CONSTRAINT notification_access_dashboard_lower CHECK (dashboard = lower(dashboard))
);

COMMENT ON TABLE notification_access IS
  'E-231: explicit per-dashboard overrides for the in-app bell. NO ROW = ENABLED. '
  'Only enabled=false rows are ever read by the emitter '
  '(src/lib/notifications/access.ts); enabled=true rows are the audit record of a '
  'notification that was muted and then turned back on.';

COMMENT ON COLUMN notification_access.dashboard IS
  'E-231: LOWER(users.role) — one of the 17 canonical roles in middleware.ts '
  'roleDashboards, labelled in src/lib/notifications/registry.ts. Free text with no '
  'FK, because users.role is itself varchar free text with no enum. NOTE '
  'nbfc_partner covers EVERY NBFC tenant and every NBFC seat: the finer role lives '
  'in nbfc_users.role, a different column this gate does not read.';

COMMENT ON COLUMN notification_access.notification_type IS
  'E-231: notifications.type verbatim — both the modern <domain>.<event> form and '
  'the legacy flat types (kyc_rejected, loan_sanctioned, inventory_assigned). '
  'varchar(50) to match notifications.type exactly; a longer string would be '
  'truncated by emit.ts safeType() and become ungovernable here.';

COMMENT ON COLUMN notification_access.enabled IS
  'E-231: false = silent in this dashboard''s bell. Email, WhatsApp and SMS are NOT '
  'affected — a blocked recipient still gets the email.';

COMMENT ON COLUMN notification_access.updated_by IS
  'E-231: users.id AS TEXT, matching assignment_config.updated_by on the same '
  'settings screen (which joins u.id::text = ac.updated_by). Per-save history is '
  'additionally written to audit_logs with action=''notification_access.updated''.';

-- NO SECONDARY INDEX, deliberately. The only read is "give me every denial"
-- (SELECT ... WHERE enabled = false), bounded at ~2,380 rows and cached in
-- process for 60s, so it is a seq scan of a couple of pages once a minute per
-- process. The primary key already covers the upsert. Do not add one.
