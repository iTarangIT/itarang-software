#!/usr/bin/env node
// Diagnostic script: independent ground-truth pull from ElevenLabs API for
// the cost-analytics window. Paginates LIST + fetches DETAIL for each
// conversation, prints per-page counts, and computes total cost in INR
// using the user-specified credit rate (0.0001 USD/credit, 83 INR/USD).
//
// Run: node scripts/diagnose-elevenlabs-cost.mjs

import fs from "node:fs";
import path from "node:path";

const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const AGENT_ID = process.env.AGENT_ID || "agent_0801kr15kc9dfrcv0dft7fzvdxs1";
const FROM_UNIX = Number(process.env.FROM_UNIX || 1776556800); // 2026-04-19 00:00 UTC
const TO_UNIX = Number(process.env.TO_UNIX || 1779235199); // 2026-05-19 23:59 UTC
const CREDIT_RATE_USD = Number(process.env.CREDIT_RATE_USD || 0.0001);
const INR_RATE = Number(process.env.INR_RATE || 83);
const BASE = "https://api.elevenlabs.io";

if (!ELEVENLABS_KEY) {
  console.error("ELEVENLABS_API_KEY not set");
  process.exit(1);
}

async function listPage(cursor) {
  const params = new URLSearchParams({
    page_size: "100",
    agent_id: AGENT_ID,
    call_start_after_unix: String(FROM_UNIX),
    call_start_before_unix: String(TO_UNIX),
  });
  if (cursor) params.set("cursor", cursor);
  const res = await fetch(`${BASE}/v1/convai/conversations?${params}`, {
    headers: { "xi-api-key": ELEVENLABS_KEY, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`LIST ${res.status} ${await res.text()}`);
  return res.json();
}

async function getDetail(conversationId) {
  const res = await fetch(
    `${BASE}/v1/convai/conversations/${encodeURIComponent(conversationId)}`,
    {
      headers: { "xi-api-key": ELEVENLABS_KEY, accept: "application/json" },
    },
  );
  if (!res.ok) throw new Error(`DETAIL ${res.status} ${conversationId}`);
  return res.json();
}

async function main() {
  console.log(
    `[diag] window: ${new Date(FROM_UNIX * 1000).toISOString()} → ${new Date(TO_UNIX * 1000).toISOString()}`,
  );
  console.log(`[diag] agent: ${AGENT_ID}`);
  console.log(`[diag] credit rate: ${CREDIT_RATE_USD} USD/credit, INR: ${INR_RATE}`);

  // ── Pagination ──────────────────────────────────────────────
  const ids = [];
  let cursor = "";
  let page = 0;
  while (true) {
    page++;
    const data = await listPage(cursor);
    const convs = data.conversations || [];
    console.log(
      `[diag] page ${page}: ${convs.length} conversations, has_more=${data.has_more}, next_cursor=${(data.next_cursor || "").slice(0, 20)}...`,
    );
    for (const c of convs) ids.push(c.conversation_id);
    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
    if (page > 30) {
      console.error("[diag] page limit reached, breaking");
      break;
    }
  }
  console.log(`[diag] TOTAL conversations from LIST: ${ids.length} across ${page} page(s)`);

  // ── Detail fetch (sequential to keep simple; ~50 IDs is fast) ──
  const rows = [];
  let fetched = 0;
  for (const id of ids) {
    try {
      const d = await getDetail(id);
      const meta = d.metadata || {};
      const charging = meta.charging || {};
      rows.push({
        conversation_id: d.conversation_id || id,
        start_unix: meta.start_time_unix_secs ?? null,
        start_utc: meta.start_time_unix_secs
          ? new Date(meta.start_time_unix_secs * 1000).toISOString()
          : null,
        duration_secs: meta.call_duration_secs ?? null,
        cost_credits: typeof meta.cost === "number" ? meta.cost : 0,
        llm_charge: charging.llm_charge ?? null,
        call_charge: charging.call_charge ?? null,
        llm_price_usd: charging.llm_price ?? null,
        tier: charging.tier ?? null,
        status: d.status ?? meta.status ?? null,
      });
      fetched++;
      if (fetched % 10 === 0) process.stdout.write(`  fetched ${fetched}/${ids.length}\r`);
    } catch (err) {
      console.error(`  [warn] detail failed for ${id}: ${err.message}`);
    }
  }
  console.log(`\n[diag] DETAIL fetched: ${rows.length}/${ids.length}`);

  // ── Aggregates ──────────────────────────────────────────────
  const priced = rows.filter((r) => r.cost_credits > 0);
  const failed = rows.filter((r) => r.cost_credits === 0);
  const totalCredits = priced.reduce((s, r) => s + r.cost_credits, 0);
  const totalDurationSecs = priced.reduce((s, r) => s + (r.duration_secs || 0), 0);
  const totalUsd = totalCredits * CREDIT_RATE_USD;
  const totalInr = totalUsd * INR_RATE;
  const totalMinutes = totalDurationSecs / 60;
  const avgInrPerCall = priced.length ? totalInr / priced.length : 0;
  const avgInrPerMinute = totalMinutes > 0 ? totalInr / totalMinutes : 0;

  console.log("\n=== GROUND TRUTH (Apr 19 → May 19, 2026 · ElevenLabs · Main_Agent_Itarang) ===");
  console.log(`Total conversations fetched: ${rows.length}`);
  console.log(`Priced calls (cost > 0):     ${priced.length}`);
  console.log(`Failed/no-handshake calls:   ${failed.length}`);
  console.log(`Total credits:               ${totalCredits}`);
  console.log(`Total USD:                   $${totalUsd.toFixed(4)}`);
  console.log(`Total INR:                   ₹${totalInr.toFixed(2)}`);
  console.log(`Total talk minutes:          ${totalMinutes.toFixed(2)} min`);
  console.log(`Avg INR / call:              ₹${avgInrPerCall.toFixed(2)}`);
  console.log(`Avg INR / minute:            ₹${avgInrPerMinute.toFixed(2)}`);

  // 11-day slice verification (May 7 → May 18)
  const sliceFrom = Math.floor(new Date("2026-05-07T00:00:00Z").getTime() / 1000);
  const sliceTo = Math.floor(new Date("2026-05-19T00:00:00Z").getTime() / 1000); // exclusive
  const slice = priced.filter(
    (r) => r.start_unix && r.start_unix >= sliceFrom && r.start_unix < sliceTo,
  );
  const sliceCredits = slice.reduce((s, r) => s + r.cost_credits, 0);
  const sliceDuration = slice.reduce((s, r) => s + (r.duration_secs || 0), 0);
  console.log("\n=== 11-DAY SLICE (May 7 → May 18, 2026) ===");
  console.log(`Priced calls: ${slice.length}`);
  console.log(`Credits:      ${sliceCredits}`);
  console.log(`USD:          $${(sliceCredits * CREDIT_RATE_USD).toFixed(4)}`);
  console.log(`INR:          ₹${(sliceCredits * CREDIT_RATE_USD * INR_RATE).toFixed(2)}`);
  console.log(`Minutes:      ${(sliceDuration / 60).toFixed(2)} min`);

  // Write rows for downstream CSV / DB compare
  const outDir = path.join(process.cwd(), "scripts", "out");
  fs.mkdirSync(outDir, { recursive: true });
  const csv = [
    "conversation_id,start_utc,duration_secs,cost_credits,llm_charge,call_charge,llm_price_usd,tier,status",
    ...rows.map(
      (r) =>
        `${r.conversation_id},${r.start_utc || ""},${r.duration_secs ?? ""},${r.cost_credits},${r.llm_charge ?? ""},${r.call_charge ?? ""},${r.llm_price_usd ?? ""},${r.tier ?? ""},${r.status ?? ""}`,
    ),
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "elevenlabs-30d.csv"), csv);
  console.log(`\n[diag] Wrote ${path.join(outDir, "elevenlabs-30d.csv")}`);
  fs.writeFileSync(
    path.join(outDir, "elevenlabs-30d.json"),
    JSON.stringify(rows, null, 2),
  );
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
