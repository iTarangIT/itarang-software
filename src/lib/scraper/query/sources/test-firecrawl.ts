import "dotenv/config";
import { enrichWithFirecrawl } from "./firecrawl";

async function test() {
  const testLeads = [
    {
      website: "https://nvidia.com",
    },
  ];

  const result = await enrichWithFirecrawl(testLeads);

  console.log("Firecrawl Result:", result);
}

test();
