/**
 * One-time recompute of commercials stages from quote events (tracker ID 75,
 * handover P2-2, 29 Sep 2026).
 *
 *   node --import tsx --env-file=.env.local scripts/recompute-commercials-status.ts          # dry run
 *   node --import tsx --env-file=.env.local scripts/recompute-commercials-status.ts --apply  # write
 *
 * Before 29 Sep, call dispositions, the status dropdown and NeoDove stages set
 * commercials statuses, so a lead could show "Commercials finalised" with no
 * quote in the system. The rule now: only quote events move them —
 *   a live quote (not withdrawn)              → Commercials_Explained
 *   that quote delivered to the dealer        → Awaiting_Customer_Decision
 *   the dealer approved it                    → Commercials_Finalised
 *   no live quote                             → Under_Discussion
 * Every OPEN lead at a commercials stage is recomputed; each change is logged
 * as a "System correction" (correction event, status history + timeline), and
 * the list is printed per owner so each can be told. Re-run = no-op.
 */
import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { writeTouchpoint } from "../src/lib/touchpoints/write";
import type { LeadStatus } from "../src/lib/lifecycle/transitions";

type Row = {
    id: string;
    dealer_name: string | null;
    lead_status: LeadStatus;
    owner_name: string | null;
    has_quote: boolean;
    delivered: boolean;
    approved: boolean;
};

function target(r: Row): LeadStatus {
    if (r.approved) return "Commercials_Finalised";
    if (r.delivered) return "Awaiting_Customer_Decision";
    if (r.has_quote) return "Commercials_Explained";
    return "Under_Discussion";
}

async function main() {
    const apply = process.argv.includes("--apply");
    const rows = (await db.execute<Row>(sql`
        SELECT dl.id, COALESCE(dl.dealer_name, dl.shop_name) AS dealer_name, dl.lead_status,
               u.name AS owner_name,
               EXISTS (SELECT 1 FROM dealer_lead_commercials c
                        WHERE c.dealer_lead_id = dl.id AND c.event_type IN ('quote_issue','quote_revision')
                          AND c.withdrawn_at IS NULL) AS has_quote,
               EXISTS (SELECT 1 FROM lead_touchpoints t
                        WHERE t.dealer_lead_id = dl.id AND t.touchpoint_type = 'quote_dispatched') AS delivered,
               EXISTS (SELECT 1 FROM dealer_lead_commercials c
                        WHERE c.dealer_lead_id = dl.id AND c.event_type IN ('quote_issue','quote_revision')
                          AND c.withdrawn_at IS NULL AND c.dealer_decision = 'approved') AS approved
          FROM dealer_leads dl
          LEFT JOIN users u ON u.id::text = dl.current_owner_id
         WHERE dl.lead_status IN ('Commercials_Explained', 'Awaiting_Customer_Decision', 'Commercials_Finalised')
           AND dl.is_active IS NOT FALSE
    `)) as unknown as Row[];

    const changes = rows.map((r) => ({ r, to: target(r) })).filter((x) => x.to !== x.r.lead_status);
    console.log(`${rows.length} open leads at a commercials stage; ${changes.length} do not match their quotes.`);

    const byOwner = new Map<string, string[]>();
    for (const { r, to } of changes) {
        const k = r.owner_name ?? "(no owner)";
        byOwner.set(k, [...(byOwner.get(k) ?? []), `  ${r.id} ${r.dealer_name ?? ""}: ${r.lead_status} → ${to}`]);
    }
    for (const [owner, lines] of byOwner) {
        console.log(`\n${owner} (${lines.length})`);
        console.log(lines.join("\n"));
    }

    if (!apply) {
        console.log("\nDry run. Re-run with --apply to write.");
        process.exit(0);
    }
    for (const { r, to } of changes) {
        await writeTouchpoint({
            dealerLeadId: r.id,
            touchpointType: "status_change_note",
            performedBy: null,
            remarks: `System correction (ID 75): commercials stages follow quote events — ${r.lead_status} → ${to}.`,
            syncMethod: "reconciliation",
            statusChange: {
                from: r.lead_status,
                to,
                reasonNotes: "System correction: commercials stages follow quote events (ID 75).",
                event: "correction",
            },
        });
    }
    console.log(`\nApplied ${changes.length}.`);
    process.exit(0);
}

void main();
