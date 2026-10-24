// The metric definitions agreed 26 Sep 2026 (tracker ID 59, handover P0-4 /
// P0-5). ONE place, used by the sales dashboard, targets and the daily email,
// so the three can never disagree about what a call or a quote is.
//
//   Dealers called / calls   HUMAN calls only: inside_sales_call. AI dialer
//                            calls (ai_call) are not a rep's effort.
//   One call, one count      NeoDove sends a dispose event per disposition, and
//                            agents re-disposition within seconds (P0-5, checked
//                            on database-1 2026-09-29: 16% of NeoDove call
//                            touchpoints had a twin within 3 minutes). A NeoDove
//                            call touchpoint with an earlier one on the same lead
//                            within NEODOVE_CALL_MERGE_WINDOW is the same call.
//   Engaged call             a connected human call where the rep spoke with
//                            the dealer — through NeoDove or logged by the
//                            rep, any outcome (decided 3 Oct 2026). Duration
//                            never counts and neither does temperature; there
//                            is no setting. Writers store the same rule in
//                            is_engaged (touchpointTypes.isEngagedCall).
//   Hot handed to field      an ASM transfer whose lead was Hot AT THE MOMENT of
//                            transfer (dealer_lead_interest_history, E-304),
//                            not Hot now.
//   Quotes created           the FIRST quote per lead; revisions counted apart.
//   Leads in                 EVERY new active dealer lead, whatever brought it in:
//                            a rep, inbound, referral, bulk upload, the scraper,
//                            an AI-dialer list, NeoDove (ID 153, Kartik 10 Oct —
//                            reverses the 7 Oct rule that left bulk imports out).
//                            Door and Origin still split it by source.

import { sql, type SQL } from "drizzle-orm";
export const NEODOVE_CALL_MERGE_WINDOW = "3 minutes";

/**
 * A human call, counted once. `t` is the lead_touchpoints alias.
 * The NOT EXISTS drops a NeoDove re-disposition of a call already counted.
 */
export function humanCall(t: SQL = sql`t`): SQL {
    return sql`${t}.touchpoint_type = 'inside_sales_call'
        AND NOT (
            ${t}.external_system = 'neodove'
            AND EXISTS (
                SELECT 1 FROM lead_touchpoints prev
                 WHERE prev.dealer_lead_id = ${t}.dealer_lead_id
                   AND prev.touchpoint_type = 'inside_sales_call'
                   AND prev.external_system = 'neodove'
                   AND prev.touchpoint_id <> ${t}.touchpoint_id
                   AND prev.performed_by IS NOT DISTINCT FROM ${t}.performed_by
                   AND prev.performed_at <= ${t}.performed_at
                   AND prev.performed_at >= ${t}.performed_at - ${sql.raw(`INTERVAL '${NEODOVE_CALL_MERGE_WINDOW}'`)}
                   AND (prev.performed_at < ${t}.performed_at OR prev.touchpoint_id < ${t}.touchpoint_id)
            )
        )`;
}

/**
 * A connected human call, counted once. humanCall()
 * keeps the EARLIEST row of a NeoDove call and the connect can sit on a later
 * re-disposition of it — so the kept row is connected when it, or a later twin
 * within the merge window, is. Counting `call_status = 'connected'` rows
 * directly counts a re-dispositioned call twice.
 */
export function connectedCall(t: SQL = sql`t`): SQL {
    return sql`${humanCall(t)}
        AND (
            ${t}.call_status = 'connected'
            OR (
                ${t}.external_system = 'neodove'
                AND EXISTS (
                    SELECT 1 FROM lead_touchpoints twin
                     WHERE twin.dealer_lead_id = ${t}.dealer_lead_id
                       AND twin.touchpoint_type = 'inside_sales_call'
                       AND twin.external_system = 'neodove'
                       AND twin.touchpoint_id <> ${t}.touchpoint_id
                       AND twin.performed_by IS NOT DISTINCT FROM ${t}.performed_by
                       AND twin.performed_at >= ${t}.performed_at
                       AND twin.performed_at <= ${t}.performed_at + ${sql.raw(`INTERVAL '${NEODOVE_CALL_MERGE_WINDOW}'`)}
                       AND twin.call_status = 'connected'
                )
            )
        )`;
}

