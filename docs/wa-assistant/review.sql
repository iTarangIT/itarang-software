-- WhatsApp Sales Assistant — daily log review (RUNBOOK §7).
--
-- READ-ONLY. Paste any block into a SQL editor, or run them all:
--   node --import tsx --env-file=.env.production scripts/wa-assistant-daily-review.ts [--since '7 days']
-- Every block is `-- name: <id>` then ONE statement. The window is the literal
-- interval '24 hours' — the script swaps it for --since.
--
-- Blocks marked MUST BE EMPTY are the BRD go/no-go ("zero permission leaks,
-- zero unconfirmed writes"): any row is an incident — pause the Assistant
-- (RUNBOOK §5) and investigate before anything else.

-- name: leak_write_on_foreign_lead
-- MUST BE EMPTY. A confirmed write whose lead, right after the write, was not
-- owned by the rep who confirmed it (the executor asserts ownership inside the
-- write transaction, so this should be impossible).
SELECT a.id AS action_id, a.tool, a.lead_id, a.user_id, a.after->>'current_owner_id' AS owner_after, a.executed_at
  FROM assistant_actions a
 WHERE a.status = 'confirmed'
   AND a.executed_at > now() - interval '24 hours'
   AND a.after->>'current_owner_id' IS DISTINCT FROM a.user_id::text
 ORDER BY a.executed_at;

-- name: leak_sensitive_outbound
-- MUST BE EMPTY. A reply that looks like it carries a PAN or an unmasked
-- 12-digit Aadhaar (redaction should have masked both before sending).
SELECT m.id, m.user_id, m.created_at, left(m.text, 200) AS text
  FROM assistant_wa_messages m
 WHERE m.direction = 'out'
   AND m.created_at > now() - interval '24 hours'
   AND (m.text ~ '\m[A-Z]{5}[0-9]{4}[A-Z]\M' OR m.text ~ '\m[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{4}\M')
 ORDER BY m.created_at;

-- name: leak_served_ineligible_user
-- MUST BE EMPTY. An inbound message the Assistant ANSWERED (agent or tap) for
-- a user who is, now, inactive or outside asm / inside_sales_rep. A row may be
-- a role change made after the message: check users' audit before escalating.
SELECT m.id, m.user_id, u.role, u.is_active, m.handling, m.created_at
  FROM assistant_wa_messages m
  JOIN users u ON u.id = m.user_id
 WHERE m.direction = 'in'
   AND m.created_at > now() - interval '24 hours'
   AND m.handling IN ('text_agent', 'tap_confirm', 'tap_cancel', 'tap_lead')
   AND (u.is_active IS NOT TRUE OR u.role NOT IN ('asm', 'inside_sales_rep'))
 ORDER BY m.created_at;

-- name: unconfirmed_write
-- MUST BE EMPTY. A confirmed action with no Confirm TAP from the same user
-- recorded against it — i.e. a write that did not come from a button.
SELECT a.id AS action_id, a.tool, a.lead_id, a.user_id, a.executed_at
  FROM assistant_actions a
 WHERE a.status = 'confirmed'
   AND a.executed_at > now() - interval '24 hours'
   AND NOT EXISTS (
         SELECT 1 FROM assistant_wa_messages m
          WHERE m.action_id = a.id AND m.user_id = a.user_id
            AND m.direction = 'in' AND m.handling = 'tap_confirm')
 ORDER BY a.executed_at;

-- name: stuck_executing
-- MUST BE EMPTY. Actions left mid-write for over 5 minutes. The 60 s sweep
-- fails these; rows here mean the sweep is not running (check the boot log for
-- "wa-assistant action sweep (60s) started").
SELECT id AS action_id, tool, lead_id, user_id, updated_at
  FROM assistant_actions
 WHERE status = 'executing' AND updated_at < now() - interval '5 minutes'
 ORDER BY updated_at;

-- name: unhandled_inbound
-- Messages recorded but never finished by the router (after() dropped by a
-- restart, or a crash). A few around a deploy are expected; a steady trickle
-- is not. The rep got no reply — someone should.
SELECT id, provider_message_id, wa_phone, type, user_id, created_at
  FROM assistant_wa_messages
 WHERE direction = 'in' AND handled_at IS NULL
   AND created_at > now() - interval '24 hours'
   AND created_at < now() - interval '5 minutes'
 ORDER BY created_at;

-- name: errors
-- Turns that ended in the generic "nothing was changed" reply, and failed
-- actions, with their reasons. `rejected: stale` / `not_owner` / `not_claimable`
-- are the guards working, not bugs.
SELECT 'message' AS kind, handling AS what, count(*) AS n, max(created_at) AS last_at, left(max(error), 200) AS sample_error
  FROM assistant_wa_messages
 WHERE direction = 'in' AND handling = 'error' AND created_at > now() - interval '24 hours'
 GROUP BY handling
UNION ALL
SELECT 'action', coalesce(error, status), count(*), max(updated_at), NULL
  FROM assistant_actions
 WHERE status = 'failed' AND updated_at > now() - interval '24 hours'
 GROUP BY coalesce(error, status)
UNION ALL
SELECT 'tool_call', tool || ': ' || coalesce(error, 'error result'), count(*), max(created_at), NULL
  FROM assistant_tool_calls
 WHERE ok = false AND created_at > now() - interval '24 hours'
 GROUP BY tool, error
 ORDER BY n DESC;

-- name: voice_notes
-- Voice notes by outcome. A transcribed one ends as text_agent / typed_confirm /
-- text_busy like typed text (type stays 'audio'); voice_* = nothing heard, too
-- long, unsupported format (audio/amr) or a failed download/transcription.
SELECT handling, count(*) AS messages, count(DISTINCT user_id) AS users,
       (array_agg(error ORDER BY created_at DESC) FILTER (WHERE error IS NOT NULL))[1] AS last_error
  FROM assistant_wa_messages
 WHERE direction = 'in' AND type = 'audio' AND created_at > now() - interval '24 hours'
 GROUP BY handling
 ORDER BY messages DESC;

-- name: voice_transcripts
-- What was heard, for spot-checking accuracy against what the rep meant (the
-- next message is often the rep correcting it).
SELECT m.created_at, u.name, m.handling, m.text AS heard
  FROM assistant_wa_messages m
  LEFT JOIN users u ON u.id = m.user_id
 WHERE m.direction = 'in' AND m.type = 'audio' AND m.text IS NOT NULL
   AND m.created_at > now() - interval '24 hours'
 ORDER BY m.created_at DESC
 LIMIT 50;

-- name: media_by_type
-- Images, stickers, documents … (and voice notes while WA_ASSIST_VOICE_DISABLED)
-- each got the fixed "type it" reply (BRD UC-14).
SELECT type, count(*) AS messages, count(DISTINCT user_id) AS users
  FROM assistant_wa_messages
 WHERE direction = 'in' AND handling = 'media' AND created_at > now() - interval '24 hours'
 GROUP BY type
 ORDER BY messages DESC;

-- name: link_attempts
-- LINK activity per number. 5 × link_failed within an hour locks the number
-- for an hour (link_locked). Many numbers failing = someone guessing codes.
SELECT wa_phone,
       count(*) FILTER (WHERE handling = 'link_ok')         AS ok,
       count(*) FILTER (WHERE handling = 'link_failed')     AS failed,
       count(*) FILTER (WHERE handling = 'link_locked')     AS locked,
       count(*) FILTER (WHERE handling = 'link_ineligible') AS ineligible,
       max(created_at) AS last_at
  FROM assistant_wa_messages
 WHERE direction = 'in' AND handling LIKE 'link_%' AND created_at > now() - interval '24 hours'
 GROUP BY wa_phone
HAVING count(*) FILTER (WHERE handling <> 'link_ok') > 0
 ORDER BY failed DESC, locked DESC;

-- name: revoked_number_attempts
-- Messages from numbers with no active binding. These rows carry no user_id
-- (identity trusts only ACTIVE bindings); the rep is the latest revoked
-- binding on that phone. Repeated attempts from a revoked number = a lost or
-- handed-over phone: call the rep.
SELECT m.wa_phone, count(*) AS messages, max(m.created_at) AS last_at,
       b.user_id AS last_bound_user, u.name AS last_bound_name, b.revoked_reason, b.revoked_at
  FROM assistant_wa_messages m
  LEFT JOIN LATERAL (
        SELECT user_id, revoked_reason, revoked_at FROM assistant_wa_bindings
         WHERE wa_phone = m.wa_phone AND status = 'revoked'
         ORDER BY revoked_at DESC LIMIT 1) b ON true
  LEFT JOIN users u ON u.id = b.user_id
 WHERE m.direction = 'in' AND m.handling = 'unlinked' AND m.created_at > now() - interval '24 hours'
 GROUP BY m.wa_phone, b.user_id, u.name, b.revoked_reason, b.revoked_at
 ORDER BY messages DESC;

-- name: usage_per_user
-- The daily usage report: per rep — messages, previews, and how they ended.
SELECT u.name, u.role, x.*
  FROM (
        SELECT user_id,
               (SELECT count(*) FROM assistant_wa_messages m
                 WHERE m.user_id = a.user_id AND m.direction = 'in' AND m.created_at > now() - interval '24 hours') AS messages_in,
               count(*)                                        AS previews,
               count(*) FILTER (WHERE status = 'confirmed')    AS confirmed,
               count(*) FILTER (WHERE status = 'cancelled')    AS cancelled,
               count(*) FILTER (WHERE status = 'expired')      AS expired,
               count(*) FILTER (WHERE status = 'failed')       AS failed,
               count(*) FILTER (WHERE status = 'escalated')    AS high_impact_step1,
               count(*) FILTER (WHERE status = 'pending')      AS still_pending
          FROM assistant_actions a
         WHERE a.created_at > now() - interval '24 hours'
         GROUP BY user_id
       ) x
  JOIN users u ON u.id = x.user_id
 ORDER BY x.previews DESC;

-- name: adoption_share
-- BRD go/no-go: the share of each rep's calls and visits that were logged
-- through WhatsApp. Screen-logged work counts in `total`, WhatsApp-logged in
-- both. Only reps who used the Assistant in the window appear.
WITH wa AS (
    SELECT user_id,
           count(*) FILTER (WHERE tool = 'log_call' AND input->>'channel' = 'call') AS wa_calls,
           count(*) FILTER (WHERE tool = 'log_visit')                                AS wa_visits
      FROM assistant_actions
     WHERE status = 'confirmed' AND executed_at > now() - interval '24 hours'
     GROUP BY user_id
), all_work AS (
    SELECT performed_by,
           count(*) FILTER (WHERE touchpoint_type = 'inside_sales_call') AS calls,
           count(*) FILTER (WHERE touchpoint_type = 'visit')             AS visits
      FROM lead_touchpoints
     WHERE created_at > now() - interval '24 hours'
       AND touchpoint_type IN ('inside_sales_call', 'visit')
     GROUP BY performed_by
)
SELECT u.name, u.role,
       wa.wa_calls, coalesce(w.calls, 0) AS total_calls,
       wa.wa_visits, coalesce(w.visits, 0) AS total_visits,
       round(100.0 * (wa.wa_calls + wa.wa_visits) / nullif(coalesce(w.calls, 0) + coalesce(w.visits, 0), 0), 1) AS pct_via_whatsapp
  FROM wa
  JOIN users u ON u.id = wa.user_id
  LEFT JOIN all_work w ON w.performed_by = wa.user_id::text
 ORDER BY pct_via_whatsapp DESC NULLS LAST;

-- name: outbound_failures
-- Replies Meta refused or never delivered (token expired, 24-hour window
-- closed, number blocked…). A burst after a deploy usually means a bad
-- WA_ASSIST_ACCESS_TOKEN.
SELECT coalesce(delivery_status, 'send_error') AS status, left(error, 160) AS error, count(*) AS n, max(created_at) AS last_at
  FROM assistant_wa_messages
 WHERE direction = 'out' AND created_at > now() - interval '24 hours'
   AND (delivery_status = 'failed' OR error IS NOT NULL)
 GROUP BY 1, 2
 ORDER BY n DESC;

-- name: tool_latency
-- Per tool: calls and p50 / p95 latency (ms). The whole turn has a 45 s budget;
-- a p95 creeping past ~10 s makes turns time out.
SELECT tool, count(*) AS calls,
       percentile_disc(0.5)  WITHIN GROUP (ORDER BY latency_ms) AS p50_ms,
       percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_ms
  FROM assistant_tool_calls
 WHERE created_at > now() - interval '24 hours'
 GROUP BY tool
 ORDER BY calls DESC;
