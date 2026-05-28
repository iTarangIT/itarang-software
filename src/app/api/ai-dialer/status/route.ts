import { dialerSession } from "@/lib/queue/dialerSession";
import { db } from "@/lib/db";
import { triggerBolnaCall } from "@/lib/ai/bolna_ai/triggerCall";
import { triggerElevenLabsCall } from "@/lib/ai/elevenlabs/triggerCall";
import {
  finalizeCampaign,
  markCampaignLeadCalling,
} from "@/lib/queue/campaignTracker";
import { NextResponse } from "next/server";

export async function GET() {
  // If current call timed out (3 min), auto-advance to next lead using
  // whichever provider this dialer session was started with.
  if ((await dialerSession.isActive()) && (await dialerSession.isCallTimedOut())) {
    console.log("[AI DIALER] Call timed out, advancing to next lead");

    // Capture campaignId BEFORE getNext — if the queue exhausts here, the
    // session is cleared and we need the id to finalize the campaign row.
    const campaignId = await dialerSession.getCampaignId();
    const nextLeadId = await dialerSession.getNext();

    if (!nextLeadId) {
      // Queue exhausted on timeout. Finalize the campaign as completed.
      await finalizeCampaign(campaignId, "completed");
    } else {
      const lead = await db.query.dealerLeads.findFirst({
        where: (l, { eq }) => eq(l.id, nextLeadId),
      });

      if (lead?.phone) {
        const provider = await dialerSession.getProvider();
        const trigger =
          provider === "elevenlabs" ? triggerElevenLabsCall : triggerBolnaCall;

        await markCampaignLeadCalling({
          leadId: lead.id,
          campaignId,
        });

        // Fire and forget — don't block the status response
        trigger({ phone: lead.phone, leadId: lead.id }).catch((err) =>
          console.error(
            `[AI DIALER] Timeout trigger failed (${provider}):`,
            err,
          ),
        );
      }
    }
  }

  return NextResponse.json(await dialerSession.status());
}
