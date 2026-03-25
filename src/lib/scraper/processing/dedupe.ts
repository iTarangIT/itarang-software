export function dedupeLeads(leads: any[]) {
  const map = new Map<string, any>();

  for (const lead of leads) {
    const key = lead.phone || lead.website || lead.name?.toLowerCase();

    if (!key) continue;

    if (!map.has(key)) {
      map.set(key, lead);
    }
  }

  return Array.from(map.values());
}
