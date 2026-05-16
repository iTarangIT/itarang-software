// GET /api/cron/dialer-poll
//
// Authoritative recovery loop for the AI dialer's call lifecycle. Even
// when a provider's webhook is misconfigured, dropped, or the dashboard
// URL points at a stale endpoint, this cron asks the provider directly
// "what happened to this call?" and runs the same post-call pipeline
// the webhook would have.
//
// Cadence: every minute on Vercel cron (vercel.json). The dev-side
// equivalent ticks every 30s inside src/lib/queue/callWorker.ts.

import { runDialerPollOnce } from "@/lib/ai/pollCallStatus";
import { NextResponse } from "next/server";

export const maxDuration = 60;

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
    const result = await runDialerPollOnce();
    console.log(
      `[dialer-poll] polled=${result.polled} finalized=${result.finalized} ` +
        `notTerminal=${result.skippedNotTerminal} errors=${result.errors}`,
    );
    return NextResponse.json({
      success: true,
      checked_at: startedAt.toISOString(),
      ...result,
    });
  } catch (err) {
    console.error("[dialer-poll] failed:", err);
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "poll error",
      },
      { status: 500 },
    );
  }
}
