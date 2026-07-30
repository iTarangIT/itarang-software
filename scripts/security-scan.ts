/**
 * CRM security scanner — CLI runner.
 *
 *   npm run security:scan                         # localhost, safe mode
 *   npm run security:scan -- --target=sandbox     # sandbox.itarang.com
 *   npm run security:scan -- --url=http://localhost:3000 --mode=aggressive
 *
 * Requires Playwright browsers installed on this machine:  npx playwright install chromium
 *
 * This runs a REAL, active security scan against the target. Only point it at a
 * system you own and are authorised to test — production is refused unless
 * SECURITY_ALLOW_PROD=1.
 */
import { runSecurityScan } from "@/lib/security/engine";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
}

const TARGET_ALIASES: Record<string, string> = {
  local: "http://localhost:3000",
  sandbox: "https://sandbox.itarang.com",
};

async function main() {
  const targetArg = arg("target");
  const url = arg("url") ?? (targetArg ? TARGET_ALIASES[targetArg] ?? targetArg : undefined);
  const mode = arg("mode");

  const result = await runSecurityScan({
    targetUrl: url,
    mode,
    trigger: "cli",
  });

  const s = result.summary;
  console.log("\n─── Security scan complete ───────────────────────");
  console.log(`run id     : ${result.runId}`);
  console.log(`findings   : ${s.findings_total}`);
  console.log(
    `  critical=${s.findings_critical} high=${s.findings_high} medium=${s.findings_medium} low=${s.findings_low} info=${s.findings_info}`,
  );
  if (result.skippedRoles.length) {
    console.log(`skipped    : ${result.skippedRoles.map((r) => r.role).join(", ")}`);
  }
  console.log("View them at /it/security in the app.");
  console.log("──────────────────────────────────────────────────");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n[security] scan failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
