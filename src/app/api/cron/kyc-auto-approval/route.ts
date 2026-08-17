/**
 * KYC auto-approval SLA sweep — the external-cron mirror of the in-process
 * ticker (E-242).
 *
 * The ticker in `src/instrumentation-node.ts` is the primary path and the one
 * that demonstrably runs on the pm2/Hostinger boxes; this route exists so the
 * sweep can also be driven by the VPS crontab, a health check, or Vercel, and
 * so it can be triggered by hand while testing without waiting 60 seconds.
 *
 * Running both at once is safe: `runKycAutoApprovalTick` claims each queue row
 * with `FOR UPDATE SKIP LOCKED` and stamps `auto_approved_at` inside the claim,
 * so two concurrent sweeps split the work rather than duplicating it.
 *
 * GET and POST both work — Vercel cron sends GET, a crontab curl usually sends
 * whichever is convenient.
 */

import { NextResponse } from "next/server";

import { checkCronAuth } from "@/lib/cron-auth";
import { runKycAutoApprovalTick } from "@/lib/kyc/auto-approval";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: Request) {
    // Relaxed outside production so the sweep can be poked during local
    // testing, matching cleanup-leads / dispatch-to-sold.
    if (process.env.NODE_ENV === "production") {
        const unauth = checkCronAuth(req);
        if (unauth) return unauth;
    }

    try {
        const result = await runKycAutoApprovalTick();
        return NextResponse.json({ success: true, data: result });
    } catch (error) {
        console.error("[cron:kyc-auto-approval] failed:", error);
        const message =
            error instanceof Error ? error.message : "Sweep failed";
        return NextResponse.json(
            { success: false, error: { message } },
            { status: 500 },
        );
    }
}

export async function GET(req: Request) {
    return handle(req);
}

export async function POST(req: Request) {
    return handle(req);
}
