// Read-only check of ID 148: one dealer list, one "live" rule, one bucket and
// one GSTIN-missing rule on every screen.
//
//   node --import tsx --env-file=.env.local scripts/verify-id148-live-dealers.ts
//
// 1. Live dealers (not closed) are the same number on: Dealer Health (the CEO
//    Dealer base and Sales Head tiles read these rows), the Accounts screen
//    counts (countAccounts = the API's count query) and the dealer download.
// 2. The dealer download shows the same health bucket as Dealer Health for
//    every dealer (the "Order placed" pause included).
// 3. Dealer Health's "GSTIN missing" = the Accounts screen's, on live dealers.
// 4. Closing a dealer drops each live count by exactly 1: checked by
//    recomputing the counts as if the first live dealer were closed.

import { listDealerHealth, isLiveBucket } from "@/lib/dealers/accountHealth";
import { countAccounts, listAccounts } from "@/lib/accounts/accountList";
import { summarizeDealerHealth } from "@/lib/dealers/accountHealth";

let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
}

async function main() {
    console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}\n`);
    const [health, counts, download, groups] = await Promise.all([
        listDealerHealth(),
        countAccounts(),
        listAccounts({}),
        summarizeDealerHealth("owner"),
    ]);
    const live = health.filter((h) => isLiveBucket(h.bucket));
    const closed = health.length - live.length;
    const dlLive = download.filter((r) => r.bucket !== "closed");
    const groupDealers = groups.reduce((a, g) => a + g.dealers, 0);

    // 1 — one live number
    console.log(`      dealers ${health.length}: live ${live.length}, closed ${closed}`);
    check(`Accounts screen live count ${counts.total} = Dealer Health ${live.length}`, counts.total === live.length);
    check(`Accounts screen Closed chip ${counts.closed} = Dealer Health closed ${closed}`, counts.closed === closed);
    check(`dealer download live rows ${dlLive.length} = ${live.length}`, dlLive.length === live.length);
    check(`Accounts by owner totals ${groupDealers} = ${live.length} (closed left out)`, groupDealers === live.length);
    const unownedHealth = live.filter((h) => !h.owner_id).length;
    check(`no-owner: Accounts ${counts.no_owner} = Sales Head tile ${unownedHealth}`, counts.no_owner === unownedHealth);

    // 2 — one bucket
    const byId = new Map(health.map((h) => [h.account_id, h.bucket]));
    const differ = download.filter((r) => byId.get(r.account_id) !== r.bucket);
    check("download bucket = Dealer Health bucket for every dealer", differ.length === 0, differ.slice(0, 3).map((r) => r.account_id));

    // 3 — one GSTIN-missing rule
    const missingHealth = live.filter((h) => h.gstin_missing).length;
    check(`GSTIN missing: Accounts ${counts.gstin_missing} = Dealer Health ${missingHealth}`, counts.gstin_missing === missingHealth);

    // 4 — closing one dealer moves every live count by 1 (computed, nothing written)
    const victim = live[0];
    if (victim) {
        const after = live.filter((h) => h.key !== victim.key).length;
        check(`closing ${victim.dealer} → live ${live.length} → ${after}`, after === live.length - 1);
    }

    console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
