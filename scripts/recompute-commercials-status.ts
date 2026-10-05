/**
 * One-time recompute of commercials stages from quote events (tracker ID 75,
 * handover P2-2, 29 Sep 2026; widened 01 Oct 2026, ID 75.2).
 *
 *   node --import tsx --env-file=.env.local scripts/recompute-commercials-status.ts          # dry run
 *   node --import tsx --env-file=.env.local scripts/recompute-commercials-status.ts --apply  # write
 *
 * Before 29 Sep, call dispositions, the status dropdown and NeoDove stages set
 * commercials statuses, so a lead could show "Commercials finalised" with no
 * quote in the system. The rule now: only quote events move them —
 *   a live quote (latest, not withdrawn)             → Commercials_Explained
 *   THAT quote delivered (a quote_dispatched for it) → Awaiting_Customer_Decision
 *   the dealer approved a not-withdrawn quote        → Commercials_Finalised
 *   no live quote                                    → Under_Discussion
 *
 * Three groups:
 *   1. OPEN leads at a commercials stage — recomputed both ways (a correction).
 *   2. OPEN leads at an EARLIER stage that have a live quote — raised to the
 *      quote's stage, never lowered.
 *   3. Transferred_to_ASM (Awaiting field visit) leads with a live quote — the
 *      status stays (only a visit ends it, ID 77); pre_transfer_status is raised
 *      so the visit restores the later stage, as quoteStatus.ts does live.
 * Each change is logged as a "System correction" (status history + timeline)
 * that never counts as the owner's work (countsAsWork:false, ID 115.5). The
 * owner lists are printed and written to reports/ as CSV, dry run included.
 * On --apply each owner is also sent their list: ONE in-app notification per
 * owner (notifyUser, type lead.system_correction, titled "System correction"),
 * after their changes are written. Leads with no owner are only in the CSV.
 * Re-run = no-op.
 *
 * Legacy quotes (05 Oct 2026, prod dry run): the CRM only records the dealer's
 * answer since E-243 (17 Aug 2026), so a lead whose live quote predates
 * decision tracking is never moved DOWN —
 * its missing dealer answer means "not recorded", not "not approved"
 * (G.R.J. Trades: real June quote, Finalised by the rep, would have dropped
 * to Explained). It can still be raised. quote_sent / quote_released is NOT
 * delivery: it is logged when a quote is released internally (on creation, or
 * by the CEO's approval), before it reaches the dealer.
 * The cutoff is the first dealer decision recorded in THIS database, falling
 * back to the E-243 ship date when there is none.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { writeTouchpoint } from "../src/lib/touchpoints/write";
import { notifyUser } from "../src/lib/notifications/notify";
import { isForward } from "../src/lib/lifecycle/statusRules";
import type { LeadStatus } from "../src/lib/lifecycle/transitions";

type Row = {
    id: string;
    dealer_name: string | null;
    lead_status: LeadStatus;
    pre_transfer_status: string | null;
    owner_id: string | null;
    owner_name: string | null;
    has_quote: boolean;
    delivered: boolean;
    approved: boolean;
    /** Live quote predates dealer-decision tracking: never lowered. */
    legacy: boolean;
};

type Change = {
    r: Row;
    kind: "status" | "pre_transfer";
    from: string | null;
    to: LeadStatus;
};

const COMMERCIALS = ["Commercials_Explained", "Awaiting_Customer_Decision", "Commercials_Finalised"];
const EARLIER = ["New_Unassigned", "Assigned_Not_Contacted", "Under_Discussion"];
const REASON = "System correction: commercials stages follow quote events (ID 75).";
/** E-242 / E-243 (dealer decision on a quote) shipped this day. */
const DECISION_TRACKING_FALLBACK = "2026-08-17";

function target(r: Row): LeadStatus {
    if (r.approved) return "Commercials_Finalised";
    if (r.delivered) return "Awaiting_Customer_Decision";
    if (r.has_quote) return "Commercials_Explained";
    return "Under_Discussion";
}

