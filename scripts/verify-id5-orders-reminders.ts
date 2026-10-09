// Check of tracker ID 5 (E-334 "Order placed" + reorder reminders) and
// ID 10 (Buyback Daily goes to the buyback team and the CEO).
//
//   node --import tsx --env-file=.env.local scripts/verify-id5-orders-reminders.ts               (read-only)
//   node --import tsx --env-file=.env.local scripts/verify-id5-orders-reminders.ts --write-test  (sandbox only)
//
// Read-only part:
//   1. E-334 is present; Dealer Health still lists the Accounts screen's dealers.
//   2. Every open claim on a Dealer Health row agrees with listOrderClaims().
//   3. Who the reminders would go to today (planned, NOT sent).
//   4. Who Buyback Daily goes to (stored list + the buyback team and CEO).
// --write-test (refused on database-2): records "Order placed" on an Orange /
// Red / Dormant dealer, checks the bucket turns Active and the claim shows as
// pending, checks a second claim is refused, withdraws it, checks the bucket
// is back — then deletes the test claim.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { hasOrderClaimTables } from "@/lib/accounts/tables";
import { listOrderClaims, recordOrderClaim, withdrawOrderClaim } from "@/lib/accounts/orderClaims";
import { listDealerHealth } from "@/lib/dealers/accountHealth";
import { dealerAccountSql } from "@/lib/accounts/accountList";
import { ceoRecipients, newlyDormant, planOrangeNudges, planWinback, type ReminderUser } from "@/lib/accounts/reorderReminderPlan";
import { digestRecipients } from "@/lib/digests/engine";
import { buybackDailyDigest } from "@/lib/digests/kinds/buyback-daily";
import { getDigestSettings } from "@/lib/digests/settings";

let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
}

