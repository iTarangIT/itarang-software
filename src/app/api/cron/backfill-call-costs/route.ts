// GET /api/cron/backfill-call-costs
//
// Two-phase sweep, both idempotent:
//
//   Phase A — Recover MISSING ai_call_logs rows. When the upsertAiCallLog
//   step in finalize*Call throws (historically: FK drift on lead_id), the
//   campaign-lead row was already flipped to completed/failed via
//   completeCampaignLead but no ai_call_logs row landed. We can recover
//   from dialer_campaign_leads alone — it has the provider call_id and
//   the lead_id we need. Insert a minimal placeholder row that the cost
//   fetcher and analytics joins can use.
//
//   Phase B — Enrich rows with provider cost. The existing path: any
//   ai_call_logs row with cost_fetched_at = NULL whose call ended more
//   than 5 min ago gets its cost fetched from the Bolna / ElevenLabs API.
//
// Cadence: every 15 min on Vercel (vercel.json). Cache-warm to keep the
// per-tick cost low.

import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { fetchAndPersistCallCost } from "@/lib/ai/storage/costStore";

export const maxDuration = 60;

const BATCH_LIMIT = 100;

// Drizzle's db.execute() returns rows as an array on postgres-js and
// { rows: [...] } on node-postgres / neon-serverless. Normalize.
function unwrapRows<T>(r: { rows: T[] } | T[]): T[] {
  if (Array.isArray(r)) return r;
  return r.rows ?? [];
}

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (
    process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = new Date();
  try {
    // ── Phase A: recover missing ai_call_logs rows ──
    //
    // For every dialer_campaign_leads row that has a provider call_id and
    // has reached a terminal state, ensure there's a matching ai_call_logs
    // entry. The CTE's NOT EXISTS check is the dedup — concurrent backfill
    // invocations are 15 minutes apart in production, so we don't lean on
    // ON CONFLICT (which would require a unique constraint that schema.ts
    // doesn't declare).
    //
    // Wrapped CTE pattern: candidates → inserted (RETURNING call_id) →
    // outer count. Wrapped in its own try/catch so a Phase A failure
    // (FK drift, missing column, etc.) does not block Phase B.
    let recovered = 0;
    try {
      const recoverResult = await db.execute<{ inserted_count: number }>(sql`
        WITH candidates AS (
          SELECT
            dcl.bolna_call_id AS call_id,
            dcl.lead_id       AS lead_id,
            dc.provider       AS provider,
            dcl.call_outcome  AS outcome,
            dcl.status        AS status,
            dcl.completed_at  AS completed_at,
            dcl.started_at    AS started_at
          FROM dialer_campaign_leads dcl
          INNER JOIN dialer_campaigns dc ON dc.id = dcl.campaign_id
          WHERE dcl.bolna_call_id IS NOT NULL
            AND dcl.status IN ('completed', 'failed')
            AND dcl.completed_at IS NOT NULL
            AND dcl.completed_at > now() - interval '30 days'
            AND NOT EXISTS (
              SELECT 1 FROM ai_call_logs acl
              WHERE acl.call_id = dcl.bolna_call_id
            )
          LIMIT ${BATCH_LIMIT}
        ),
        inserted AS (
          INSERT INTO ai_call_logs (
            id, call_id, lead_id, provider, status, phone_number,
            started_at, ended_at
          )
          SELECT
            'AICALL_' || c.call_id,
            c.call_id,
            c.lead_id,
            c.provider,
            CASE WHEN c.status = 'completed' THEN 'completed' ELSE c.outcome END,
            NULL,
            c.started_at,
            c.completed_at
          FROM candidates c
          RETURNING call_id
        )
        SELECT count(*)::int AS inserted_count FROM inserted
      `);
      recovered = Number(unwrapRows(recoverResult)[0]?.inserted_count ?? 0);
      if (recovered > 0) {
        console.log(
          `[backfill-cost] recovered ${recovered} missing ai_call_logs row(s)`,
        );
      }
    } catch (err) {
      console.error("[backfill-cost] Phase A (recovery) failed:", err);
    }

    // ── Phase B: enrich rows that have no cost yet ──
    const rows = await db.execute<{
      call_id: string;
      provider: string;
    }>(
      sql`
        SELECT call_id, provider
        FROM ai_call_logs
        WHERE cost_fetched_at IS NULL
          AND call_id IS NOT NULL
          AND ended_at IS NOT NULL
          AND ended_at < now() - interval '5 minutes'
          AND provider IN ('bolna', 'elevenlabs')
        ORDER BY ended_at DESC
        LIMIT ${BATCH_LIMIT}
      `,
    );

    let attempted = 0;
    let succeeded = 0;
    let failed = 0;
    for (const row of unwrapRows(rows)) {
      attempted += 1;
      const provider = row.provider as "bolna" | "elevenlabs";
      try {
        await fetchAndPersistCallCost(provider, row.call_id);
        succeeded += 1;
      } catch (err) {
        failed += 1;
        console.error(
          `[backfill-cost] ${provider} ${row.call_id} failed:`,
          err,
        );
      }
    }

    console.log(
      `[backfill-cost] recovered=${recovered} attempted=${attempted} succeeded=${succeeded} failed=${failed}`,
    );

    return NextResponse.json({
      success: true,
      checked_at: startedAt.toISOString(),
      recovered,
      attempted,
      succeeded,
      failed,
    });
  } catch (err) {
    console.error("[backfill-cost] failed:", err);
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "backfill error",
      },
      { status: 500 },
    );
  }
}
