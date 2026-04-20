import { db } from "@/lib/db";
import { scraperRaw } from "@/lib/db/schema";

const CHUNK_SIZE = 200;

export async function saveRawLeads(runId: string, leads: any[]) {
  if (!leads.length) return 0;

  const data = leads.map((lead) => ({
    id: crypto.randomUUID(),
    runId,
    rawData: JSON.stringify(lead),
    createdAt: new Date(),
  }));

  let saved = 0;
  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
    const chunk = data.slice(i, i + CHUNK_SIZE);
    try {
      await db.insert(scraperRaw).values(chunk);
      saved += chunk.length;
    } catch (err) {
      console.error(
        `[RAW_STORE] chunk ${i}–${i + chunk.length} failed:`,
        err,
      );
    }
  }

  return saved;
}
