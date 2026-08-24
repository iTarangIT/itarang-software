-- E-263: Visit attempts — the doorstep the agent reached and nobody answered.
--
-- WHAT THIS ADDS, AND WHY.
--
-- E-262 modelled a collection as one event: an agent is dispatched, the agent
-- collects, the NBFC reviews. Real repossession is not shaped like that. The
-- agent drives out, knocks, and the customer is not home — or is home and
-- refuses, or the address turns out to be wrong. None of those is a collection
-- and none of them is a failure of the agent; they are the normal texture of
-- the job, and until now the product had no way to record any of them.
--
-- The consequence was worse than a missing field. An agent who went and found
-- nobody had exactly two options in the UI: submit a collection that did not
-- happen, or do nothing — and "do nothing" is indistinguishable from an agent
-- who never left the house. The work was invisible precisely when somebody
-- needed proof it had been done.
--
-- ONE ROW PER VISIT, NOT A SET OF COLUMNS ON THE ASSIGNMENT.
--
-- The obvious cheap version is `last_visit_at` / `visit_outcome` /
-- `next_visit_at` on `recovery_assignments`. That is wrong for the one case
-- that matters: a third visit overwrites the second, and "we attended twice at
-- the agreed time and nobody was there" is the whole evidentiary point. A
-- borrower disputing a repossession, or an ombudsman asking whether the NBFC
-- made reasonable attempts, is asking about the HISTORY. So attempts are
-- append-only, each with its own GPS fix and server timestamp.
--
-- WHAT STAYS ON THE PARENT. Two derived columns, because the recovery queue
-- needs them on the row without a subquery per line:
--   next_visit_at        when the agent said they will go back
--   visit_attempt_count  how many times they have already been
-- Both are maintained by the service alongside the insert. They are a cache of
-- the log, never a substitute for it.
--
-- THE TOKEN SURVIVES A FAILED VISIT. This is the reason `link_token` is not
-- consumed by an attempt: the agent is going back, on the same job, with the
-- same link. Only a completed collection consumes it. If the agreed return date
-- falls outside the link's window, the service pushes `link_expires_at` out to
-- cover it — a link that dies before the visit it was issued for is a support
-- call, not a security control.
--
-- Strictly additive: one new table, two new nullable/defaulted columns on
-- recovery_assignments. Nothing is dropped, narrowed or backfilled.

-- ---------------------------------------------------------------------------
-- 1. The log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recovery_visit_attempts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id        uuid NOT NULL REFERENCES recovery_assignments(id) ON DELETE CASCADE,
  tenant_id            uuid NOT NULL,
  -- 1, 2, 3… within one assignment. Assigned by the service, not a sequence,
  -- because it is the agent's count of journeys and reads that way in the UI.
  attempt_no           integer NOT NULL DEFAULT 1,

  -- not_present | refused | address_not_found | battery_missing | other
  --
  -- No CHECK and no enum, matching every other status column in this family —
  -- the vocabulary lives in src/lib/nbfc/recovery/assignment.ts so it can move
  -- without a migration against a drifting database. See the E-232 header.
  --
  -- `collected` is deliberately NOT one of these: a successful collection is
  -- the assignment's own terminal write, not an attempt row, and duplicating it
  -- here would create two disagreeing records of the same fact.
  outcome              varchar(24) NOT NULL,

  -- Where the agent actually was. This is the proof the journey happened, so it
  -- is required by the service even though the column is nullable — a legacy
  -- row written before that rule is better than a rejected write.
  gps_lat              numeric(10,7),
  gps_lng              numeric(10,7),
  gps_accuracy_m       numeric(8,2),
  -- Server clock. A handset's time is user-settable and this is evidence.
  gps_server_timestamp timestamptz,
  -- Metres from the geocoded borrower address, when there was an anchor to
  -- measure from. Same computation the collection submit does.
  distance_from_address_m numeric(10,2),

  notes                text,
  -- When the agent says they will return. Nullable: "nobody home and I am not
  -- going back" is a real answer, and forcing a date would invent one.
  next_visit_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recovery_visit_attempts_assignment_idx
  ON recovery_visit_attempts (assignment_id, created_at);
CREATE INDEX IF NOT EXISTS recovery_visit_attempts_tenant_idx
  ON recovery_visit_attempts (tenant_id, created_at);

-- One row per (assignment, attempt_no). The agent's phone retries a failed
-- submit, and without this a dropped connection turns one wasted journey into
-- two rows claiming two.
CREATE UNIQUE INDEX IF NOT EXISTS recovery_visit_attempts_no_unique
  ON recovery_visit_attempts (assignment_id, attempt_no);

-- ---------------------------------------------------------------------------
-- 2. The parent's cache of it
-- ---------------------------------------------------------------------------
ALTER TABLE recovery_assignments
  ADD COLUMN IF NOT EXISTS next_visit_at timestamptz;

ALTER TABLE recovery_assignments
  ADD COLUMN IF NOT EXISTS visit_attempt_count integer NOT NULL DEFAULT 0;

-- The queue's "who is overdue for a return visit" view.
CREATE INDEX IF NOT EXISTS recovery_assignments_next_visit_idx
  ON recovery_assignments (tenant_id, next_visit_at)
  WHERE next_visit_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Self-documentation
-- ---------------------------------------------------------------------------
COMMENT ON TABLE recovery_visit_attempts IS
  'E-263: append-only log of doorstep visits that did NOT end in a collection. outcome: not_present|refused|address_not_found|battery_missing|other. One row per journey, each with its own GPS fix — the history is the evidence that reasonable attempts were made, so it is never overwritten.';
COMMENT ON COLUMN recovery_visit_attempts.next_visit_at IS
  'E-263: when the agent said they will return. NULL is a real answer — "nobody home and I am not going back".';
COMMENT ON COLUMN recovery_visit_attempts.outcome IS
  'E-263: why the visit did not produce a battery. Never ''collected'' — a successful collection is the assignment''s own terminal write, not an attempt row.';
COMMENT ON COLUMN recovery_assignments.next_visit_at IS
  'E-263: cache of the latest attempt''s next_visit_at, so the recovery queue can show it without a subquery per row. The log is authoritative.';
COMMENT ON COLUMN recovery_assignments.visit_attempt_count IS
  'E-263: cache of how many failed visits this assignment has logged. The log is authoritative.';
