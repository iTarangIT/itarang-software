import { db } from "@/lib/db";
import { scraperLeadsDuplicates } from "@/lib/db/schema";

const CHUNK_SIZE = 100;

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

  // Chunk inserts: a single bulk insert with thousands of rows × ~10 cols
  // can exceed Postgres's 65,535 parameter ceiling and also slows down the
  // statement enough to hit timeouts. Per-chunk try/catch so one bad batch
  // doesn't lose the rest.
  let saved = 0;
  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
    const chunk = data.slice(i, i + CHUNK_SIZE);
    try {
      await db.insert(scraperLeadsDuplicates).values(chunk);
      saved += chunk.length;
    } catch (err) {
      console.error(
        `[DUP_STORE] chunk ${i}–${i + chunk.length} failed:`,
        err,
      );
    }
  }

  return saved;
}
