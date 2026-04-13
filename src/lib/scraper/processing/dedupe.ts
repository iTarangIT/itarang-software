export function markDuplicates(leads: any[]) {
  const seen = new Map();
  const result = [];

  for (const lead of leads) {
    const name = (lead.name || "").trim().toLowerCase();
    const address = (lead.address || "").trim().toLowerCase();

    const key = `${name}-${address}`;

    if (seen.has(key)) {
      result.push({
        ...lead,
        duplicate_of: seen.get(key),
      });
    } else {
      seen.set(key, lead.id || key);
      result.push({
        ...lead,
        duplicate_of: null,
      });
    }
  }

  return result;
}
