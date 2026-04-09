import { dialerSession } from "@/lib/queue/dialerSession";
import { db } from "@/lib/db";
import { triggerBolnaCall } from "@/lib/ai/bolna_ai/triggerCall";
import { NextResponse } from "next/server";

export async function GET() {
  // If current call timed out (3 min), auto-advance to next lead
  if (dialerSession.isActive() && dialerSession.isCallTimedOut()) {
    console.log("[AI DIALER] Call timed out, advancing to next lead");

    const nextLeadId = dialerSession.getNext();
    if (nextLeadId) {
      const lead = await db.query.dealerLeads.findFirst({
        where: (l, { eq }) => eq(l.id, nextLeadId),
      });

      if (lead?.phone) {
        // Fire and forget — don't block the status response
        triggerBolnaCall({ phone: lead.phone, leadId: lead.id }).catch((err) =>
          console.error("[AI DIALER] Timeout trigger failed:", err),
        );
      }
    }
  }

  return NextResponse.json(dialerSession.status());
}
