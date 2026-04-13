import { normalizeLeads } from "./normalize";
import { filterLeads } from "./filter";
import { markDuplicates } from "./dedupe";

export async function processLeads(rawLeads: any[]) {
  const normalized = normalizeLeads(rawLeads, "google_places");

  const filtered = filterLeads(normalized);

  const deduped = markDuplicates(filtered);

  const duplicateCount = deduped.filter((lead) => lead.duplicate_of).length;

  return {
    total: rawLeads.length,
    cleaned: deduped,
    saved: deduped.length,
    duplicates: duplicateCount,
  };
}
