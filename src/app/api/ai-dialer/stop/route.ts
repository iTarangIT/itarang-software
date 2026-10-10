import { dialerSession } from "@/lib/queue/dialerSession";
import {
  drainActiveCampaignLeads,
  finalizeCampaign,
} from "@/lib/queue/campaignTracker";
import { guardApi } from "@/lib/auth/apiGuard";
import { DIALER_CONTROL_ROLES } from "@/lib/leads/access";
import { NextResponse } from "next/server";

export async function POST() {
  // ID 118: stopping the running campaign needs a login + dialer control role.
  // The old best-effort requireAuth() in a try/catch let anyone stop it.
  const gate = await guardApi([...DIALER_CONTROL_ROLES]);
  if (!gate.ok) return gate.response;
  const stoppedBy: string | null = gate.user.id;

  // Capture campaignId BEFORE clearing the Redis session — once we call
  // dialerSession.stop() the campaignId is gone.
  const campaignId = await dialerSession.getCampaignId();

  // Flip in-flight 'calling' rows to 'failed' before finalizing, otherwise
  // they're stuck mid-call forever (the webhook either never arrives or
  // arrives after stop and finds nothing to update).
  await drainActiveCampaignLeads(campaignId);
  await finalizeCampaign(campaignId, "stopped", stoppedBy);
  await dialerSession.stop();

  return NextResponse.json({ success: true });
}