/**
 * An engaged human call (ID 59, decided 3 Oct 2026): a connected human call,
 * counted once — the rep spoke with the dealer. No duration and no temperature
 * condition, so it is connectedCall() under the name every report uses.
 */
export function engagedCall(t: SQL = sql`t`): SQL {
    return connectedCall(t);
}

/**
 * Was THIS touchpoint an engaged one — TRUE / FALSE. For the per-row "Engaged"
 * column and for "the lead had an engaged touchpoint". A call follows the
 * rule, whatever its stored is_engaged says (rows written 1–5 Oct 2026 carry
 * the retired duration rule): engaged exactly when it connected. Every other
 * type keeps its stored flag (a productive visit, a WhatsApp reply, a rep's
 * own tick).
 */
export function engagedState(t: SQL = sql`t`): SQL {
    return sql`(CASE
        WHEN ${t}.touchpoint_type <> 'inside_sales_call' THEN ${t}.is_engaged
        ELSE ${t}.call_status IS NOT DISTINCT FROM 'connected'
    END)`;
}

/**
 * The lead was Hot at the instant `at`: the rating set by the latest change at
 * or before it; else the rating the first LATER change moved away from; else,
 * with no history at all (E-304 has no backfill), the current rating.
 */
export function wasHotAt(leadId: SQL, at: SQL, currentLevel: SQL): SQL {
    return sql`lower(CASE
        WHEN EXISTS (SELECT 1 FROM dealer_lead_interest_history h
                      WHERE h.dealer_lead_id = ${leadId} AND h.changed_at <= ${at})
        THEN (SELECT h.to_level FROM dealer_lead_interest_history h
               WHERE h.dealer_lead_id = ${leadId} AND h.changed_at <= ${at}
               ORDER BY h.changed_at DESC LIMIT 1)
        WHEN EXISTS (SELECT 1 FROM dealer_lead_interest_history h
                      WHERE h.dealer_lead_id = ${leadId})
        THEN (SELECT h.from_level FROM dealer_lead_interest_history h
               WHERE h.dealer_lead_id = ${leadId} AND h.changed_at > ${at}
               ORDER BY h.changed_at ASC LIMIT 1)
        ELSE ${currentLevel}
    END) = 'hot'`;
}

/**
 * ID 179 (Kartik 15 Oct) — who an asm_transfer touchpoint ("Hot to field") is
 * credited to: the lead's owner AT THE MOMENT of transfer (from_owner_id,
 * E-295), so a Sales Head / CEO / Admin transferring a rep's lead credits the
 * rep, not themselves. Old rows without from_owner_id fall back to the person
 * who pressed (performed_by). `t` = lead_touchpoints alias.
 *
 * HANDOVER-A31: a row that recorded the move (to_owner_id set, E-295) but has
 * no from_owner_id is an assign of a lead NOBODY owned — the bulk reassign /
 * NeoDove push (assignOwner.ts). Nobody handed it over, so it is credited to
 * no one (NULL), never to the manager who pressed. The rep's own Transfer
 * always records a from_owner_id (transferToAsm.ts), so it is unaffected.
 * Every reader counts only rows with a credit, so per-person rows still add up
 * to the company total.
 */
export function transferCredit(t: SQL = sql`t`): SQL {
    return sql`COALESCE(${t}.from_owner_id, CASE WHEN ${t}.to_owner_id IS NULL THEN ${t}.performed_by END)`;
}

/**
 * ID 179 (Kartik 18 Oct) — "Hot to field" counts only the FIRST move of a lead
 * from inside sales to the field: the lead's earliest asm_transfer touchpoint,
 * and not one whose previous owner is an ASM. An ASM-to-ASM swap (Reassign of
 * a lead already Transferred_to_ASM, assignOwner "asm_swap") and a later
 * re-transfer after a hand-back never count. `t` = lead_touchpoints alias.
 *
 * Every "Hot to field" count uses this, together with wasHotAt and
 * transferCredit: the ISR scorecard (admin/isrScorecard.ts → Sales Head
 * dashboard), the hot_to_ground target actual (targets/service.ts → targets
 * pages, my_numbers), the daily sales email's Block A "Hot handed to field"
 * and Block C "Hot to field MTD" (digests/salesDailyBlockA.ts,
 * salesDailyBlocks.ts), and the AI Analyst rule below.
 */
