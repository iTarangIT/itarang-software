-- E-157 — Repair Field Investigation rows orphaned by the pre-E-156 bug.
--
-- BACKGROUND: before E-156, a re-inspection's INSERT of a second attempt row
-- violated the surviving full unique index "field_investigations_lead_nbfc_unique".
-- Because the close-update and the insert were NOT in a transaction, the only
-- attempt got flipped to is_current=false while the replacement was never
-- created. Result: getCurrentFiTrack returns null and the lead shows
-- "BAD_REQUEST: no current FI attempt — assign an agent first", with no way to
-- recover from the UI (re-inspection needs a current attempt to act on).
--
-- This promotes the latest attempt of every orphaned (lead × NBFC) back to
-- is_current=true. If that row is the one a failed re-inspection closed
-- (status='re_inspection_requested'), it is reverted to its pre-reinspect
-- 'submitted' state with the decision fields cleared, so the Coordinator can
-- decide or re-inspect again (now that E-156 makes the insert succeed).
--
-- Idempotent: once every pair has a current row, the orphaned set is empty and
-- re-running is a no-op. Run AFTER E-156.

DO $do$ BEGIN
  WITH latest AS (
    SELECT DISTINCT ON (lead_id, nbfc_id) id, lead_id, nbfc_id
    FROM field_investigations
    ORDER BY lead_id, nbfc_id, attempt_no DESC, created_at DESC
  ),
  orphaned AS (
    SELECT l.id
    FROM latest l
    WHERE NOT EXISTS (
      SELECT 1 FROM field_investigations f
      WHERE f.lead_id = l.lead_id AND f.nbfc_id = l.nbfc_id AND f.is_current = true
    )
  )
  UPDATE field_investigations f
  SET is_current      = true,
      status          = CASE WHEN f.status = 're_inspection_requested' THEN 'submitted' ELSE f.status END,
      decision        = CASE WHEN f.status = 're_inspection_requested' THEN NULL ELSE f.decision END,
      decision_reason = CASE WHEN f.status = 're_inspection_requested' THEN NULL ELSE f.decision_reason END,
      decided_by      = CASE WHEN f.status = 're_inspection_requested' THEN NULL ELSE f.decided_by END,
      decided_at      = CASE WHEN f.status = 're_inspection_requested' THEN NULL ELSE f.decided_at END,
      updated_at      = now()
  FROM orphaned o
  WHERE f.id = o.id;
EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'skip: field_investigations table absent';
END; $do$;
