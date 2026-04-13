import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export async function GET() {
  try {
    const leads = await db.query.dealerLeads.findMany();

    // filter only NOT called / pending leads
    const availableLeads = leads.filter(
      (l: any) => l.current_status !== "calling" && l.current_status !== "called"
    );

    if (!availableLeads.length) {
      return Response.json({ success: false, message: "No leads left" });
    }

    // sort by intent
    const sorted = availableLeads
      .map((lead: any) => {
        const history = lead.follow_up_history || [];
        const last = history[history.length - 1];

        return {
          ...lead,
          score: last?.analysis?.intent_score || 0,
        };
      })
      .sort((a, b) => b.score - a.score);

    const lead = sorted[0];

    // mark as calling
    await db
      .update(dealerLeads)
      .set({ current_status: "calling" })
      .where(eq(dealerLeads.id, lead.id));


    await fetch("https://your-call-api.com/call", {
      method: "POST",
      body: JSON.stringify({
        phone: lead.phone,
        leadId: lead.id,
      }),
    });

    return Response.json({ success: true, lead });
  } catch (err: any) {
    return Response.json({ success: false, error: err.message });
  }
}