export function firstMoveToField(t: SQL = sql`t`): SQL {
    return sql`(${t}.touchpoint_type = 'asm_transfer'
        AND NOT EXISTS (
            SELECT 1 FROM lead_touchpoints prev_tr
             WHERE prev_tr.dealer_lead_id = ${t}.dealer_lead_id
               AND prev_tr.touchpoint_type = 'asm_transfer'
               AND (prev_tr.performed_at < ${t}.performed_at
                    OR (prev_tr.performed_at = ${t}.performed_at AND prev_tr.touchpoint_id < ${t}.touchpoint_id))
        )
        AND NOT EXISTS (
            SELECT 1 FROM users prev_owner
             WHERE prev_owner.id::text = ${t}.from_owner_id AND prev_owner.role = 'asm'
        ))`;
}

/** The first quote row of its lead (quote_issue / quote_revision, lowest version). `c` = dealer_lead_commercials alias. */
export function isFirstQuote(c: SQL = sql`c`): SQL {
    return sql`NOT EXISTS (
        SELECT 1 FROM dealer_lead_commercials earlier
         WHERE earlier.dealer_lead_id = ${c}.dealer_lead_id
           AND earlier.event_type IN ('quote_issue', 'quote_revision')
           AND earlier.version_no < ${c}.version_no
    )`;
}

/** What a rule is about — picks the rules a question needs (src/lib/analyst/metricRules.ts). */
export type AnalystTopic =
    | "leads"
    | "calls"
    | "quotes"
    | "won"
    | "visits"
    | "business"
    | "revenue"
    | "margin"
    | "batteries"
    | "people"
    | "trend"
    | "accounts"
    | "idle";

/**
 * ID 32 — the agreed rules above, in words, for the AI Analyst (a separate
 * service that writes its own SQL), so the CEO gets one answer to one question.
 * Kept here, beside the SQL it describes: change a rule, change this line.
 * A rule with no topics goes with every question; the rest go with questions
 * about their topic (metricRules.ts), so a long question still carries the
 * rules it needs inside the agent's 2,000-character limit.
 */
