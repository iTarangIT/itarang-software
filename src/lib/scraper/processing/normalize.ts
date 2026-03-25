export function normalizeLeads(leads: any[]) {
  return leads.map((lead) => ({
    name: lead.name || null,
    phone: lead.phone || null,
    email: lead.email || null,
    website: lead.website || null,

    city: extractCity(lead.address),
    address: lead.address || null,

    source: "scraper",
    status: "New",
  }));
}

function extractCity(address?: string) {
  if (!address) return null;

  const parts = address.split(",");
  return parts[0]?.trim() || null;
}

function formatPhone(phone?: string) {
  if (!phone) return null;
  const cleaned = phone.replace(/\D/g, "");
  if (cleaned.length === 10) return `+91 ${cleaned}`;
  if (cleaned.length === 12 && cleaned.startsWith("91")) return `+${cleaned}`;
  return null;
}
