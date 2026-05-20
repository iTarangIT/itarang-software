#!/usr/bin/env node
// One-shot sync that closes the cost-analytics data gap surfaced in May 2026:
// `ai_call_logs` was missing ~110 of 150 ElevenLabs conversations in the
// rolling 30-day window because (a) most calls were placed outside the
// dialer_campaign_leads flow and (b) some webhooks dropped. Paginate the
// ElevenLabs LIST API for a given agent_id + date range, then for each
// conversation fetch DETAIL and upsert into ai_call_logs (cost + duration
// computed at the ElevenLabs INR billing rate -- this account is invoiced in
// rupees, see src/lib/ai/elevenlabs/fetchCallCost.ts).
//
// Run:
//   node scripts/sync-elevenlabs-conversations.mjs \
//     --agent agent_7301kpwppx5kfjr8wpt9qwb4fg8m \
//     --from 2026-04-19 --to 2026-05-19
//
// Env: ELEVENLABS_API_KEY, DATABASE_URL, ELEVENLABS_INR_PER_CREDIT (optional)
//
// Idempotent: re-running is a no-op for rows that already exist with cost.
// Updates rows that exist but lack call_duration (the original bug #1).

import { config } from "dotenv";
config({ path: ".env.local" });

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((acc, v, i, arr) => {
      if (v.startsWith("--")) acc.push([v.slice(2), arr[i + 1]]);
      return acc;
    }, []),
);

// agent_id is OPTIONAL: when omitted, the sync pulls the *entire workspace*,
// matching what ElevenLabs Developers → Analytics → Usage reports. Pass
// `--agent <id>` to restrict to a single agent.
const AGENT_ID = args.agent || process.env.AGENT_ID || "";
const FROM_DATE = args.from || "2026-04-19";
const TO_DATE = args.to || "2026-05-19";
const DRY_RUN = process.argv.includes("--dry-run");
const FROM_UNIX = Math.floor(new Date(`${FROM_DATE}T00:00:00Z`).getTime() / 1000);
const TO_UNIX = Math.floor(new Date(`${TO_DATE}T23:59:59Z`).getTime() / 1000);
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const RATE = Number(process.env.ELEVENLABS_INR_PER_CREDIT || 0.0159742);

if (!ELEVENLABS_KEY) {
  console.error("ELEVENLABS_API_KEY not set");
  process.exit(1);
}

const postgres = (await import("postgres")).default;
const sql = postgres(process.env.DATABASE_URL, { ssl: { rejectUnauthorized: false }, max: 1 });

const BASE = "https://api.elevenlabs.io";

