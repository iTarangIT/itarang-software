import { dialerSession } from "@/lib/queue/dialerSession";
import {
  drainActiveCampaignLeads,
  finalizeCampaign,
} from "@/lib/queue/campaignTracker";
import { requireAuth } from "@/lib/auth-utils";
import { NextResponse } from "next/server";

export async function POST() {
  // Capture campaignId BEFORE clearing the Redis session — once we call
  // dialerSession.stop() the campaignId is gone.
  const campaignId = await dialerSession.getCampaignId();

  let stoppedBy: string | null = null;
  try {
    const user = await requireAuth();
    stoppedBy = (user as { id?: string } | null)?.id ?? null;
  } catch {
    stoppedBy = null;
  }

  // Flip in-flight 'calling' rows to 'failed' before finalizing, otherwise
  // they're stuck mid-call forever (the webhook either never arrives or
  // arrives after stop and finds nothing to update).
  await drainActiveCampaignLeads(campaignId);
  await finalizeCampaign(campaignId, "stopped", stoppedBy);
  await dialerSession.stop();

  return NextResponse.json({ success: true });
}
