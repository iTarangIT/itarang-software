import { normalizeIndianPhone } from "@/lib/ai/phone";

export function normalizeLeads(leads: any[], source: string) {
  return leads.map((lead) => ({
    name: lead.name || null,
    phone: normalizeIndianPhone(lead.phone),
    email: null,
    website: lead.website || null,

    city: extractCity(lead.address),
    address: lead.address || null,

    source,
    status: "New",
  }));
}

function extractCity(address?: string) {
  if (!address) return null;
  return address.split(",")[0]?.trim() || null;
}