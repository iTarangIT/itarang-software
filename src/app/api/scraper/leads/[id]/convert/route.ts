import { db } from "@/lib/db";
import { scrapedDealerLeads, auditLogs } from "@/lib/db/schema";
import {
  generateId,
  withErrorHandler,
  successResponse,
  errorResponse,
} from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { appendConvertedLead } from "@/lib/google/sheet";

const convertSchema = z.object({
  converted_lead_id: z.string().min(1),
});

export const PATCH = withErrorHandler(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireRole([
      "sales_manager",
      "sales_head",
      "ceo",
      "business_head",
    ]);
    const { id: leadId } = await params;

    const body = await req.json();
    const result = convertSchema.safeParse(body);
    if (!result.success)
      return errorResponse(result.error.issues[0].message, 400);

    const [lead] = await db
      .select() // ✅ select all fields now (need phone, email, etc.)
      .from(scrapedDealerLeads)
      .where(eq(scrapedDealerLeads.id, leadId))
      .limit(1);

    if (!lead) return errorResponse("Scraped lead not found", 404);
    if (lead.converted_lead_id)
      return errorResponse("Lead already converted", 409);

    await db
      .update(scrapedDealerLeads)
      .set({
        converted_lead_id: result.data.converted_lead_id,
        exploration_status: "explored",
        explored_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(scrapedDealerLeads.id, leadId));

    await db.insert(auditLogs).values({
      id: await generateId("AUDIT", auditLogs),
      entity_type: "scraped_lead",
      entity_id: leadId,
      action: "converted_to_crm_lead",
      changes: {
        dealer_name: lead.dealer_name,
        converted_lead_id: result.data.converted_lead_id,
      },
      performed_by: user.id,
      timestamp: new Date(),
    });

    // ✅ Append to Google Sheet (fire-and-forget, never blocks conversion)
    appendConvertedLead({
      id: lead.id,
      name: lead.dealer_name ?? null,
      phone: lead.phone ?? null,
      email: lead.email ?? null,
      website: lead.website ?? null,
      city: lead.location_city ?? null,
      address: lead.location_state ?? null,
      source: lead.source_url ?? null,
      convertedAt: new Date(),
      convertedBy: user.name ?? user.id,
    });

    return successResponse({
      message: "Lead converted",
      converted_lead_id: result.data.converted_lead_id,
    });
  },
);
