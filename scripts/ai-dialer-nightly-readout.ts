// Print the AI dialer quality readout (Priya KPI tracker task 5) — the same
// table the 19:20 IST email carries. Read-only; safe on production.
//
//   node --import tsx --env-file=.env.local scripts/ai-dialer-nightly-readout.ts [--days=7] [--send]
//
// --send also emails it to Settings › Dialer alerts now (the daily job does
// this by itself at 19:20 IST on the live site).
import { buildReadout, runNightlyReadout } from "../src/lib/ai-dialer/readout/readoutQuery";
import { readoutLines } from "../src/lib/ai-dialer/readout/readout";
import { getDialerAlertSettings } from "../src/lib/ai-dialer/dialerAlerts";

const days = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=7").split("=")[1]) || 7;

async function main() {
    const rows = await buildReadout(new Date(), days);
    const s = await getDialerAlertSettings();
    console.log(readoutLines(rows, { version: s.agentVersion, changeTested: s.changeTested }).join("\n"));
    if (process.argv.includes("--send")) console.log("\nsent:", JSON.stringify(await runNightlyReadout()));
}

main()
    .catch((e) => {
        console.error(e);
        process.exitCode = 1;
    })
    .finally(() => process.exit());
