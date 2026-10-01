/**
 * run-green-news.ts — run ONE Green Energy News refresh by hand (E-306),
 * without the Next server. Writes to the DB in .env.local and calls Gemini.
 *
 *   node --import tsx --env-file=.env.local scripts/run-green-news.ts          # respects the 2 h gap
 *   node --import tsx --env-file=.env.local scripts/run-green-news.ts --force  # ignore the gap
 *   node --import tsx --env-file=.env.local scripts/run-green-news.ts --brief  # (re)write today's brief too
 */

import { writeDailyBrief } from "@/lib/news/brief";
import { runGreenNewsRefresh } from "@/lib/news/run";

async function main() {
  const force = process.argv.includes("--force");
  const brief = process.argv.includes("--brief");
  const started = Date.now();
  const r = await runGreenNewsRefresh({ triggeredBy: "manual", force });
  console.log(JSON.stringify(r, null, 2));
  if (brief) {
    const wrote = await writeDailyBrief({ force: true });
    console.log(`brief ${wrote ? "written" : "NOT written (fewer than 3 items or Gemini failed)"}`);
  }
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
