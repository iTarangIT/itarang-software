import { db } from "@/lib/db";
import { scraperLeads } from "@/lib/db/schema";
import { or, eq } from "drizzle-orm";

export async function saveCleanLeads(leads: any[]) {
  if (!leads.length) return 0;

  let saved = 0;

  for (const lead of leads) {
    try {
      let exists = null;

      if (lead.phone || lead.website) {
        exists = await db.query.scraperLeads.findFirst({
          where: (l, { or, eq }) =>
            or(
              lead.phone ? eq(l.phone, lead.phone) : undefined,
              lead.website ? eq(l.website, lead.website) : undefined,
            ),
        });
      }

      if (exists) continue;

      await db.insert(scraperLeads).values({
        id: crypto.randomUUID(),

        name: lead.name,
        phone: lead.phone,
        email: lead.email,
        website: lead.website,

        city: lead.city,
        address: lead.address,

        source: lead.source || "scraper",
        status: lead.status || "New",

        createdAt: new Date(),
      });

      saved++;
    } catch (err) {
      console.error("Insert error:", err);
    }
  }

  return saved;
}