async function listPage(cursor) {
  const params = new URLSearchParams({
    page_size: "100",
    call_start_after_unix: String(FROM_UNIX),
    call_start_before_unix: String(TO_UNIX),
  });
  if (AGENT_ID) params.set("agent_id", AGENT_ID);
  if (cursor) params.set("cursor", cursor);
  const res = await fetch(`${BASE}/v1/convai/conversations?${params}`, {
    headers: { "xi-api-key": ELEVENLABS_KEY, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`LIST ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getDetail(conversationId) {
  const res = await fetch(
    `${BASE}/v1/convai/conversations/${encodeURIComponent(conversationId)}`,
    { headers: { "xi-api-key": ELEVENLABS_KEY } },
  );
  if (!res.ok) throw new Error(`DETAIL ${res.status} ${conversationId}`);
  return res.json();
}

// Credits -> INR paise (the integer minor-unit stored in *_cost_cents).
function creditsToPaise(credits) {
  if (typeof credits !== "number" || !Number.isFinite(credits)) return null;
  return Math.round(credits * RATE * 100);
}

// Mirror of parseElevenLabsCallCost (kept inline so this script has no TS
// build dependency). If the rate logic changes upstream, update both.
function parseDetail(d) {
  const meta = d.metadata || {};
  const charging = meta.charging || {};
  const durationCandidate = meta.call_duration_secs;
  const durationSecs =
    typeof durationCandidate === "number" && Number.isFinite(durationCandidate)
      ? Math.round(durationCandidate)
      : null;
  return {
    totalCents: creditsToPaise(meta.cost),
    llmCents: creditsToPaise(charging.llm_charge),
    telephonyCents: creditsToPaise(charging.call_charge),
    durationSecs,
    startedAt: meta.start_time_unix_secs
      ? new Date(meta.start_time_unix_secs * 1000)
      : null,
    endedAt:
      meta.start_time_unix_secs && durationSecs
        ? new Date((meta.start_time_unix_secs + durationSecs) * 1000)
        : null,
    status: d.status === "done" ? "completed" : d.status || "completed",
    agentId: d.agent_id || null,
  };
}

async function upsertOne(conversationId, detail) {
  const id = `AICALL_${conversationId}`;
  const existing = await sql`
    SELECT id, call_duration, total_cost_cents
    FROM ai_call_logs
    WHERE call_id = ${conversationId}
    LIMIT 1
  `;

  if (existing.length > 0) {
    const row = existing[0];
    const setDuration =
      (row.call_duration == null || row.call_duration === 0) && detail.durationSecs;
    if (DRY_RUN) {
      return {
        action: "update",
        id: row.id,
        setDuration,
        before: { cost: row.total_cost_cents, duration: row.call_duration },
        after: { cost: detail.totalCents, duration: setDuration ? detail.durationSecs : row.call_duration },
      };
    }
    await sql`
      UPDATE ai_call_logs SET
        total_cost_cents     = ${detail.totalCents},
        llm_cost_cents       = ${detail.llmCents},
        telephony_cost_cents = ${detail.telephonyCents},
        cost_currency        = 'INR',
        cost_source          = 'provider_api',
        cost_fetched_at      = now(),
        ${setDuration ? sql`call_duration = ${detail.durationSecs},` : sql``}
        agent_id             = COALESCE(agent_id, ${detail.agentId}),
        ended_at             = COALESCE(ended_at, ${detail.endedAt}),
        started_at           = COALESCE(started_at, ${detail.startedAt}),
        updated_at           = now()
      WHERE id = ${row.id}
    `;
    return { action: "update", id: row.id, setDuration };
  }

  if (DRY_RUN) {
    return {
      action: "insert",
      id,
      after: { cost: detail.totalCents, duration: detail.durationSecs },
    };
  }
  await sql`
    INSERT INTO ai_call_logs (
      id, call_id, provider, status, started_at, ended_at,
      call_duration, agent_id,
      total_cost_cents, llm_cost_cents, telephony_cost_cents,
      cost_currency, cost_source, cost_fetched_at, updated_at, created_at
    ) VALUES (
      ${id}, ${conversationId}, 'elevenlabs', ${detail.status},
      ${detail.startedAt}, ${detail.endedAt},
      ${detail.durationSecs}, ${detail.agentId},
      ${detail.totalCents}, ${detail.llmCents}, ${detail.telephonyCents},
      'INR', 'provider_api', now(), now(), now()
    )
  `;
  return { action: "insert", id };
}

async function main() {
  console.log(
    `[sync] agent=${AGENT_ID || "<workspace-wide>"} window=${FROM_DATE}..${TO_DATE} (unix ${FROM_UNIX}..${TO_UNIX}) rate=${RATE}/credit`,
  );

  // Pagination
  const ids = [];
  let cursor = "";
  let page = 0;
  while (true) {
    page++;
    const data = await listPage(cursor);
    const convs = data.conversations || [];
    console.log(
      `[sync] LIST page ${page}: ${convs.length} conv, has_more=${data.has_more}`,
    );
    for (const c of convs) ids.push(c.conversation_id);
    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
    if (page > 30) {
      console.warn("[sync] page cap reached");
      break;
    }
  }
  console.log(`[sync] TOTAL ${ids.length} conversations across ${page} page(s)`);

  let inserted = 0;
  let updated = 0;
  let updatedWithDuration = 0;
  let failed = 0;
  let totalCostBefore = 0;
  let totalCostAfter = 0;
  let totalDurationBefore = 0;
  let totalDurationAfter = 0;
  for (let i = 0; i < ids.length; i++) {
    try {
      const detail = parseDetail(await getDetail(ids[i]));
      const r = await upsertOne(ids[i], detail);
      if (r.action === "insert") inserted++;
      else {
        updated++;
        if (r.setDuration) updatedWithDuration++;
      }
      if (DRY_RUN) {
        totalCostBefore += r.before?.cost ?? 0;
        totalCostAfter += r.after?.cost ?? 0;
        totalDurationBefore += r.before?.duration ?? 0;
        totalDurationAfter += r.after?.duration ?? 0;
      }
      if ((i + 1) % 25 === 0) process.stdout.write(`  ${i + 1}/${ids.length}\r`);
    } catch (e) {
      failed++;
      console.error(`  [warn] ${ids[i]}: ${e.message}`);
    }
  }

  console.log(
    `\n[sync] ${DRY_RUN ? "(DRY RUN) " : ""}done: inserted=${inserted} updated=${updated} updated_w_duration=${updatedWithDuration} failed=${failed}`,
  );
  if (DRY_RUN) {
    console.log("\n=== DIFF SUMMARY (dry-run, nothing written) ===");
    console.log(`  cost_cents:    before=${totalCostBefore} → after=${totalCostAfter}`);
    console.log(`  ₹ (INR paise/100): before=₹${(totalCostBefore / 100).toFixed(2)} → after=₹${(totalCostAfter / 100).toFixed(2)}`);
    console.log(`  duration_secs: before=${totalDurationBefore} → after=${totalDurationAfter}`);
    console.log(`  minutes:       before=${(totalDurationBefore / 60).toFixed(2)} → after=${(totalDurationAfter / 60).toFixed(2)}`);
    console.log("Re-run without --dry-run to apply.");
  }
  await sql.end();
}

main().catch(async (e) => {
  console.error("FATAL:", e);
  try {
    await sql.end();
  } catch {}
  process.exit(1);
});
