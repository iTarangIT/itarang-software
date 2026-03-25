import { db } from "@/lib/db";
import { scraperLeads } from "@/lib/db/schema";

export async function saveLeads(leadsData: any[]) {
  if (!leadsData.length) return 0;

  const data = leadsData.map((lead) => ({
    id: crypto.randomUUID(),
    name: lead.name,
    phone: lead.phone,
    email: lead.email,
    website: lead.website,
    city: lead.city,
    address: lead.address,
    source: lead.source,
    status: lead.status,
    createdAt: new Date(),
  }));

  await db.insert(scraperLeads).values(data);

  return data.length;
}