function csvCell(v: string | null | undefined): string {
    const s = v ?? "";
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
    const apply = process.argv.includes("--apply");
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/\/.*$/, "");
    console.log(`DB host: ${host}`);

    // The live quote = the latest not-withdrawn quote event. "Delivered" means a
    // quote_dispatched touchpoint for THAT quote: sendQuotation.ts names the
    // quote number in the remark and attaches its PDF.
    const rows = (await db.execute<Row>(sql`
        WITH cutoff AS (
            SELECT COALESCE(MIN(dealer_decision_at), ${DECISION_TRACKING_FALLBACK}::timestamptz) AS at
              FROM dealer_lead_commercials WHERE dealer_decision_at IS NOT NULL
        ),
        live AS (
            SELECT DISTINCT ON (c.dealer_lead_id)
                   c.dealer_lead_id, c.quote_number, c.quote_pdf_url, c.created_at
              FROM dealer_lead_commercials c
             WHERE c.event_type IN ('quote_issue', 'quote_revision')
               AND c.withdrawn_at IS NULL
             ORDER BY c.dealer_lead_id, c.created_at DESC
        )
        SELECT dl.id, COALESCE(dl.dealer_name, dl.shop_name) AS dealer_name, dl.lead_status,
               dl.pre_transfer_status,
               u.id::text AS owner_id,
               u.name AS owner_name,
               (lq.dealer_lead_id IS NOT NULL) AS has_quote,
               (lq.dealer_lead_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM lead_touchpoints t
                     WHERE t.dealer_lead_id = dl.id
                       AND t.touchpoint_type = 'quote_dispatched'
                       AND ((lq.quote_number IS NOT NULL
                             AND t.remarks LIKE 'Quotation ' || lq.quote_number || ' sent%')
                            OR (lq.quote_pdf_url IS NOT NULL
                             AND t.attachments @> jsonb_build_array(jsonb_build_object('url', lq.quote_pdf_url))))
               )) AS delivered,
               EXISTS (SELECT 1 FROM dealer_lead_commercials c
                        WHERE c.dealer_lead_id = dl.id AND c.event_type IN ('quote_issue', 'quote_revision')
                          AND c.withdrawn_at IS NULL AND c.dealer_decision = 'approved') AS approved,
               (lq.dealer_lead_id IS NOT NULL AND lq.created_at < (SELECT at FROM cutoff)) AS legacy
          FROM dealer_leads dl
          LEFT JOIN live lq ON lq.dealer_lead_id = dl.id
          LEFT JOIN users u ON u.id::text = dl.current_owner_id
         WHERE dl.is_active IS NOT FALSE
           AND (dl.lead_status IN ('Commercials_Explained', 'Awaiting_Customer_Decision', 'Commercials_Finalised')
                OR (lq.dealer_lead_id IS NOT NULL
                    AND (dl.lead_status IS NULL
                         OR dl.lead_status IN ('New_Unassigned', 'Assigned_Not_Contacted', 'Under_Discussion', 'Transferred_to_ASM'))))
    `)) as unknown as Row[];

    const changes: Change[] = [];
    let commercialsCount = 0;
    let earlierCount = 0;
    let transferredCount = 0;
    for (const r of rows) {
        const to = target(r);
        if (COMMERCIALS.includes(r.lead_status)) {
            commercialsCount++;
            // A legacy quote's missing dealer answer is "not recorded": raise only.
            if (to !== r.lead_status && (!r.legacy || isForward(r.lead_status, to))) {
                changes.push({ r, kind: "status", from: r.lead_status, to });
            }
        } else if (r.lead_status === "Transferred_to_ASM") {
            transferredCount++;
            if (isForward(r.pre_transfer_status, to)) {
                changes.push({ r, kind: "pre_transfer", from: r.pre_transfer_status, to });
            }
        } else if (r.lead_status == null || EARLIER.includes(r.lead_status)) {
            earlierCount++;
            if (isForward(r.lead_status, to)) changes.push({ r, kind: "status", from: r.lead_status, to });
        }
    }
    const nCorrect = changes.filter((c) => c.kind === "status" && COMMERCIALS.includes(c.from ?? "")).length;
    const nRaise = changes.filter((c) => c.kind === "status" && !COMMERCIALS.includes(c.from ?? "")).length;
    const nPre = changes.filter((c) => c.kind === "pre_transfer").length;
    console.log(
        `${commercialsCount} open leads at a commercials stage — ${nCorrect} do not match their quotes.\n` +
            `${earlierCount} earlier-stage open leads with a live quote — ${nRaise} to raise.\n` +
            `${transferredCount} Awaiting-field-visit leads with a live quote — ${nPre} pre-transfer stages to raise.`,
    );

    const byOwner = new Map<string, string[]>();
    for (const { r, kind, from, to } of changes) {
        const k = r.owner_name ?? "(no owner)";
        const what =
            kind === "pre_transfer"
                ? `pre-transfer ${from ?? "none"} → ${to} (stays Transferred_to_ASM)`
                : `${from ?? "none"} → ${to}`;
        byOwner.set(k, [...(byOwner.get(k) ?? []), `  ${r.id} ${r.dealer_name ?? ""}: ${what}`]);
    }
    for (const [owner, lines] of byOwner) {
        console.log(`\n${owner} (${lines.length})`);
        console.log(lines.join("\n"));
    }

    // Owner lists → CSV, so each owner can be told what moved and why.
    const dir = join(process.cwd(), "reports");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(dir, `recompute-commercials-status-${stamp}${apply ? "" : "-dryrun"}.csv`);
    const header = "owner,lead_id,dealer_name,kind,from_status,to_status,has_quote,delivered,approved,legacy";
    const csvLines = changes.map(({ r, kind, from, to }) =>
        [r.owner_name ?? "(no owner)", r.id, r.dealer_name, kind, from, to, String(r.has_quote), String(r.delivered), String(r.approved), String(r.legacy)]
            .map(csvCell)
            .join(","),
    );
    writeFileSync(file, [header, ...csvLines].join("\n") + "\n", "utf8");
    console.log(`\nOwner list written to ${file}`);

    if (!apply) {
        console.log("\nDry run. Re-run with --apply to write.");
        process.exit(0);
    }
    for (const { r, kind, from, to } of changes) {
        if (kind === "pre_transfer") {
            await db.transaction(async (tx) => {
                await tx.execute(sql`
                    UPDATE dealer_leads SET pre_transfer_status = ${to}, updated_at = NOW()
                     WHERE id = ${r.id} AND lead_status = 'Transferred_to_ASM'
                `);
                await writeTouchpoint(
                    {
                        dealerLeadId: r.id,
                        touchpointType: "status_change_note",
                        performedBy: null,
                        remarks: `System correction (ID 75): the field visit restores ${to} (was ${from ?? "none"}) — commercials stages follow quote events.`,
                        syncMethod: "reconciliation",
                        countsAsWork: false,
                    },
                    { tx },
                );
            });
            continue;
        }
        await writeTouchpoint({
            dealerLeadId: r.id,
            touchpointType: "status_change_note",
            performedBy: null,
            remarks: `System correction (ID 75): commercials stages follow quote events — ${from ?? "none"} → ${to}.`,
            syncMethod: "reconciliation",
            countsAsWork: false,
            statusChange: {
                from: r.lead_status,
                to,
                reasonNotes: REASON,
                event: "correction",
            },
        });
    }
    console.log(`\nApplied ${changes.length}.`);

    // ID 75.2: tell each owner what moved — one notification per owner, sent
    // only after all their changes are written. Best effort: a failed
    // notification never undoes a correction (the CSV is the fallback list).
    const perOwner = new Map<string, Change[]>();
    for (const c of changes) {
        if (!c.r.owner_id) continue;
        perOwner.set(c.r.owner_id, [...(perOwner.get(c.r.owner_id) ?? []), c]);
    }
    const SHOWN = 10;
    let notified = 0;
    for (const [ownerId, list] of perOwner) {
        const lines = list.slice(0, SHOWN).map(({ r, kind, from, to }) =>
            kind === "pre_transfer"
                ? `${r.dealer_name ?? r.id}: after the field visit → ${to} (was ${from ?? "none"})`
                : `${r.dealer_name ?? r.id}: ${from ?? "none"} → ${to}`,
        );
        if (list.length > SHOWN) lines.push(`…and ${list.length - SHOWN} more`);
        try {
            await notifyUser(ownerId, {
                type: "lead.system_correction",
                title: `System correction: ${list.length} of your lead${list.length === 1 ? "" : "s"} moved`,
                message:
                    "Commercials stages now follow quote events (ID 75), so these were recomputed. " +
                    "Not counted as your work.\n" +
                    lines.join("\n"),
                data: {
                    reason: REASON,
                    leads: list.map(({ r, kind, from, to }) => ({
                        lead_id: r.id,
                        dealer_name: r.dealer_name,
                        kind,
                        from,
                        to,
                    })),
                },
                leadId: list.length === 1 ? list[0].r.id : null,
            });
            notified++;
        } catch (e) {
            console.error(`Could not notify owner ${ownerId}:`, e instanceof Error ? e.message : e);
        }
    }
    console.log(`Notified ${notified} of ${perOwner.size} owners (System correction).`);
    process.exit(0);
}

void main();
