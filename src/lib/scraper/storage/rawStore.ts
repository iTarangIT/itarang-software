import { db } from "@/lib/db";
import { scraperRaw } from "@/lib/db/schema";

export async function saveRawLeads(runId: string, leads: any[]) {
  if (!leads.length) return 0;

  const data = leads.map((lead) => ({
    id: crypto.randomUUID(),
    runId,
    rawData: JSON.stringify(lead),
    createdAt: new Date(),
  }));

  await db.insert(scraperRaw).values(data);

  return data.length;
}
