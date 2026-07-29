// Regression check for "the Zoho sync ticker silently never starts".
//
// A sync that never RUNS is indistinguishable in the UI from a sync that runs
// and finds nothing — both show a stale CEO dashboard with no error anywhere.
// That is how ITD sat frozen for a month. The org-resolution fix
// (_verify-zoho-org-resolution.ts) is worthless if nothing ever calls it, so
// this pins down the other half: when does the ticker refuse to start?
//
// The specific trap: startZohoSyncTicker() required ZOHO_ORGANIZATION_ID, but
// assertConfigured() in lib/zoho/client.ts accepts EITHER that or the
// comma-separated ZOHO_ORGANIZATION_IDS. So an env configured the multi-org way
// — exactly what you'd write when fixing "we only see one org", and exactly what
// the prod runbook now tells you to add — disables the ticker while every other
// Zoho code path reports itself healthy.
//
// Run: node --import tsx --env-file=.env.local scripts/_verify-zoho-ticker-guard.ts

type Env = Record<string, string | undefined>;

const CREDS: Env = {
  ZOHO_CLIENT_ID: "id",
  ZOHO_CLIENT_SECRET: "secret",
  ZOHO_REFRESH_TOKEN: "token",
};

interface Case {
  name: string;
  env: Env;
  /** null = ticker must start; string = must NOT start, reason must contain this */
  expect: string | null;
}

const CASES: Case[] = [
  {
    name: "single-org env (ZOHO_ORGANIZATION_ID only)",
    env: { ...CREDS, ZOHO_ORGANIZATION_ID: "60060919257" },
    expect: null,
  },
  {
    // The regression. Pre-fix this returned a "missing ZOHO_ORGANIZATION_ID"
    // reason and the ticker went dark on a perfectly valid multi-org env.
    name: "multi-org env (ZOHO_ORGANIZATION_IDS only) — must still start",
    env: { ...CREDS, ZOHO_ORGANIZATION_IDS: "60060919257,60064046518" },
    expect: null,
  },
  {
    name: "both org vars set",
    env: {
      ...CREDS,
      ZOHO_ORGANIZATION_ID: "60060919257",
      ZOHO_ORGANIZATION_IDS: "60060919257,60064046518",
    },
    expect: null,
  },
  {
    name: "no org var at all — must refuse and say so",
    env: { ...CREDS },
    expect: "ZOHO_ORGANIZATION_ID",
  },
  {
    name: "no refresh token — must refuse and name it",
    env: { ...CREDS, ZOHO_REFRESH_TOKEN: undefined, ZOHO_ORGANIZATION_ID: "1" },
    expect: "ZOHO_REFRESH_TOKEN",
  },
  {
    name: "explicit opt-out",
    env: { ...CREDS, ZOHO_ORGANIZATION_ID: "1", ENABLE_ZOHO_SYNC: "0" },
    expect: "ENABLE_ZOHO_SYNC",
  },
  {
    name: "on Vercel — cron owns it",
    env: { ...CREDS, ZOHO_ORGANIZATION_ID: "1", VERCEL: "1" },
    expect: "Vercel",
  },
];

async function main() {
  const { zohoTickerDisabledReason } = await import("@/instrumentation-node");

  let failed = 0;
  for (const c of CASES) {
    const actual = zohoTickerDisabledReason(c.env);
    const ok =
      c.expect === null
        ? actual === null
        : typeof actual === "string" && actual.includes(c.expect);

    console.log(
      `${ok ? "PASS" : "FAIL"}  ${c.name}\n        -> ${actual === null ? "starts" : `disabled: ${actual}`}`,
    );
    if (!ok) {
      failed += 1;
      console.log(
        `        expected ${c.expect === null ? "the ticker to START" : `a reason containing "${c.expect}"`}`,
      );
    }
  }

  if (failed) {
    console.error(`\n${failed} case(s) failed — the sync ticker's start guard is wrong.`);
    process.exit(1);
  }
  console.log("\nPASS: ticker start guard agrees with assertConfigured() on every env shape.");
  process.exit(0);
}

main();
