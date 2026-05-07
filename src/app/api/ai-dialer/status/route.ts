import { dialerSession } from "@/lib/queue/dialerSession";
import { db } from "@/lib/db";
import { triggerBolnaCall } from "@/lib/ai/bolna_ai/triggerCall";
import { triggerElevenLabsCall } from "@/lib/ai/elevenlabs/triggerCall";
import { NextResponse } from "next/server";

export async function GET() {
  // If current call timed out (3 min), auto-advance to next lead using
  // whichever provider this dialer session was started with.
  if ((await dialerSession.isActive()) && (await dialerSession.isCallTimedOut())) {
    console.log("[AI DIALER] Call timed out, advancing to next lead");

    const nextLeadId = await dialerSession.getNext();
    if (nextLeadId) {
      const lead = await db.query.dealerLeads.findFirst({
        where: (l, { eq }) => eq(l.id, nextLeadId),
      });

      if (lead?.phone) {
        const provider = await dialerSession.getProvider();
        const trigger =
          provider === "elevenlabs" ? triggerElevenLabsCall : triggerBolnaCall;

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
