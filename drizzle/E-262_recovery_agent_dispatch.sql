-- E-262: Recovery agent dispatch — the physical leg between "flagged" and "on the bench".
--
-- WHAT THIS ADDS, AND WHY.
--
-- Flagging a loan for recovery (E-035) writes three rows and stops: the flag on
-- `loan_sanctions`, a `nbfc_recovery_pipeline` row at 'needs_inspection', and a
-- `recovery_batteries` stub. Inspection (E-036) then assumes the battery is
-- already on a bench. Between those two facts sits a job nobody has recorded:
-- somebody drives to the borrower, finds the battery, photographs it and brings
-- it back. Today that is arranged over WhatsApp, and the CRM learns about it
-- only when a warehouse operator eventually types the battery in by hand — with
-- no evidence of where it was collected, by whom, or in what condition.
--
-- This is that leg:
--
--   1. The NBFC keeps a directory of recovery agents. They are NOT iTarang
--      users and have no login — the same stance `nbfc_fi_agents` (E-148) takes
--      for field-investigation agents, and for the same reason: an agent is a
--      contact you dispatch to, not an account you provision.
--   2. Assigning one creates an assignment and mails a SINGLE-USE LINK.
--   3. The agent opens that link on their phone AT THE ADDRESS. It captures
--      live GPS and camera photos, watermarked with coordinates and server
--      time, plus the condition they found the battery in.
--   4. The NBFC reviews the photographs and approves. Approval stamps the
--      battery master and hands the battery to the inspection wizard, which is
--      where E-036 always expected to pick it up.
--
-- MODELLED ON FIELD INVESTIGATION, DELIBERATELY. `field_investigations`
-- (E-148) already solves assign → tokenised link → GPS + photo capture →
-- reviewer decision, and it solved several things the hard way: the link must
-- be minted before dispatch so a bounced email does not lose the assignment;
-- the token must be consumed in the same statement as the success flip or a
-- retry locks the agent out; GPS must be re-checked server-side. Mirroring that
-- table's shape is how those lessons carry over.
--
-- WHAT IS DELIBERATELY DIFFERENT.
--
--   `cancel_reason` / `cancel_source` and a KEPT ROW. FI collapses invalid,
--   expired, submitted and cancelled into one dead-token message. For recovery
--   that is not good enough: an agent whose collection was called off because
--   the borrower paid must be told "do not collect", not "your link is broken",
--   or they will collect anyway. The row survives cancellation so the public
--   form can say which of the four things happened.
--
--   THE OPEN-ASSIGNMENT INDEX. "One live assignment per loan" is enforced here,
--   not in the service. A select-then-insert guard is a race, and two agents
--   dispatched to one borrower is the kind of mistake that ends up in a
--   complaint rather than a log.
--
-- ALSO IN THIS FILE: a unique index E-232 should have created.
-- `nbfc_recovery_pipeline (tenant_id, battery_serial)` is treated as unique by
-- everything that reads it — `flagLoanForRecovery` find-or-creates on that
-- pair, and the Recovery queue builds a serial→row map from it — but E-232
-- created three plain indexes and no uniqueness. The assign guard added here
-- reads the stage off that row, so a duplicate would make the guard a coin
-- flip. Verified clean before adding.
--
-- Strictly additive: three new tables, one new unique index on an existing
-- table. Nothing is dropped, narrowed or backfilled.

-- ---------------------------------------------------------------------------
-- 1. The agent directory
-- ---------------------------------------------------------------------------
-- Per-NBFC, and lightweight on purpose: name, a way to reach them, where they
-- work. Mirrors nbfc_fi_agents field for field so an NBFC that already keeps
-- one directory finds the second one familiar.
CREATE TABLE IF NOT EXISTS nbfc_recovery_agents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  nbfc_id            integer,
  name               varchar(200) NOT NULL,
  -- Phone is required and email is not, matching nbfc_fi_agents. A recovery
  -- agent is reached on a phone; email is the link wire when they have one.
  phone              varchar(20) NOT NULL,
  email              varchar(200),
  city               varchar(120),
  -- Free text — "Ranchi + 60km", "all Jharkhand". Not a structured geofence:
  -- the coordinator picks the agent, the field is there to help them pick.
  coverage_area      text,
  -- email | sms | whatsapp
  preferred_channel  varchar(12) NOT NULL DEFAULT 'email',
  -- A photo of the agent, so a reviewer can compare it against the selfie the
  -- field form captures. Same purpose as nbfc_fi_agents.reference_photo_url.
  reference_photo_url text,
  -- Soft delete. History points at the agent, so rows are deactivated rather
  -- than removed.
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS nbfc_recovery_agents_tenant_active_idx
  ON nbfc_recovery_agents (tenant_id, active);

