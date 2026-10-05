// GET /api/cron/campaign-resume
//
// E-254 — one tick of the calling-window clock: park every campaign whose
// window has closed, wake every campaign whose window has opened.
//
// The work itself lives in lib/queue/resumeCampaigns.ts, shared with the 60s
// in-process ticker in src/instrumentation-node.ts. Both exist on purpose:
// Vercel crons do not fire on the Hostinger PM2 deployments (see
// docs/DEPLOY_RUNBOOK.md), which is what instrumentation-node.ts is for, while
// this route is the Vercel-side driver and a manual "settle every campaign
// against the clock right now" handle. They are safe to run concurrently — the
// resume claim is a single atomic UPDATE and the park is guarded on
// status='running', so only one of them can take a given campaign.
//
// The route name predates the park half; kept as-is because vercel.json and any
// external scheduler already point at it, and renaming a cron path is a
// deploy-ordering problem for no behavioural gain.

import { runCampaignWindowTick } from "@/lib/queue/resumeCampaigns";
import { NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";

export const maxDuration = 60;

export async function GET(req: Request) {
  // ID 130: fails closed — an unset CRON_SECRET is a 500, never an open route.
  const cronDenied = checkCronAuth(req);
  if (cronDenied) return cronDenied;

  try {
    const { parked, resumed, advanced } = await runCampaignWindowTick();
    return NextResponse.json({
      success: true,
      parked: parked.length,
      resumed: resumed.length,
      advanced: advanced.length,
      parkedIds: parked,
      resumedIds: resumed,
      checked_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[cron/campaign-resume] failed:", err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "failed" },
      { status: 500 },
    );
  }
}
