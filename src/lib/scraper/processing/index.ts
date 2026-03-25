import { normalizeLeads } from "./normalize";
import { filterLeads } from "./filter";
import { dedupeLeads } from "./dedupe";

export async function processLeads(rawLeads: any[]) {
  const normalized = normalizeLeads(rawLeads);

  const filtered = filterLeads(normalized);

  const deduped = dedupeLeads(filtered);

  return {
    total: rawLeads.length,
    cleaned: deduped,
    saved: deduped.length,
    duplicates: rawLeads.length - deduped.length,
  };
}
