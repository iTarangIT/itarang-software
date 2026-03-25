import "dotenv/config";
import { fetchFromApify } from "./apify";
import { enrichWithFirecrawl } from "./firecrawl";

async function test() {
  const queries = ["EV battery dealers Delhi"];

  const apifyLeads = await fetchFromApify(queries);

  console.log("Apify Leads Count:", apifyLeads.length);
  console.log("Sample Apify Lead:", apifyLeads[0]);

  const testLeads = apifyLeads.slice(0, 2);

  const enriched = await enrichWithFirecrawl(testLeads);

  console.log("Enriched Leads:", enriched);
}

test();
