import { generateQueries } from "./lib/scraper/query/generateQueries";

async function test() {
  const queries = await generateQueries("EV battery dealers");
  console.log("AI Queries:", queries);
}

test();
