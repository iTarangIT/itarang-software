// 25 Nov task list ("Quotations and dealer accounts") — checks the real
// writers against a database. Every write runs inside a transaction that is
// ALWAYS rolled back, and no afterCommit hook (PDF, email, WhatsApp, bell) is
// called, so nothing is left behind.
//
//   node --import tsx --env-file=.env.local scripts/verify-quote-rules-25nov.ts   # sandbox (db-1)
//
// Covers: items 4 + 5 on account and lead quotes (one active quote; no new
// version once sent), item 1's price-change detector against the live price
// book, item 7's payment reference on Mark Won, item 8's orders read.
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { createAccountQuotation } from "@/lib/accounts/quotations/create";
import { loadAccountSummary } from "@/lib/accounts/quotations/access";
import { createLeadCommercial } from "@/lib/leads/createCommercial";
import { priceChangesFor } from "@/lib/quotes/priceChangeRecheck";
import { markLeadConverted, hasWonPaymentColumns } from "@/lib/leads/markConverted";
import { accountOrders } from "@/lib/accounts/accountOrders";
import type { CommercialsProductLine } from "@/lib/inside-sales/types";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
class Rollback extends Error {}
let failures = 0;
const ok = (cond: boolean, label: string, extra?: unknown) => {
    if (!cond) failures++;
    console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra !== undefined ? `  ${JSON.stringify(extra)}` : ""}`);
};
async function inRollback(name: string, fn: (tx: Tx) => Promise<void>) {
    console.log(`\n── ${name}`);
    try {
        await db.transaction(async (tx) => {
            await fn(tx);
            throw new Rollback();
        });
    } catch (e) {
        if (!(e instanceof Rollback)) {
            failures++;
            console.log("FAIL  threw:", e instanceof Error ? e.message : e);
        }
    }
}
async function expectThrow(p: Promise<unknown>, re: RegExp, label: string) {
    try {
        await p;
        ok(false, label, "did not throw");
    } catch (e) {
        ok(re.test(e instanceof Error ? e.message : String(e)), label, e instanceof Error ? e.message : String(e));
    }
}

const rows = <T>(r: unknown) => r as T[];

async function main() {
    // A product with an OEM price and a list price in force now.
    const [prod] = rows<{ asset_type: string; product_id: string; oem: string; list: string | null; name: string | null }>(
        await db.execute(sql`
            SELECT o.asset_type, o.product_id, o.oem_price::text AS oem, l.list_price::text AS list, o.product_name AS name
              FROM oem_reference_prices o
              LEFT JOIN product_list_prices l
                ON l.asset_type = o.asset_type AND l.product_id = o.product_id AND l.effective_to IS NULL
               AND l.effective_from <= now() AND (l.valid_until IS NULL OR l.valid_until > now())
             WHERE o.effective_to IS NULL AND o.effective_from <= now() AND (o.valid_until IS NULL OR o.valid_until > now())
               AND l.list_price IS NOT NULL
             LIMIT 1
        `),
    );
    if (!prod) throw new Error("No product with both an OEM and a list price in force — cannot run.");
    const oem = Number(prod.oem);
    const line = (unit: number): CommercialsProductLine => ({
        asset_type: prod.asset_type as CommercialsProductLine["asset_type"],
        product_id: prod.product_id,
        product_name: prod.name ?? "Test product",
        model_id: "",
        unit_price: unit,
        quantity: 1,
    });
    console.log(`product ${prod.asset_type}:${prod.product_id} OEM ${oem} list ${prod.list}`);

    // ── item 1: the detector against the live price book ──
    console.log("\n── item 1: price-change detector");
    const live = await priceChangesFor({
        product_lines: [{ ...line(oem), list_price: Number(prod.list) }],
        oem_evaluation: { lines: [{ asset_type: prod.asset_type, product_id: prod.product_id, oem_price: oem }] },
    });
    ok(live.length === 0, "a quote at today's prices is not stale", live);
    const moved = await priceChangesFor({
        product_lines: [{ ...line(oem), list_price: Number(prod.list) - 100 }],
        oem_evaluation: { lines: [{ asset_type: prod.asset_type, product_id: prod.product_id, oem_price: oem - 100 }] },
    });
    ok(moved.length === 2 && moved.some((c) => c.kind === "oem") && moved.some((c) => c.kind === "list"), "OEM and list moves are both caught", moved);

    // ── items 4 + 5 on an account ──
    const [acc] = rows<{ id: string; owner: string }>(
        await db.execute(sql`
            SELECT a.id, ao.owner_user_id::text AS owner
              FROM accounts a JOIN account_ownership ao ON ao.account_id = a.id
             WHERE ao.owner_user_id IS NOT NULL
             ORDER BY (SELECT COUNT(*) FROM account_quotations q WHERE q.account_id = a.id), a.id
             LIMIT 1
        `),
    );
    const account = acc && (await loadAccountSummary(acc.id));
    if (!account) {
        ok(false, "an owned account to test on");
    } else {
        await inRollback(`items 4 + 5 — account ${account.id}`, async (tx) => {
            const actor = { id: acc.owner, name: "verify" };
            const body = (unit: number) => ({
                product_lines: [line(unit)],
                terms: { dealer_payment_terms: "cash" as const, credit_days: null },
                notes: "verify-quote-rules-25nov (rolled back)",
            });
            const v1 = await createAccountQuotation({ account, actor, body: body(oem) }, { tx });
            ok(v1.approvalStatus === "approved", "v1 at the OEM price is auto-approved", v1.approvalStatus);
            const v2 = await createAccountQuotation({ account, actor, body: body(1) }, { tx });
            ok(v2.approvalStatus === "pending", "v2 below OEM waits for the CEO", v2.approvalStatus);
            ok(v2.replacedVersions.includes(v1.versionNo), "v2 withdraws v1 (approved, never sent)", v2.replacedVersions);
            const [w1] = rows<{ withdrawn_at: string | null; withdraw_reason: string | null }>(
                await tx.execute(sql`SELECT withdrawn_at::text, withdraw_reason FROM account_quotations WHERE quotation_id = ${v1.quotationId}::uuid`),
            );
            ok(!!w1?.withdrawn_at && /Replaced by v/.test(w1.withdraw_reason ?? ""), "v1 is stamped withdrawn with the reason", w1);
            const v3 = await createAccountQuotation({ account, actor, body: body(oem) }, { tx });
            ok(v3.replacedVersions.includes(v2.versionNo), "v3 withdraws the pending v2", v3.replacedVersions);

            // v3 goes to the dealer → no new version (item 5)
            await tx.execute(sql`
                INSERT INTO account_quotation_dispatches (quotation_id, account_id, channel, recipient, status, sent_by)
                VALUES (${v3.quotationId}::uuid, ${account.id}, 'email', 'verify@example.invalid', 'sent', ${acc.owner})
            `);
            await expectThrow(
                createAccountQuotation({ account, actor, body: body(oem) }, { tx }),
                /approved and sent to the dealer/,
                "a new version is refused while v3 is with the dealer",
            );
            // The dealer accepts v3: that order is done, the account's next quote is allowed.
            await tx.execute(sql`UPDATE account_quotations SET dealer_decision = 'approved' WHERE quotation_id = ${v3.quotationId}::uuid`);
            const v4 = await createAccountQuotation({ account, actor, body: body(oem) }, { tx });
            ok(v4.versionNo === v3.versionNo + 1 && v4.replacedVersions.length === 0, "after the dealer accepted, a new account quote is allowed and replaces nothing", v4.replacedVersions);
        });
    }

    // ── items 4 + 5 on a lead ──
    const [lead] = rows<{ id: string; owner: string }>(
        await db.execute(sql`
            SELECT dl.id, dl.current_owner_id::text AS owner
              FROM dealer_leads dl
             WHERE dl.current_owner_id IS NOT NULL
               AND dl.lead_status IN ('Under_Discussion', 'Assigned_Not_Contacted', 'Commercials_Explained')
               AND NOT EXISTS (SELECT 1 FROM dealer_lead_commercials c WHERE c.dealer_lead_id = dl.id)
             LIMIT 1
        `),
    );
    if (!lead) {
        ok(false, "an open lead without quotes to test on");
    } else {
        await inRollback(`items 4 + 5 — lead ${lead.id}`, async (tx) => {
            await tx.execute(sql`SELECT set_config('app.actor_id', ${lead.owner}, true)`);
            const actor = { id: lead.owner, name: "verify", role: "inside_sales_rep" };
            const body = (unit: number, ev: "quote_issue" | "quote_revision") => ({
                event_type: ev,
                product_lines: [line(unit)],
                price_quoted: unit,
                terms: { dealer_payment_terms: "cash" as const, credit_days: null },
            });
            const q1 = await createLeadCommercial({ leadId: lead.id, actor, body: body(oem, "quote_issue") }, { tx });
            ok(q1.approvalStatus === "approved", "lead v1 at the OEM price is auto-approved", q1.approvalStatus);
            const q2 = await createLeadCommercial({ leadId: lead.id, actor, body: body(1, "quote_revision") }, { tx });
            ok(q2.replacedVersions.includes(q1.versionNo), "lead v2 withdraws v1 (approved, never sent)", q2.replacedVersions);
            const q3 = await createLeadCommercial({ leadId: lead.id, actor, body: body(oem, "quote_revision") }, { tx });
            ok(q3.replacedVersions.includes(q2.versionNo), "lead v3 withdraws the pending v2", q3.replacedVersions);
            await tx.execute(sql`
                INSERT INTO quotation_dispatches (commercial_id, dealer_lead_id, channel, recipient, status, sent_by)
                VALUES (${q3.commercialId}::uuid, ${lead.id}, 'email', 'verify@example.invalid', 'sent', ${lead.owner})
            `);
            await expectThrow(
                createLeadCommercial({ leadId: lead.id, actor, body: body(oem, "quote_revision") }, { tx }),
                /approved and sent to the dealer/,
                "a lead revision is refused while v3 is with the dealer",
            );
        });
    }

    // ── item 7: Mark Won with the payment reference ──
    const [wonLead] = rows<{ id: string; owner: string; status: string }>(
        await db.execute(sql`
            SELECT dl.id, dl.current_owner_id::text AS owner, dl.lead_status AS status
              FROM dealer_leads dl
             WHERE dl.current_owner_id IS NOT NULL AND dl.lead_status IN ('Under_Discussion', 'Commercials_Finalised')
             LIMIT 1
        `),
    );
    const columns = await hasWonPaymentColumns();
    console.log(`\nE-397 columns on this database: ${columns}`);
    if (wonLead) {
        await inRollback(`item 7 — Mark Won on ${wonLead.id}`, async (tx) => {
            await tx.execute(sql`SELECT set_config('app.actor_id', ${wonLead.owner}, true)`);
            await markLeadConverted(
                {
                    leadId: wonLead.id,
                    actor: { id: wonLead.owner, name: "verify", role: "inside_sales_rep" },
                    gstin: "27AAPFU0939F1ZV",
                    paymentReference: "UTR 412345678901",
                },
                { tx },
            );
            const [after] = rows<Record<string, unknown>>(
                await tx.execute(sql`SELECT lead_status, to_jsonb(dl) ->> 'won_payment_reference' AS ref FROM dealer_leads dl WHERE id = ${wonLead.id}`),
            );
            ok(after?.lead_status === "Won", "lead is Won", after?.lead_status);
            if (columns) ok(after?.ref === "UTR 412345678901", "payment reference stored on the lead", after?.ref);
            const [hist] = rows<{ reason_notes: string | null }>(
                await tx.execute(sql`
                    SELECT reason_notes FROM dealer_lead_status_history WHERE dealer_lead_id = ${wonLead.id} AND to_status = 'Won'
                     ORDER BY changed_at DESC LIMIT 1
                `),
            );
            ok(!!hist?.reason_notes?.includes("Payment ref: UTR 412345678901"), "status history carries the payment reference", hist?.reason_notes);
        });
    }

    // ── item 8: orders & revenue read ──
    console.log("\n── item 8: orders read");
    const accts = rows<{ id: string }>(await db.execute(sql`SELECT id FROM accounts ORDER BY id LIMIT 40`));
    let withInvoices = 0;
    for (const a of accts) {
        const o = await accountOrders(a.id);
        if (o.invoices.length > 0) {
            withInvoices++;
            if (withInvoices === 1) {
                console.log(
                    `  ${a.id}: ${o.invoices.length} invoices, ${o.open_orders.length} open orders, lines_available=${o.lines_available}, first has ${o.invoices[0].lines.length} lines`,
                );
            }
        }
    }
    ok(true, `accountOrders read ${accts.length} accounts without error (${withInvoices} with invoices)`);

    console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
    process.exit(failures ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