async function main() {
    const host = new URL(process.env.DATABASE_URL ?? "postgres://unset").host;
    console.log(`DB host: ${host}\n`);
    const writeTest = process.argv.includes("--write-test");

    const claimsOn = await hasOrderClaimTables();
    check("E-334 tables present", claimsOn);

    const rows = await listDealerHealth();
    const [screen] = (await db.execute(sql`SELECT count(*)::int AS n FROM accounts a WHERE ${dealerAccountSql()}`)) as unknown as Array<{ n: number }>;
    check("Dealer Health lists the Accounts screen's dealers", rows.length === screen.n, { health: rows.length, screen: screen.n });

    const open = await listOrderClaims({ status: "open" });
    const onRows = rows.filter((r) => r.order_claim).map((r) => `${r.account_id}:${r.order_claim!.id}:${r.order_claim!.status}`).sort();
    const fromList = open.map((c) => `${c.account_id}:${c.id}:${c.status}`).sort();
    check("open claims on Dealer Health = listOrderClaims(open)", JSON.stringify(onRows) === JSON.stringify(fromList), { onRows: onRows.length, list: fromList.length });
    console.log(`claims: ${open.filter((c) => c.status === "pending").length} pending, ${open.filter((c) => c.status === "unconfirmed").length} with no invoice raised`);

    const users = (await db.execute(sql`SELECT id::text AS id, email, name, role, is_active FROM users`)) as unknown as ReminderUser[];
    const orange = planOrangeNudges(rows, users);
    const winback = planWinback(rows, users);
    const ceo = ceoRecipients(users);
    const buckets = (b: string) => rows.filter((r) => r.bucket === b).length;
    console.log(`\nbuckets: orange ${buckets("orange")}, dormant ${buckets("dormant")}, closed ${buckets("closed")}, unowned ${rows.filter((r) => !r.owner_id).length}`);
    console.log(`Orange nudge today → ${orange.length} mail(s): ${orange.map((m) => `${m.email} (${m.dealers.length})`).join(", ") || "none"}`);
    console.log(`Win-back this month → ${winback.length} mail(s): ${winback.map((m) => `${m.email} (${m.dealers.length})`).join(", ") || "none"}`);
    const alerted = claimsOn
        ? ((await db.execute(sql`SELECT period_key FROM account_reminder_log WHERE kind = 'dormant_ceo'`)) as unknown as Array<{ period_key: string }>)
        : [];
    console.log(`CEO alert → ${ceo.map((c) => c.email).join(", ") || "no CEO login"}: ${newlyDormant(rows, new Set(alerted.map((a) => a.period_key))).length} dealer(s) not alerted yet`);
    const orangeOwnedSent = orange.flatMap((m) => m.dealers.map((d) => d.key));
    check("every Orange dealer is in some Orange mail (when a Sales Head exists)",
        users.every((u) => u.role !== "sales_head" || !u.is_active) ||
            rows.filter((r) => r.bucket === "orange").every((r) => orangeOwnedSent.includes(r.key)));

    const settings = await getDigestSettings(buybackDailyDigest);
    const to = await digestRecipients(buybackDailyDigest, settings);
    const team = await buybackDailyDigest.audience!.resolve();
    console.log(`\nBuyback Daily: enabled=${settings.enabled}, stored=[${settings.recipients.join(", ")}]`);
    console.log(`  buyback team + CEO = [${team.join(", ")}]`);
    console.log(`  goes to            = [${to.join(", ")}]`);
    const ceoEmails = users.filter((u) => u.role === "ceo" && u.is_active && u.email && !/e2e|\.local$/i.test(u.email)).map((u) => u.email!.toLowerCase());
    check("every CEO login gets Buyback Daily", ceoEmails.every((e) => to.map((x) => x.toLowerCase()).includes(e)), ceoEmails);
    check("the stored recipients still get it", settings.recipients.every((e) => to.includes(e)));

    if (writeTest) {
        if (host.startsWith("database-2.")) throw new Error("--write-test is refused on database-2 (prod)");
        const target = rows.find((r) => r.account_id && ["orange", "red", "dormant"].includes(r.bucket) && !r.order_claim);
        const manager = users.find((u) => u.is_active && u.role === "admin");
        if (!target || !manager) {
            console.log("\nwrite test skipped: no Orange/Red/Dormant dealer without a claim, or no admin login");
        } else {
            console.log(`\nwrite test on ${target.dealer} (${target.bucket}, ${target.days_since_last_order} d)`);
            const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
            const user = { id: manager.id, role: manager.role };
            let claimId: number | null = null;
            try {
                claimId = (await recordOrderClaim(user, target.account_id!, { orderDate: today, poNumber: "VERIFY-ID5" })).id;
                const after = (await listDealerHealth()).find((r) => r.key === target.key)!;
                check("a fresh claim moves the dealer to Active", after.bucket === "active", after.bucket);
                check("the row shows the pending claim", after.order_claim?.id === claimId && after.order_claim.status === "pending");
                check("invoice figures are untouched", after.days_since_last_order === target.days_since_last_order);
                let refused = false;
                try {
                    await recordOrderClaim(user, target.account_id!, { orderDate: today });
                } catch (e) {
                    refused = (e as { status?: number }).status === 409;
                }
                check("a second open claim is refused (409)", refused);
                let futureRefused = false;
                try {
                    await recordOrderClaim(user, target.account_id!, { orderDate: "2999-01-01" });
                } catch (e) {
                    futureRefused = (e as { status?: number }).status === 400;
                }
                check("a future order date is refused (400)", futureRefused);
                await withdrawOrderClaim(user, claimId, "verify-id5 write test");
                const back = (await listDealerHealth()).find((r) => r.key === target.key)!;
                check("withdrawn: the dealer is back in its bucket", back.bucket === target.bucket && back.order_claim === null, back.bucket);

                // The SQL status rule, past the window. Inserted directly — the
                // API refuses order dates older than the window.
                if (target.last_order) {
                    // Dated on its last invoice → confirmed by that invoice.
                    const [c] = (await db.execute(sql`
                        INSERT INTO account_order_claims (account_id, order_date, po_number, claimed_by)
                        VALUES (${target.account_id}, ${target.last_order}::date, 'VERIFY-ID5', ${manager.id}::uuid) RETURNING id
                    `)) as unknown as Array<{ id: number }>;
                    const confirmed = (await listOrderClaims({ accountId: target.account_id! })).find((x) => x.id === Number(c.id));
                    check("a claim with an invoice in its window reads confirmed", confirmed?.status === "confirmed", confirmed?.status);
                    await db.execute(sql`DELETE FROM account_order_claims WHERE id = ${c.id}`);
                }
                // 20 days ago with no invoice since its last one → no invoice raised.
                if ((target.days_since_last_order ?? 999) > 20) {
                    const [c] = (await db.execute(sql`
                        INSERT INTO account_order_claims (account_id, order_date, po_number, claimed_by)
                        VALUES (${target.account_id}, (now() AT TIME ZONE 'Asia/Kolkata')::date - 20, 'VERIFY-ID5', ${manager.id}::uuid) RETURNING id
                    `)) as unknown as Array<{ id: number }>;
                    const late = (await listOrderClaims({ status: "unconfirmed" })).find((x) => x.id === Number(c.id));
                    check("a claim past 15 days with no invoice is listed as no invoice raised", late?.status === "unconfirmed" && late.days_overdue === 5, late);
                    const row = (await listDealerHealth()).find((r) => r.key === target.key)!;
                    check("…and no longer pauses the ageing", row.bucket === target.bucket && row.order_claim?.status === "unconfirmed", row.bucket);
                    await db.execute(sql`DELETE FROM account_order_claims WHERE id = ${c.id}`);
                }
            } finally {
                await db.execute(sql`DELETE FROM account_order_claims WHERE po_number = 'VERIFY-ID5' OR id = ${claimId ?? -1}`);
            }
        }
    }

    console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e?.cause ?? e);
    process.exit(1);
});
