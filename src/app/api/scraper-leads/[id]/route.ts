import { db } from "@/lib/db";
import { scraperLeads, auditLogs } from "@/lib/db/schema";
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

    // Fetch full lead data (we need all fields for Sheets)
    const [lead] = await db
      .select()
      .from(scraperLeads)
      .where(eq(scraperLeads.id, leadId))
      .limit(1);

    if (!lead) return errorResponse("Scraped lead not found", 404);

    // Check already converted — using status field from your schema
    if (lead.status === "converted") {
      return errorResponse("Lead already converted", 409);
    }

    const now = new Date();

    // Update lead status in DB
    await db
      .update(scraperLeads)
      .set({
        status: "converted",
      })
      .where(eq(scraperLeads.id, leadId));

    // Audit log
    await db.insert(auditLogs).values({
      id: await generateId("AUDIT", auditLogs),
      entity_type: "scraped_lead",
      entity_id: leadId,
      action: "converted_to_crm_lead",
      changes: {
        name: lead.name,
        converted_lead_id: result.data.converted_lead_id,
      },
      performed_by: user.id,
      timestamp: now,
    });

    appendConvertedLead({
      id: leadId,
      name: lead.name,
      phone: lead.phone,
      email: lead.email,
      website: lead.website,
      city: lead.city,
      address: lead.address,
      source: lead.source,
      convertedAt: now,
      convertedBy: user.id,
    }).catch((err) => console.error("[SHEETS] Background push failed:", err));

    return successResponse({
      message: "Lead converted",
      converted_lead_id: result.data.converted_lead_id,
    });
  },
);
