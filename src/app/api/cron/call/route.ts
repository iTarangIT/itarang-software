import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { triggerBolnaCall } from "@/lib/ai/bolna_ai/triggerCall";
import { eq, lte, isNotNull, and } from "drizzle-orm";

export async function GET() {
  const now = new Date();

  const leads = await db.query.dealerLeads.findMany({
    where: (l, { lte, isNotNull }) =>
      and(lte(l.next_call_at, now), isNotNull(l.next_call_at)),
  });

  for (const lead of leads) {
    if (!lead.phone) continue;

    console.log("Triggering call for:", lead.phone);

    await triggerBolnaCall({
      leadId: lead.id,
      phone: lead.phone,
    });

    await db
      .update(dealerLeads)
      .set({
        next_call_at: null,
      })
      .where(eq(dealerLeads.id, lead.id));
  }

  return Response.json({
    success: true,
    processed: leads.length,
  });
}
