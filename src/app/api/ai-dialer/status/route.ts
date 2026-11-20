import { dialerSession } from "@/lib/queue/dialerSession";
import { db } from "@/lib/db";
import { dialerCampaigns } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { triggerBolnaCall } from "@/lib/ai/bolna_ai/triggerCall";
import { triggerElevenLabsCall } from "@/lib/ai/elevenlabs/triggerCall";
import { markCampaignLeadCalling } from "@/lib/queue/campaignTracker";
import {
  campaignSessionEnded,
  legacyTimeoutMayAdvance,
} from "@/lib/queue/legacyDialerStatus";
import { NextResponse } from "next/server";
import { LEADS_PAGE_ROLES } from "@/lib/leads/access";
import { guardApi } from "@/lib/auth/apiGuard";

export async function GET() {
  // ID 118: signed in, with a role that reaches this screen.
  const authGate = await guardApi([...LEADS_PAGE_ROLES]);
  if (!authGate.ok) return authGate.response;

  const campaignId = await dialerSession.getCampaignId();

  // 20 Nov 2026 — a session that belongs to a campaign is read-only here.
  // advanceCampaign owns the dialling (skips, window, dial guard, retries); this
  // poll used to dial the session queue itself and close the campaign when it
  // ran dry, stranding every booked retry (legacyDialerStatus.ts). Clear the
  // session once the campaign has ended so the /leads banner goes idle.
  if (campaignId) {
    const [c] = await db
      .select({ status: dialerCampaigns.status })
      .from(dialerCampaigns)
      .where(eq(dialerCampaigns.id, campaignId))
      .limit(1);
    if (campaignSessionEnded(c?.status)) await dialerSession.stop();
  }

  // Manual queue (no campaign): if the current call timed out (3 min),
  // auto-advance to the next lead using the session's provider.
  if (
    legacyTimeoutMayAdvance({ campaignId }) &&
    (await dialerSession.isActive()) &&
    (await dialerSession.isCallTimedOut())
  ) {
    console.log("[AI DIALER] Call timed out, advancing to next lead");

    const nextLeadId = await dialerSession.getNext();

    // Queue exhausted on timeout: getNext() has cleared the session. There is
    // no campaign row to finalize on this path.
    if (nextLeadId) {
      const lead = await db.query.dealerLeads.findFirst({
        where: (l, { eq }) => eq(l.id, nextLeadId),
      });

      if (lead?.phone) {
        const provider = await dialerSession.getProvider();
        const trigger =
          provider === "elevenlabs" ? triggerElevenLabsCall : triggerBolnaCall;

        await markCampaignLeadCalling({ leadId: lead.id, campaignId: null });

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
