import { db } from "@/lib/db";
import { scraperLeadsDuplicates } from "@/lib/db/schema";

export async function saveDuplicateLeads(leads: any[]) {
  if (!leads.length) return 0;

  const data = leads.map((lead) => ({
    id: crypto.randomUUID(),

    originalLeadId: lead.duplicate_of || null,

    name: lead.name,
    phone: lead.phone,
    email: lead.email,
    website: lead.website,

    city: lead.city,
    address: lead.address,

    source: lead.source || "scraper",
    status: "duplicate",

    createdAt: new Date(),
  }));

  await db.insert(scraperLeadsDuplicates).values(data);

  return data.length;
}
