/**
 * app/api/scraper-leads/[id]/push-to-leads/route.ts
 *
 * POST /api/scraper-leads/:id/push-to-leads
 * Copies a scraper lead into dealer_leads so it appears in the Leads tab
 */

import { db } from "@/lib/db";
import { scraperLeads, dealerLeads } from "@/lib/db/schema";
import {
  withErrorHandler,
  generateId,
  successResponse,
  errorResponse,
} from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { eq } from "drizzle-orm";

export const POST = withErrorHandler(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    await requireRole(["sales_manager", "sales_head", "ceo", "business_head"]);

    const { id } = await params;

    // Fetch the scraper lead
    const [lead] = await db
      .select()
      .from(scraperLeads)
      .where(eq(scraperLeads.id, id))
      .limit(1);

    if (!lead) return errorResponse("Scraper lead not found", 404);
    if (lead.status === "pushed")
      return errorResponse("Already added to Leads", 409);

    // Check if phone already exists in dealer_leads
    if (lead.phone) {
      const existing = await db
        .select({ id: dealerLeads.id })
        .from(dealerLeads)
        .where(eq(dealerLeads.phone, lead.phone))
        .limit(1);

      if (existing.length > 0) {
        return errorResponse(
          "A lead with this phone number already exists in Leads",
          409,
        );
      }
    }

    // Create dealer lead from scraper lead
    const newId = await generateId("LEAD", dealerLeads);

    await db.insert(dealerLeads).values({
      id: newId,
      shop_name: lead.name ?? null,
      dealer_name: lead.name ?? null,
      phone: lead.phone ?? null,
      location: lead.city ?? null,
      current_status: "new",
      total_attempts: 0,
      follow_up_history: [],
      created_at: new Date(),
    });

    // Mark scraper lead as pushed so button shows "Added"
    await db
      .update(scraperLeads)
      .set({ status: "pushed" })
      .where(eq(scraperLeads.id, id));

    return successResponse({
      message: "Lead added successfully",
      dealerLeadId: newId,
    });
  },
);
