export function filterLeads(leads: any[]) {
  return leads.filter((lead) => {
    if (!lead.name) return false;

    if (!lead.phone && !lead.website) return false;

    const name = lead.name.toLowerCase();

    if (isJunkName(name)) return false;

    return true;
  });
}

function isJunkName(name: string) {
  if (name.length < 3) return true;

  if (/^\d+$/.test(name)) return true;

  if (hasTooManySpecialChars(name)) return true;

  if (isGenericBusiness(name)) return true;

  return false;
}

function hasTooManySpecialChars(name: string) {
  const cleaned = name.replace(/[a-z0-9 ]/gi, "");
  return cleaned.length > name.length * 0.3;
}

function isGenericBusiness(name: string) {
  const words = name.split(" ");

  if (words.length <= 1) return true;

  const genericPatterns = [
    "shop",
    "store",
    "center",
    "services",
    "solution",
    "traders",
  ];

  let matchCount = 0;

  for (const word of words) {
    for (const pattern of genericPatterns) {
      if (word.includes(pattern)) {
        matchCount++;
      }
    }
  }

  return matchCount >= words.length;
}