export const ANALYST_RULES: ReadonlyArray<{ topics: readonly AnalystTopic[]; text: string }> = [
    { topics: [], text: "Days, yesterday and months are IST calendar days." },
    {
        topics: ["leads"],
        text: "Leads in = every active dealer_leads row created in the period, whatever its source (bulk imports included).",
    },
    {
        topics: ["won", "people"],
        text: "Dealers converted = dealer_leads.lead_status 'Converted' with closed_at in the period, credited to closing_owner_id.",
    },
    // ID 169 (10 Oct): Undo Mark Won leaves the history row; won_undone_at marks it.
    {
        topics: ["won", "people"],
        text:
            "Marked Won = status history to_status 'Won' with won_undone_at NULL, credited to closing_owner_id. " +
            "Won is the rep's mark; Converted is onboarding approved — targets, credit and incentives use Converted.",
    },
    {
        topics: ["calls", "people"],
        text:
            "Calls / dealers called = human calls only: lead_touchpoints.touchpoint_type 'inside_sales_call' (AI dialer 'ai_call' excluded); " +
            `a NeoDove call within ${NEODOVE_CALL_MERGE_WINDOW} of an earlier one by the same agent on the same lead is the same call.`,
    },
    {
        topics: ["calls", "people"],
        text: "Engaged call = such a call that connected (call_status 'connected' or is_engaged), any outcome; duration never counts.",
    },
    {
        topics: ["quotes", "people"],
        text: "Quotes created = the first quote per lead (dealer_lead_commercials quote_issue); revisions counted apart.",
    },
    {
        topics: ["calls", "people"],
        text:
            "Hot handed to field = the lead's FIRST asm_transfer touchpoint (not ASM-to-ASM: from_owner_id not an asm; " +
            "a later re-transfer does not count) where the lead was Hot when transferred, each dealer once; " +
            "credited to from_owner_id (the owner at transfer), else performed_by.",
    },
    // ID 189 — one row per person / metric / month, the version in force (src/lib/targets/sql.ts).
    {
        topics: ["people"],
        text:
            "Targets = sales_targets rows with status 'pushed' or 'accepted'; a person's target = ceo_target + admin_addon (the Sales Head stretch; " +
            "ignore sales_head_target); company % of target uses ceo_target only; custom_* metrics use manual_actual.",
    },
    { topics: ["won", "leads"], text: "A Lost to Lost history row is a reason change, not a loss." },
    // ID 185 — Fresh / Repeat / New to iTarang, as salesDashboard.ts queryTotals (fv / rv) counts them.
    // Topic "visits" only: a people question not about visits should not spend its room here.
    {
        topics: ["visits"],
        text:
            "Visits = lead_visits with visit_status 'visited', one per (asm_id, dealer_lead_id, actual_visit_date); only 'visited' rows count anywhere below. " +
            "Fresh = the rep's first visited visit to that dealer (actual_visit_date = MIN for that asm_id + dealer_lead_id); Repeat = Visits - Fresh; " +
            "New to iTarang = the dealer's first visited visit by anyone (MIN per dealer_lead_id).",
    },
    // ID 192 — the idle basis (src/lib/leads/followUpAgeing.ts) and the per-holder limits (needsAttention.ts).
    {
        topics: ["idle"],
        text:
            "Idle = working days (Sundays and active holiday_calendar dates skipped) since COALESCE(GREATEST(last_worked_at, assigned_at, " +
            "next_follow_up_at if within 30 days ahead), created_at) on dealer_leads; a follow-up still ahead = not idle. " +
            "Only open active leads with a current_owner_id; past the limit when idle >= idle_asm (default 7) for an ASM holder " +
            "(analyst_staff.role 'asm'), else idle_cc (default 5) — the latest time_limit_settings row by effective_from.",
    },
    // ID 184 — salesReady.ts awaitingAssignment() and its split.
    {
        topics: ["leads"],
        text:
            "Ready leads with no owner = dealer_leads with sales_ready_at set, current_owner_id NULL, is_active not false, " +
            "lead_status not Won/Converted/Lost and contactability NULL (number not dead). " +
            "Split, one bucket each: sales_ready_reason 'ai_qualified' or 'ai_callback' first, then interest_level 'hot', then other.",
    },
    // ID 148 — accountList.ts countAccounts(): live = not closed; gstinMissingSql().
    {
        topics: ["accounts"],
        text:
            "Live dealers = accounts with analyst_account_flags.is_dealer and no account_closures row (a row = closed). " +
            "GSTIN missing = analyst_account_flags.gstin_missing (blank, 'PENDING' or failing the GSTIN check); the GSTIN itself is not readable.",
    },
    // ID 11 — Finance was folded into Battery sale (E-331).
    { topics: ["business", "leads"], text: "business_type 'finance' means battery_sale." },
    // ID 32 / 71 / 147 — money, read the way the CEO dashboard reads it (revenueSource.ts).
    {
        topics: ["revenue", "people"],
        text:
            "Revenue = invoice total incl. GST by invoice date: zoho_invoices + sales_invoices, minus credit_notes by issue date; " +
            "skip any invoice or credit note with an invoice_voids row (source + invoice_id) or status 'void'.",
    },
    {
        topics: ["revenue", "people"],
        text: "A salesperson's revenue = invoices of dealer accounts they owned on the invoice date (account_owner_history).",
    },
    {
        topics: ["revenue"],
        text:
            "A credit note is never an order: leave it out of order counts and last order. " +
            "Money owed = unpaid invoice balances less that customer's credit notes, never below zero per customer.",
    },
    {
        topics: ["batteries"],
        text:
            "Batteries sold = SUM(quantity) of invoice_line_items with product_class 'battery' on non-void invoices of a dealer; " +
            "credit-note lines (source 'credit') are negative, so they net.",
    },
    {
        topics: ["margin"],
        // ID 147 / HANDOVER-A16 — the product is stamped on each line from Item mapping (itemMap.ts);
        // vyapar_item_map's family rows are keyed by product code, so a join on item name misses them.
        text:
            "Gross margin = invoice_line_items.amount_excl_gst minus quantity x unit cost of the line's own product_id / asset_type " +
            "(stamped from Item mapping; never join vyapar_item_map by item name): average inventory.inventory_amount of that product, " +
            "else the price book. Lines without product_id or cost are 'not costed', never zero cost.",
    },
    // A35 — trends and forecasts.
    {
        topics: ["trend"],
        text: "A figure over time (by day, week or month) is a line chart, never bars. To forecast, project the next 2 months.",
    },
];

/** Every rule, in one string — what a question gets when no topic matches (and what the tests read). */
export const ANALYST_METRIC_RULES = ANALYST_RULES.map((r) => r.text).join(" ");
