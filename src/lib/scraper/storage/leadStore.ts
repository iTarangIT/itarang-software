import { db } from "@/lib/db";
import { scraperLeads } from "@/lib/db/schema";

export async function saveCleanLeads(leads: any[]) {
  if (!leads.length) return 0;

  const data = leads.map((lead) => ({
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
  }));

  await db.insert(scraperLeads).values(data);

  return data.length;
}
