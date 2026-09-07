/**
 * E-282 — one lead's NBFC action history, and the individual CSV export.
 *
 * The NBFC leg has no event table, so the timeline is assembled by unioning
 * every table that stamps a timestamp on this file and sorting the result. That
 * is more work than reading an audit log, but it is the only way to answer
 * "what actually happened, and when" without a backfill — and it stays correct
 * for files that predate this screen.
 *
 * `?format=csv` is the per-file download the tracker's row button uses; JSON
 * backs the expandable inline timeline.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import {
  errorResponse,
  successResponse,
  withErrorHandler,
} from "@/lib/api-utils";
import { csvDateTime, csvResponse, type CsvColumn } from "@/lib/leads/queueCsv";

export const dynamic = "force-dynamic";

const ADMIN_ROLES = [
  "admin",
  "ceo",
  "business_head",
  "sales_head",
  "sales_manager",
  "sales_executive",
];

/** Who performed the action. `system` = an SLA sweep, not a person. */
export type Party = "nbfc" | "admin" | "dealer" | "customer" | "system";

export interface ActionEntry {
  at: string;
  party: Party;
  action: string;
  detail: string;
  nbfcShortName: string | null;
}

/** Push only when the timestamp actually exists — half these columns are NULL. */
function push(
  out: ActionEntry[],
  at: string | Date | null | undefined,
  party: Party,
  action: string,
  detail: string,
  nbfcShortName: string | null = null,
) {
  if (!at) return;
  const iso = at instanceof Date ? at.toISOString() : at;
  out.push({ at: iso, party, action, detail, nbfcShortName });
}

