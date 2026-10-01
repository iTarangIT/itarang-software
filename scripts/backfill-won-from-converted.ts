/**
 * One-time correction of leads marked Converted under the OLD rule (tracker
 * ID 74, handover P2-1, 01 Oct 2026).
 *
 *   node --import tsx --env-file=.env.local scripts/backfill-won-from-converted.ts          # dry run
 *   node --import tsx --env-file=.env.local scripts/backfill-won-from-converted.ts --apply  # write
 *
 * Before 29 Sep the rep's "Mark Converted" set Converted. The rule now: the
 * rep's Mark Won sets Won; Converted is set when the admin APPROVES the
 * dealer's onboarding — and conversion credit and targets run on Converted.
 * So a lead that is Converted while its onboarding application is NOT approved
 * is counted as a conversion that has not happened yet.
 *
 * MOVED (Converted → Won), per lead in one transaction, logged as a "System
 * correction" (correction event: status history + timeline):
 *   active, Converted, linked to an onboarding application that is not
 *   approved, and with no drop-out decision recorded on it.
 *   won_at is set to the old closed_at (when the rep closed it), the closing
 *   owner is kept, and won_without_approved_quote is computed as Mark Won does.
 *
 * LISTED, NOT MOVED (a person decides):
 *   - Converted with no onboarding application at all;
 *   - Converted with a drop-out decision already recorded.
 *
 * Needs E-314 (won_at, won_without_approved_quote). Re-run = no-op.
 */
import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { writeTouchpoint } from "../src/lib/touchpoints/write";

type Row = {
    id: string;
    dealer_name: string | null;
    owner_name: string | null;
    closed_at: string | null;
    onboarding_status: string | null;
    has_app: boolean;
    dropout_reason: string | null;
};

const REASON = "System correction: Converted is set when the dealer's onboarding is approved; this onboarding is not approved (ID 74).";

async function main() {
    const apply = process.argv.includes("--apply");
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/\/.*$/, "");
    console.log(`DB host: ${host}`);

    const rows = (await db.execute<Row>(sql`
        SELECT dl.id,
               COALESCE(dl.dealer_name, dl.shop_name) AS dealer_name,
               u.name AS owner_name,
               dl.closed_at::text AS closed_at,
               oa.onboarding_status,
               (oa.id IS NOT NULL) AS has_app,
               dl.onboarding_dropout_reason AS dropout_reason
          FROM dealer_leads dl
          LEFT JOIN dealer_onboarding_applications oa ON oa.id = dl.dealer_onboarding_application_id
          LEFT JOIN users u ON u.id::text = COALESCE(dl.closing_owner_id, dl.current_owner_id)
         WHERE dl.lead_status = 'Converted'
           AND dl.is_active IS NOT FALSE
           AND NOT (oa.id IS NOT NULL AND oa.onboarding_status = 'approved')
         ORDER BY dl.closed_at
    `)) as unknown as Row[];

    const move = rows.filter((r) => r.has_app && !r.dropout_reason);
    const noApp = rows.filter((r) => !r.has_app);
    const dropout = rows.filter((r) => r.has_app && r.dropout_reason);

    const total = (await db.execute<{ n: string }>(sql`
        SELECT COUNT(*)::text AS n FROM dealer_leads WHERE lead_status = 'Converted' AND is_active IS NOT FALSE
    `)) as unknown as Array<{ n: string }>;
    console.log(
        `${total[0]?.n ?? 0} Converted leads; ${rows.length} without an approved onboarding: ` +
            `${move.length} to move to Won, ${noApp.length} with no application, ${dropout.length} with a drop-out decision.`,
    );

    const line = (r: Row) =>
        `  ${r.id} ${r.dealer_name ?? ""} — closed ${r.closed_at?.slice(0, 10) ?? "?"}, onboarding ${r.onboarding_status ?? "none"}`;
    const byOwner = new Map<string, string[]>();
    for (const r of move) {
        const k = r.owner_name ?? "(no owner)";
        byOwner.set(k, [...(byOwner.get(k) ?? []), line(r)]);
    }
    for (const [owner, lines] of byOwner) {
        console.log(`\nConverted → Won — ${owner} (${lines.length})`);
        console.log(lines.join("\n"));
    }
    if (noApp.length) {
        console.log(`\nNOT MOVED — Converted with no onboarding application (${noApp.length})`);
        console.log(noApp.map(line).join("\n"));
    }
    if (dropout.length) {
        console.log(`\nNOT MOVED — drop-out decision already recorded (${dropout.length})`);
        console.log(dropout.map((r) => `${line(r)} — ${r.dropout_reason}`).join("\n"));
    }

    if (!apply) {
        console.log("\nDry run. Re-run with --apply to write.");
        process.exit(0);
    }
    for (const r of move) {
        await db.transaction(async (tx) => {
            await writeTouchpoint(
                {
                    dealerLeadId: r.id,
                    touchpointType: "status_change_note",
                    performedBy: null,
                    remarks: "System correction (ID 74): Converted → Won — the dealer's onboarding is not approved yet.",
                    syncMethod: "reconciliation",
                    statusChange: { from: "Converted", to: "Won", reasonNotes: REASON, event: "correction" },
                },
                { tx },
            );
            // writeTouchpoint stamped won_at = now; the lead was won when the rep
            // closed it. The flag is the test Mark Won runs (markConverted.ts).
            await tx.execute(sql`
                UPDATE dealer_leads
                   SET won_at = COALESCE(${r.closed_at}::timestamptz, won_at),
                       won_without_approved_quote = NOT EXISTS (
                           SELECT 1 FROM dealer_lead_commercials c
                            WHERE c.dealer_lead_id = ${r.id}
                              AND c.event_type IN ('quote_issue', 'quote_revision')
                              AND c.dealer_decision = 'approved'
                              AND c.withdrawn_at IS NULL)
                 WHERE id = ${r.id}
            `);
        });
    }
    console.log(`\nApplied ${move.length}.`);
    process.exit(0);
}

void main();