-- ---------------------------------------------------------------------------
-- 2. The dispatch
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recovery_assignments (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL,
  -- varchar, NOT uuid — `loan_sanctions.id` is character varying here. Same
  -- note as recovery_batteries.loan_sanction_id (E-232).
  loan_sanction_id        varchar(255) NOT NULL,
  recovery_pipeline_id    uuid,
  battery_id              uuid,
  -- Copied at assign and NULLABLE: a flag raised without a serial has none, and
  -- the agent supplies it on the field form. That is the right place to ask —
  -- they are the person holding the battery.
  battery_serial          varchar(64),

  -- History, like field_investigations: a rejected or cancelled attempt keeps
  -- its row and its photographs, and the next dispatch is attempt_no + 1.
  attempt_no              integer NOT NULL DEFAULT 1,
  is_current              boolean NOT NULL DEFAULT true,

  -- assigned | in_progress | collected | completed | rejected | cancelled
  --
  -- No CHECK and no enum, matching every other status column in the
  -- recovery/auction family — the vocabulary lives in TypeScript
  -- (src/lib/nbfc/recovery/assignment.ts) so it can move without a migration
  -- against a drifting database. See the E-232 header for the same decision.
  --
  -- `assigned` vs `in_progress` is not decoration: `assigned` means the link
  -- exists but the send was never confirmed, `in_progress` means the agent has
  -- it. Without the distinction a bounced email is indistinguishable from an
  -- agent who simply has not set off yet.
  status                  varchar(24) NOT NULL DEFAULT 'assigned',

  -- ---- who ----
  agent_id                uuid REFERENCES nbfc_recovery_agents(id),
  -- Denormalised so a renamed or deactivated agent does not rewrite history.
  agent_name              varchar(200),
  agent_phone             varchar(20),
  assigned_by             uuid,
  assigned_at             timestamptz,
  due_at                  timestamptz,

  -- ---- the single-use link ----
  link_token              varchar(80),
  link_sent_at            timestamptz,
  link_channel            varchar(12),
  link_expires_at         timestamptz,
  -- Kept so the queue can show WHY nobody was reached, instead of a row that
  -- silently reads 'assigned' forever.
  dispatch_error          text,

  -- ---- what the agent recorded ----
  collected_at            timestamptz,
  gps_lat                 numeric(10,7),
  gps_lng                 numeric(10,7),
  gps_accuracy_m          numeric(8,2),
  -- Server clock, not the handset's. A phone's time is user-settable and this
  -- is evidence.
  gps_server_timestamp    timestamptz,
  -- The geocoded borrower address, frozen at assign — the anchor the collection
  -- distance is measured from. Null when no geocoding key is configured, which
  -- the review panel must say out loud rather than rendering a silent dash.
  stated_lat              numeric(10,7),
  stated_lng              numeric(10,7),
  distance_from_address_m numeric(10,2),
  condition_notes         text,
  agent_declaration_at    timestamptz,

  -- ---- the NBFC's decision ----
  reviewed_by             uuid,
  reviewed_at             timestamptz,
  -- approve | reject
  review_decision         varchar(16),
  review_notes            text,

  -- ---- cancellation ----
  cancelled_at            timestamptz,
  -- NULL when the system cancelled it: nobody clicked, the borrower paid.
  cancelled_by            uuid,
  cancel_reason           text,
  -- manual | emi_payment | reassigned
  cancel_source           varchar(24),

  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- ONE LIVE ASSIGNMENT PER LOAN, enforced by the database.
--
-- The service checks this too, but a check is a select-then-insert and two
-- coordinators clicking Assign at the same moment would both pass it. Two
-- agents turning up at one borrower's door is not a data-quality problem, it is
-- a phone call from the borrower. A drizzle index builder cannot express the
-- WHERE, so this lives only here — see the note in schema.ts.
CREATE UNIQUE INDEX IF NOT EXISTS recovery_assignments_open_unique
  ON recovery_assignments (loan_sanction_id)
  WHERE is_current AND status IN ('assigned', 'in_progress', 'collected');

-- The token is the credential on an UNAUTHENTICATED route and the lookup key
-- for every request the agent makes. FI left its equivalent unindexed.
CREATE UNIQUE INDEX IF NOT EXISTS recovery_assignments_link_token_unique
  ON recovery_assignments (link_token)
  WHERE link_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS recovery_assignments_tenant_status_idx
  ON recovery_assignments (tenant_id, status);
CREATE INDEX IF NOT EXISTS recovery_assignments_loan_idx
  ON recovery_assignments (loan_sanction_id);

-- ---------------------------------------------------------------------------
-- 3. The evidence
-- ---------------------------------------------------------------------------
-- One row per photograph, mirroring field_investigation_photos (E-148). The
-- coordinates are stored structurally as well as burned into the image: the
-- watermark is what a human reads, the columns are what the auto-flags compute
-- distance and accuracy from.
CREATE TABLE IF NOT EXISTS recovery_assignment_photos (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id        uuid NOT NULL REFERENCES recovery_assignments(id) ON DELETE CASCADE,
  -- serial | battery | vehicle | agent_selfie | extra
  photo_type           varchar(24) NOT NULL,
  -- Relative storage path, never an absolute URL — the backend flips between
  -- Supabase and S3 behind STORAGE_BACKEND and a signed URL would rot.
  image_url            text NOT NULL,
  gps_lat              numeric(10,7),
  gps_lng              numeric(10,7),
  gps_server_timestamp timestamptz,
  -- watermarkPhoto() never throws; it reports whether it managed to stamp the
  -- image. A photograph that could not be stamped is still evidence, but the
  -- reviewer is entitled to know it is unstamped.
  watermark_applied    boolean NOT NULL DEFAULT false,
  uploaded_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recovery_assignment_photos_assignment_idx
  ON recovery_assignment_photos (assignment_id);

-- One photo per named slot. The agent's phone auto-retries a failed submit, and
-- without this a dropped connection mid-upload leaves two rows for the same
-- shot. `extra` is exempt — extras are a bag, not a slot.
CREATE UNIQUE INDEX IF NOT EXISTS recovery_assignment_photos_slot_unique
  ON recovery_assignment_photos (assignment_id, photo_type)
  WHERE photo_type <> 'extra';

-- ---------------------------------------------------------------------------
-- 4. The uniqueness E-232 assumed but never wrote
-- ---------------------------------------------------------------------------
-- `flagLoanForRecovery` find-or-creates a pipeline row on (tenant_id,
-- battery_serial), and the Recovery queue builds a serial → row map from the
-- same pair. Both are already written as if this constraint existed. The assign
-- guard added by this feature reads the stage off that row to decide whether
-- recovery has physically started, so a duplicate would make it a coin flip.
--
-- Not wrapped in a DO block: if this fails, the pair is NOT unique on this
-- database and that is a fact worth stopping on rather than skipping past.
-- Check first, and reconcile the duplicates by hand:
--
--   SELECT tenant_id, battery_serial, count(*)
--     FROM nbfc_recovery_pipeline
--    GROUP BY 1, 2 HAVING count(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS nbfc_recovery_pipeline_tenant_serial_unique
  ON nbfc_recovery_pipeline (tenant_id, battery_serial);

-- ---------------------------------------------------------------------------
-- Self-documentation
-- ---------------------------------------------------------------------------
COMMENT ON TABLE nbfc_recovery_agents IS
  'E-262: per-NBFC directory of battery recovery agents. NOT iTarang users and no login — contact records used to dispatch a single-use collection link. Mirrors nbfc_fi_agents (E-148). Deactivated, never deleted: assignments reference them.';
COMMENT ON TABLE recovery_assignments IS
  'E-262: one dispatch of a recovery agent to collect a flagged battery. status: assigned|in_progress|collected|completed|rejected|cancelled. assigned = link minted, delivery unconfirmed; in_progress = the agent has it. History rows carry is_current=false.';
COMMENT ON COLUMN recovery_assignments.link_token IS
  'E-262: single-use credential for the public /recovery-agent/<token> form. Consumed in the same UPDATE as the success flip, so a failed submit leaves it live and the agent can retry.';
COMMENT ON COLUMN recovery_assignments.cancel_source IS
  'E-262: manual | emi_payment | reassigned. emi_payment means the borrower cleared their arrears before collection and the agent was stood down automatically.';
COMMENT ON COLUMN recovery_assignments.stated_lat IS
  'E-262: geocoded borrower address, frozen at assign. The anchor distance_from_address_m is measured from. NULL when no geocoding key is configured.';
COMMENT ON TABLE recovery_assignment_photos IS
  'E-262: one row per photograph taken at collection, watermarked with GPS + server time. photo_type: serial|battery|vehicle|agent_selfie|extra. Mirrors field_investigation_photos (E-148).';
COMMENT ON INDEX recovery_assignments_open_unique IS
  'E-262: one live assignment per loan. In the database rather than the service because the service check is a select-then-insert race, and two agents at one door is a complaint, not a log entry.';
COMMENT ON INDEX nbfc_recovery_pipeline_tenant_serial_unique IS
  'E-262: uniqueness E-232 assumed but never created. flagLoanForRecovery find-or-creates on this pair and the Recovery queue maps by it.';
