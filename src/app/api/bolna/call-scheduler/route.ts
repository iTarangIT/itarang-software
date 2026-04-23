import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { triggerBolnaCall } from "@/lib/ai/bolna_ai/triggerCall";
import { quotaCircuit } from "@/lib/queue/connection";
import { log } from "@/lib/log";
import { not, inArray, eq, isNotNull, and } from "drizzle-orm";
import { NextResponse } from "next/server";

export const maxDuration = 60;

const SKIP_STATUSES = ["stop", "completed", "dnc", "failed"];
const MAX_CONSECUTIVE_5XX = 3;

export async function GET(req: Request) {
  try {
    const authHeader = req.headers.get("authorization");
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const now = new Date();

    const allLeads = await db
      .select()
      .from(dealerLeads)
      .where(
        and(
          isNotNull(dealerLeads.current_status),
          not(inArray(dealerLeads.current_status, SKIP_STATUSES)),
          isNotNull(dealerLeads.next_call_at),
        ),
      );

    const leadsToCall = allLeads.filter(
      (r) => r.next_call_at && new Date(r.next_call_at) <= now,
    );

    if (leadsToCall.length === 0) {
      return NextResponse.json({
        success: true,
        message: "No leads to call",
        checked_at: now.toISOString(),
      });
    }

    const results = [];
    let consecutive5xx = 0;
    let bailedOn: string | null = null;

    for (const lead of leadsToCall) {
      // Circuit-breaker: bail when Upstash quota is exhausted, so we stop
      // feeding QStash dispatches that will fail on their Redis-backed
      // webhook dedup callback.
      if (quotaCircuit.tick()) {
        bailedOn = "upstash-quota";
        break;
      }
      if (consecutive5xx >= MAX_CONSECUTIVE_5XX) {
        bailedOn = "bolna-5xx";
        break;
      }

      try {
        const result = await triggerBolnaCall({
          phone: lead.phone!,
          leadId: lead.id,
        });

        if (result.success) {
          await db
            .update(dealerLeads)
            .set({ next_call_at: null })
            .where(eq(dealerLeads.id, lead.id));
          consecutive5xx = 0;
        } else {
          const errMsg = String((result as { error?: unknown }).error ?? "");
          if (/\b5\d\d\b/.test(errMsg) || /server/i.test(errMsg)) {
            consecutive5xx += 1;
          } else {
            consecutive5xx = 0;
          }
        }

        results.push({
          id: lead.id,
          phone: lead.phone,
          dealer_name: lead.dealer_name,
          shop_name: lead.shop_name,
          location: lead.location,
          status: lead.current_status,
          call_result: result,
        });
      } catch (err: any) {
        results.push({
          id: lead.id,
          phone: lead.phone,
          dealer_name: lead.dealer_name,
          success: false,
          error: err.message,
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (bailedOn) {
      log.warn(`[call-scheduler] bailed: ${bailedOn}`, {
        processed: results.length,
        totalCandidates: leadsToCall.length,
      });
    }

    return NextResponse.json({
      success: true,
      processed: results.length,
      totalCandidates: leadsToCall.length,
      bailedOn,
      checked_at: now.toISOString(),
      results,
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 },
    );
  }
}
