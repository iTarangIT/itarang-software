import { db } from "@/lib/db";
import { scraperLeads, scraperLeadsDuplicates } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export async function saveLeads(leadsData: any[]) {
  if (!leadsData.length) return 0;

  let inserted = 0;

  for (const lead of leadsData) {
    let existing = null;

    if (lead.phone) {
      existing = await db.query.scraperLeads.findFirst({
        where: (l, { eq }) => eq(l.phone, lead.phone),
      });
    }

    if (existing) {
      await db.insert(scraperLeadsDuplicates).values({
        id: crypto.randomUUID(),
        original_lead_id: existing.id,

        name: lead.name,
        phone: lead.phone,
        email: lead.email,
        website: lead.website,

        city: lead.city,
        address: lead.address,

        source: lead.source,
        status: lead.status || "duplicate",

        createdAt: new Date(),
      });
    } else {
      await db.insert(scraperLeads).values({
        id: crypto.randomUUID(),

        name: lead.name,
        phone: lead.phone,
        email: lead.email,
        website: lead.website,

        city: lead.city,
        address: lead.address,

        source: lead.source,
        status: lead.status || "new",

        createdAt: new Date(),
      });
    }

    inserted++;
  }

  return inserted;
}
