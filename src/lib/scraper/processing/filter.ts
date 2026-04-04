export function filterLeads(leads: any[]) {
  return leads.filter((lead) => {
    if (!lead.name) return false;

    if (!lead.phone && !lead.website && !lead.address) return false;

    const name = lead.name.toLowerCase();

    if (isJunkName(name)) return false;

    if (lead.phone && !isValidIndianMobile(lead.phone)) return false;

    return true;
  });
}

function isValidIndianMobile(phone: string): boolean {
  const cleaned = phone.replace(/[\s\-().]/g, "");
  const normalized = cleaned.replace(/^(\+91|0091|91|0)/, "");
  return /^[6-9]\d{9}$/.test(normalized);
}

function isJunkName(name: string) {
  if (!name || name.length < 3) return true;

  if (/^\d+$/.test(name)) return true;

  if (hasTooManySpecialChars(name)) return true;

  if (hasSpamKeywords(name)) return true;

  return false;
}

function hasTooManySpecialChars(name: string) {
  const cleaned = name.replace(/[a-z0-9 ]/gi, "");
  return cleaned.length > name.length * 0.4;
}

function hasSpamKeywords(name: string) {
  const spamPatterns = ["test", "demo", "fake", "sample", "unknown", "null"];
  return spamPatterns.some((pattern) => name.includes(pattern));
}
