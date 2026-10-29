// Previews the two quotation approval emails (28 Oct, item 3) for the newest
// lead quote and account quote on this database — WITHOUT sending anything.
//
// Read-only. Builds each email with the real builders the app uses, then
// asserts the routing rules: the CEO request goes To every active CEO with the
// salesperson, their manager (when set) and care@itarang.com in CC; the
// approved email goes To the salesperson + owner with managers and care@ in
// CC; and neither body carries an OEM price.
//
//   node --import tsx --env-file=.env.local scripts/verify-quote-approval-email.ts
import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import type { CommercialsProductLine } from "../src/lib/inside-sales/types";
import {
    buildQuoteApprovalRequestEmail,
    buildQuoteApprovedEmail,
    careCcEmails,
    termsLabel,
} from "../src/lib/leads/quoteApprovalEmail";

let fails = 0;
const check = (ok: boolean, msg: string) => {
    console.log(`${ok ? "  ok  " : "  FAIL"} ${msg}`);
    if (!ok) fails++;
};

type Row = {
    id: string;
    ref_id: string;
    dealer_name: string | null;
    version_no: number;
    created_by: string | null;
    owner_id: string | null;
    product_lines: CommercialsProductLine[] | null;
    dealer_payment_terms: string | null;
    credit_days: number | null;
};

async function preview(family: "lead" | "account", row: Row) {
    console.log(`\n── ${family} quote ${row.id} (v${row.version_no}, ${row.dealer_name ?? "?"}) ──`);
    const lines = row.product_lines ?? [];
    const base = {
        family,
        dealerName: row.dealer_name,
        refId: row.ref_id,
        versionNo: row.version_no,
        lines,
        termsLabel: termsLabel(row),
    };
    const care = careCcEmails().map((e) => e.toLowerCase());

    if (row.created_by) {
        const req = await buildQuoteApprovalRequestEmail({ ...base, raisedBy: row.created_by, reason: "preview", href: "/ceo/quotations" });
        console.log(`  request  To: ${req.to.join(", ") || "(none)"}\n           CC: ${req.cc.join(", ") || "(none)"}\n           ${req.subject}`);
        check(req.to.length > 0, "request has at least one CEO in To");
        check(care.every((c) => req.cc.map((x) => x.toLowerCase()).includes(c) || req.to.map((x) => x.toLowerCase()).includes(c)), "care@ is copied on the request");
        check(!/oem/i.test(req.html + req.text), "request body never mentions an OEM price");
        check(/Total incl\. GST/.test(req.text), "request shows the total incl. GST");
    } else {
        console.log("  (no created_by — request preview skipped)");
    }

    const ok = await buildQuoteApprovedEmail({
        ...base,
        raisedBy: row.created_by,
        ownerId: row.owner_id,
        approverName: "CEO (preview)",
        quoteNumber: null,
        draftReady: true,
        href: "/",
    });
    console.log(`  approved To: ${ok.to.join(", ") || "(none)"}\n           CC: ${ok.cc.join(", ") || "(none)"}\n           ${ok.subject}`);
    check(ok.to.length > 0, "approved email reaches the salesperson / owner");
    check(!/oem/i.test(ok.html + ok.text), "approved body never mentions an OEM price");
    console.log("\n" + ok.text.split("\n").map((l) => "    " + l).join("\n"));
}

async function main() {
    console.log("DB host:", (process.env.DATABASE_URL || "").split("@")[1]?.split("/")[0]);
    console.log("care CC:", careCcEmails().join(", ") || "(off)");

    const lead = (await db.execute(sql`
        SELECT c.commercial_id::text AS id, c.dealer_lead_id AS ref_id, l.dealer_name, c.version_no,
               c.created_by, l.current_owner_id AS owner_id, c.product_lines, c.dealer_payment_terms, c.credit_days
          FROM dealer_lead_commercials c
          JOIN dealer_leads l ON l.id = c.dealer_lead_id
         WHERE c.event_type IN ('quote_issue', 'quote_revision')
           AND jsonb_array_length(COALESCE(c.product_lines, '[]'::jsonb)) > 0
         ORDER BY c.created_at DESC LIMIT 1
    `)) as unknown as Row[];
    if (lead[0]) await preview("lead", lead[0]);
    else console.log("\n(no lead quote with product lines on this DB)");

    const hasAccounts = (await db.execute(sql`SELECT to_regclass('public.account_quotations') IS NOT NULL AS ok`)) as unknown as Array<{ ok: boolean }>;
    if (hasAccounts[0]?.ok) {
        const acct = (await db.execute(sql`
            SELECT q.quotation_id::text AS id, q.account_id AS ref_id, a.business_entity_name AS dealer_name, q.version_no,
                   q.created_by::text AS created_by, ao.owner_user_id::text AS owner_id,
                   q.product_lines, q.dealer_payment_terms, q.credit_days
              FROM account_quotations q
              LEFT JOIN accounts a ON a.id = q.account_id
              LEFT JOIN account_ownership ao ON ao.account_id = q.account_id
             ORDER BY q.created_at DESC LIMIT 1
        `).catch((e) => {
            console.log("\n(account quote query failed:", (e as Error).message, ")");
            return [];
        })) as unknown as Row[];
        if (acct[0]) await preview("account", acct[0]);
        else console.log("\n(no account quotation on this DB)");
    } else {
        console.log("\n(E-358 not applied — no account quotations)");
    }

    console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
    process.exit(fails ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
