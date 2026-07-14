-- E-186 — Make the stored hypothesis text match the test that actually runs,
--         and stop it from hard-coding threshold values that are governed
--         elsewhere.
--
-- Two problems, both surfaced to operators in the Risk card drawer under the
-- heading "Hypothesis":
--
--   1. geo-shift claimed it flagged vehicles "more than 100 km from their
--      onboarding region centroid". There are no onboarding centroids in this
--      system. The code (evalGeoShift) actually checked whether the vehicle's
--      current position fell outside a bounding box of *India* — i.e. it would
--      only fire if an e-rickshaw left the country. For an RBI-supervised
--      lender, telling a credit officer you tested one thing while testing
--      another is a compliance problem, not just a bug. The evaluator now
--      measures distance from the vehicle's own 30-day home cluster against the
--      governed geo_shift_km rule, and this text says so.
--
--   2. Every description hard-coded its numbers ("at least 40%", "7+ days",
--      "over 6 hours"). Those numbers now come from nbfc_risk_rules and can be
--      changed by an admin behind the two-person approval gate — at which point
--      the frozen text becomes a lie again. The descriptions are now written in
--      terms of the rule that governs them; the resolved value for a given run
--      is recorded in risk_card_runs.evidence_json.thresholds and shown in the
--      drawer's methodology notes.
--
-- Idempotent: re-running simply re-applies the same text.

UPDATE risk_hypotheses SET description =
  'Borrowers whose 7-day km has fallen below their prior 7-day baseline by at least the governed usage_drop_pct threshold. Sharp utilization drops historically precede payment delinquency by 2-3 weeks. Vehicles with under 50 km in the prior 7 days are excluded as too idle to measure.'
 WHERE slug = 'usage-drop-7d';

UPDATE risk_hypotheses SET description =
  'Loans past due by at least the governed emi_overdue_days threshold whose vehicles have not reported GPS for longer than the governed offline_alert_hours threshold. Non-payment combined with telemetry silence signals concealment risk. Scored against the overdue pool, not the whole book.'
 WHERE slug = 'dpd-7-no-telemetry';

UPDATE risk_hypotheses SET
  title = 'Vehicle far from its usual operating area',
  description =
  'Vehicles whose current position is further than the governed geo_shift_km threshold from their own home base — the most-visited ~11 km GPS cell over the last 30 days, i.e. the depot the vehicle habitually returns to. Possible asset diversion. Vehicles without enough GPS history to establish a home base are excluded rather than scored.'
 WHERE slug = 'geo-shift';

UPDATE risk_hypotheses SET description =
  'Vehicles whose State-of-Health has dropped more than 5 percentage points in the last 30 days. Affects both asset value and operator income. Scored against the vehicles that have an SOH reading at both ends of the window; the rest are excluded as unmeasurable. The 5pp threshold is hard-coded — there is no battery-degradation rule in the risk-rule catalogue.'
 WHERE slug = 'battery-soh-decay';

UPDATE risk_hypotheses SET description =
  'Loans with a current EMI obligation whose vehicles averaged under 20 km/day across the days they actually reported, inside a 14-day window. Operator may be churning or sub-letting. Vehicles reporting on fewer than 7 of the 14 days are excluded — a missing day is a telemetry gap, not a zero-km day. The 20 km/day threshold is hard-coded; there is no utilisation rule in the risk-rule catalogue.'
 WHERE slug = 'low-utilization-active-loan';