export const GET = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ leadId: string }> }) => {
    await requireRole(ADMIN_ROLES);
    const { leadId } = await ctx.params;
    if (!leadId) return errorResponse("leadId is required.", 400);

    const wantsCsv =
      new URL(req.url).searchParams.get("format") === "csv";

    const [lead] = await db.execute<{
      id: string;
      reference_id: string | null;
      customer_name: string | null;
      city: string | null;
      state: string | null;
      kyc_status: string | null;
    }>(sql`
      SELECT id, reference_id,
             COALESCE(full_name, owner_name) AS customer_name,
             city, state, kyc_status
        FROM leads WHERE id = ${leadId} LIMIT 1
    `);
    if (!lead) return errorResponse("Lead not found.", 404);

    const entries: ActionEntry[] = [];

    // ── Assignments ───────────────────────────────────────────────────────
    const assignments = await db.execute<{
      id: string;
      nbfc_short_name: string | null;
      status: string;
      assigned_at: string | null;
      decided_at: string | null;
      decision_reason: string | null;
      rejection_note: string | null;
      rejection_forwarded_at: string | null;
      rejection_forward_source: string | null;
    }>(sql`
      SELECT a.id::text AS id, n.short_name AS nbfc_short_name, a.status,
             a.assigned_at, a.decided_at, a.decision_reason,
             a.rejection_note, a.rejection_forwarded_at, a.rejection_forward_source
        FROM nbfc_lead_assignments a
        LEFT JOIN nbfc n ON n.id = a.nbfc_id
       WHERE a.lead_id = ${leadId}
       ORDER BY a.assigned_at ASC
    `);

    for (const a of assignments) {
      const who = a.nbfc_short_name;
      push(entries, a.assigned_at, "admin", "File sent to lender", `Routed to ${who ?? "lender"}`, who);
      if (a.decided_at) {
        push(
          entries,
          a.decided_at,
          "nbfc",
          a.status === "declined" ? "Lender rejected the file" : `Lender decision: ${a.status}`,
          a.rejection_note ?? a.decision_reason ?? "",
          who,
        );
      }
      push(
        entries,
        a.rejection_forwarded_at,
        a.rejection_forward_source === "system" ? "system" : "admin",
        "Rejection forwarded to dealer",
        a.rejection_forward_source === "system" ? "Forwarded automatically on SLA expiry" : "Forwarded by admin",
        who,
      );
    }

    // ── Document requests + their conversation ────────────────────────────
    const requests = await db.execute<{
      id: string;
      nbfc_short_name: string | null;
      request_type: string;
      status: string;
      nbfc_comments: string | null;
      item_count: number | null;
      created_at: string | null;
      auto_forwarded_at: string | null;
      auto_pushed_at: string | null;
      closed_at: string | null;
    }>(sql`
      SELECT r.id, n.short_name AS nbfc_short_name, r.request_type, r.status,
             r.nbfc_comments, r.item_count, r.created_at,
             r.auto_forwarded_at, r.auto_pushed_at, r.closed_at
        FROM nbfc_doc_requests r
        LEFT JOIN nbfc n ON n.id = r.nbfc_id
       WHERE r.lead_id = ${leadId}
       ORDER BY r.created_at ASC
    `);

    for (const r of requests) {
      const who = r.nbfc_short_name;
      push(
        entries,
        r.created_at,
        "nbfc",
        `Lender raised a ${r.request_type.replace(/_/g, " ")} request`,
        [r.nbfc_comments, r.item_count ? `${r.item_count} item(s)` : null]
          .filter(Boolean)
          .join(" · "),
        who,
      );
      push(entries, r.auto_forwarded_at, "system", "Auto-forwarded to dealer", `Request ${r.id} — SLA expiry`, who);
      push(entries, r.auto_pushed_at, "system", "Auto-pushed to lender", `Request ${r.id} — SLA expiry`, who);
      push(entries, r.closed_at, "admin", "Request closed", `Request ${r.id}`, who);
    }

    const messages = await db.execute<{
      request_id: string;
      party: string;
      message: string | null;
      attachments: unknown;
      created_at: string | null;
    }>(sql`
      SELECT request_id, party, message, attachments, created_at
        FROM nbfc_doc_request_messages
       WHERE lead_id = ${leadId}
       ORDER BY created_at ASC
    `);

    for (const m of messages) {
      const files = Array.isArray(m.attachments) ? m.attachments.length : 0;
      push(
        entries,
        m.created_at,
        (["nbfc", "admin", "dealer"].includes(m.party) ? m.party : "system") as Party,
        "Message on request",
        [m.message, files ? `${files} attachment(s)` : null].filter(Boolean).join(" · ") ||
          `Request ${m.request_id}`,
      );
    }

    // ── Per-document verdicts ─────────────────────────────────────────────
    const verdicts = await db.execute<{
      nbfc_short_name: string | null;
      doc_for: string;
      doc_key: string;
      verdict: string;
      notes: string | null;
      verified_at: string | null;
      forwarded_at: string | null;
      forward_source: string | null;
    }>(sql`
      SELECT n.short_name AS nbfc_short_name, v.doc_for, v.doc_key, v.verdict,
             v.notes, v.verified_at, v.forwarded_at, v.forward_source
        FROM nbfc_document_verifications v
        LEFT JOIN nbfc n ON n.id = v.nbfc_id
       WHERE v.lead_id = ${leadId}
       ORDER BY v.created_at ASC
    `);

    for (const v of verdicts) {
      const label = v.doc_for === "co_borrower" ? `${v.doc_key} (co-borrower)` : v.doc_key;
      push(entries, v.verified_at, "nbfc", `Document ${v.verdict}`, [label, v.notes].filter(Boolean).join(" — "), v.nbfc_short_name);
      push(
        entries,
        v.forwarded_at,
        v.forward_source === "system" ? "system" : "admin",
        "Verdict forwarded to dealer",
        label,
        v.nbfc_short_name,
      );
    }

    // ── Offers and negotiation rounds ─────────────────────────────────────
    const offers = await db.execute<{
      nbfc_short_name: string | null;
      loan_amount: string | null;
      roi_pct: string | null;
      emi_amount: string | null;
      tenure_months: number | null;
      status: string | null;
      submitted_at: string | null;
      fixed_at: string | null;
    }>(sql`
      SELECT n.short_name AS nbfc_short_name, o.loan_amount, o.roi_pct,
             o.emi_amount, o.tenure_months, o.status, o.submitted_at, o.fixed_at
        FROM nbfc_financing_offers o
        LEFT JOIN nbfc n ON n.id = o.nbfc_id
       WHERE o.lead_id = ${leadId}
       ORDER BY o.created_at ASC
    `);

    for (const o of offers) {
      const terms = [
        o.loan_amount ? `₹${o.loan_amount}` : null,
        o.roi_pct ? `${o.roi_pct}% ROI` : null,
        o.tenure_months ? `${o.tenure_months} mo` : null,
        o.emi_amount ? `EMI ₹${o.emi_amount}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      push(entries, o.submitted_at, "nbfc", "Offer submitted", terms, o.nbfc_short_name);
      push(entries, o.fixed_at, "nbfc", "Offer fixed", terms, o.nbfc_short_name);
    }

    const rounds = await db.execute<{
      round: number;
      party: string;
      kind: string;
      message: string | null;
      created_at: string | null;
    }>(sql`
      SELECT round, party, kind, message, created_at
        FROM nbfc_offer_negotiations
       WHERE lead_id = ${leadId}
       ORDER BY created_at ASC
    `);

    for (const r of rounds) {
      push(
        entries,
        r.created_at,
        (["nbfc", "dealer", "customer"].includes(r.party) ? r.party : "system") as Party,
        `Negotiation round ${r.round} — ${r.kind}`,
        r.message ?? "",
      );
    }

    // ── Sanction / disbursement ───────────────────────────────────────────
    const sanctions = await db.execute<{
      loan_amount: string | null;
      status: string | null;
      external_lender: string | null;
      sanctioned_at: string | null;
      dealer_approved_at: string | null;
      disbursed_at: string | null;
    }>(sql`
      SELECT loan_amount, status, external_lender,
             sanctioned_at, dealer_approved_at, disbursed_at
        FROM loan_sanctions
       WHERE lead_id = ${leadId}
       ORDER BY created_at ASC
    `);

    for (const s of sanctions) {
      const amt = s.loan_amount ? `₹${s.loan_amount}` : "";
      push(
        entries,
        s.sanctioned_at,
        s.external_lender ? "dealer" : "nbfc",
        "Loan sanctioned",
        [amt, s.external_lender ? `via ${s.external_lender}` : null].filter(Boolean).join(" · "),
      );
      push(entries, s.dealer_approved_at, "dealer", "Sanction accepted by dealer", amt);
      push(entries, s.disbursed_at, "nbfc", "Loan disbursed", amt);
    }

    entries.sort((a, b) => a.at.localeCompare(b.at));

    if (wantsCsv) {
      return csvResponse<ActionEntry>({
        rows: entries,
        columns: CSV_COLUMNS,
        filename: `nbfc-file-${lead.reference_id ?? lead.id}`,
        total: entries.length,
      });
    }

    return successResponse({ lead, entries });
  },
);

const PARTY_LABEL: Record<Party, string> = {
  nbfc: "Lender",
  admin: "iTarang",
  dealer: "Dealer",
  customer: "Customer",
  system: "System",
};

const CSV_COLUMNS: CsvColumn<ActionEntry>[] = [
  { header: "When", value: (e) => csvDateTime(e.at) },
  { header: "By", value: (e) => PARTY_LABEL[e.party] },
  { header: "NBFC", value: (e) => e.nbfcShortName ?? "" },
  { header: "Action", value: (e) => e.action },
  { header: "Detail", value: (e) => e.detail },
];
