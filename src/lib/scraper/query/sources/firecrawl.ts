// lib/scraper/sources/firecrawl.ts

import FirecrawlApp from "@mendable/firecrawl-js";

const app = new FirecrawlApp({
  apiKey: process.env.FIRECRAWL_API_KEY!,
});

type FirecrawlResult = {
  companyName?: string;
  emails?: string[];
  phones?: string[];
  address?: string;
  location?: string;
  description?: string;
};

export async function enrichWithFirecrawl(leads: any[]) {
  const enriched: any[] = [];

  for (const lead of leads) {
    try {
      if (!lead.website) {
        enriched.push(lead);
        continue;
      }

      console.log(`[FIRECRAWL] Scraping: ${lead.website}`);

      const res = await app.scrape(lead.website, {
        formats: [
          {
            type: "json",
            prompt: `
Extract the following business details from the website:
- company name
- email addresses
- phone numbers
- full address
- city or location
- short description

Return structured JSON.
`,
            schema: {
              type: "object",
              properties: {
                companyName: { type: "string" },
                emails: {
                  type: "array",
                  items: { type: "string" },
                },
                phones: {
                  type: "array",
                  items: { type: "string" },
                },
                address: { type: "string" },
                location: { type: "string" },
                description: { type: "string" },
              },
            },
          },
        ],
      });

      // ✅ Safe typing
      const data: FirecrawlResult = (res?.json as FirecrawlResult) || {};

      enriched.push({
        ...lead,

        companyName: data.companyName || lead.name || null,
        email: data.emails?.[0] || null,
        phone: data.phones?.[0] || lead.phone || null,
        address: data.address || lead.address || null,
        location: data.location || null,
        description: data.description || null,
      });
    } catch (err) {
      console.error("[FIRECRAWL ERROR]", err);
      enriched.push(lead);
    }
  }

  return enriched;
}
