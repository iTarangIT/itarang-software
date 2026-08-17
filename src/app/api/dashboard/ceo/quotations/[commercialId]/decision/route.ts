/**
 * E-221 — POST /api/dashboard/ceo/quotations/:commercialId/decision
 *
 * The CEO's approve / reject on a pending lead quotation.
 *
 * APPROVE
 *   Stamps the decision and writes the `quote_sent` touchpoint — this is the
 *   moment the quote is actually released to the dealer, so it is the moment
 *   the send is recorded. The issuing route writes `quote_submitted` instead,
 *   precisely so nothing claims a send before this point.
 *
 * REJECT
 *   Marks the version rejected and moves `is_current` back to the newest
 *   APPROVED version below it. A rejected version must never be current again,
 *   and neither must a still-pending one — otherwise rejecting v3 would
 *   silently promote an unapproved v2 to live. If nothing qualifies (the lead's
 *   very first quote was rejected) the lead is left with no current
 *   commercials, which is the truth rather than an invented one.
 *
 * The whole decision runs in one transaction with the row locked FOR UPDATE:
 * two CEOs clicking at once must not both pass the pending check.
 */
import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth-utils";
import { isNextRedirectError } from "@/lib/api-utils";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { rollbackTarget, type CommercialVersion } from "@/lib/leads/quoteApproval";
import { tryGenerateQuotationDraft } from "@/lib/leads/quoteDraft";
import { notifyQuotationApproved } from "@/lib/notifications/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set(["ceo", "admin"]);

const BodySchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    // Required on reject: a refusal with no stated reason leaves the rep
    // nothing to act on and no record of why the number was refused.
    reason: z.string().trim().min(1).max(2000).optional(),
  })
  .refine((b) => b.decision !== "reject" || !!b.reason, {
    message: "A rejection reason is required.",
    path: ["reason"],
  });

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ commercialId: string }> },
) {
  try {
    const user = await requireAuth();
    if (!ALLOWED_ROLES.has((user.role || "").toLowerCase())) {
      return NextResponse.json(
        { success: false, error: { message: "FORBIDDEN" } },
        { status: 403 },
      );
    }

    const { commercialId } = await ctx.params;
    const body = BodySchema.parse(await req.json());

    const outcome = await db.transaction(async (tx) => {
      const locked = await tx.execute<{
        commercial_id: string;
        dealer_lead_id: string;
        version_no: number;
        approval_status: string | null;
        price_quoted: string | null;
        final_price: string | null;
        quote_document_url: string | null;
      }>(sql`
        SELECT commercial_id, dealer_lead_id, version_no, approval_status,
               price_quoted, final_price, quote_document_url
          FROM dealer_lead_commercials
         WHERE commercial_id = ${commercialId}
         FOR UPDATE
      `);
      const row = locked[0];

      // NOTE: the lead is read WITHOUT a lock and is NOT part of the decision —
      // it only supplies who to notify and what to call the dealer. Locking it
      // here would put every quotation decision behind the same row as every
      // ownership change on that lead, for two display fields.
      if (!row) return { status: 404 as const, message: "Quotation not found." };
      if (row.approval_status !== "pending") {
        // Already decided — by another CEO, or a double-click.
        return {
          status: 409 as const,
          message: `This quotation is already ${row.approval_status}.`,
        };
      }

      // ISO string, NOT the Date object. Drizzle runs a raw sql`` template
      // through postgres.js `unsafe()`, which serialises parameters with no
      // column-type information and throws ERR_INVALID_ARG_TYPE ("Received an
      // instance of Date") on a Date. The query builder infers the type and
      // would be fine; `tx.execute` is not. This broke BOTH buttons on this
      // route — every approve and every reject 500'd — and the failure was
      // invisible because errorMessage() returns only Drizzle's wrapper
      // message and drops the `cause` that names the real error.
      const nowIso = new Date().toISOString();

      const leadRows = await tx.execute<{
        current_owner_id: string | null;
        dealer_name: string | null;
      }>(sql`
        SELECT current_owner_id, dealer_name
          FROM dealer_leads
         WHERE id = ${row.dealer_lead_id}
         LIMIT 1
      `);
      const lead = leadRows[0] ?? { current_owner_id: null, dealer_name: null };

      if (body.decision === "approve") {
        await tx.execute(sql`
          UPDATE dealer_lead_commercials
             SET approval_status = 'approved',
                 approved_by = ${user.id},
                 approved_at = ${nowIso},
                 updated_at = NOW()
           WHERE commercial_id = ${commercialId}
        `);
        return {
          status: 200 as const,
          decision: "approved" as const,
          leadId: row.dealer_lead_id,
          value: Number(row.final_price ?? row.price_quoted ?? 0),
          quoteUrl: row.quote_document_url,
          ownerId: lead.current_owner_id,
          dealerName: lead.dealer_name,
        };
      }

      // ── reject ────────────────────────────────────────────────────────────
      await tx.execute(sql`
        UPDATE dealer_lead_commercials
           SET approval_status = 'rejected',
               approved_by = ${user.id},
               approved_at = ${nowIso},
               rejection_reason = ${body.reason ?? null},
               is_current = false,
               updated_at = NOW()
         WHERE commercial_id = ${commercialId}
      `);

      const siblings = await tx.execute<CommercialVersion>(sql`
        SELECT commercial_id, version_no, approval_status
          FROM dealer_lead_commercials
         WHERE dealer_lead_id = ${row.dealer_lead_id}
      `);
      const target = rollbackTarget([...siblings], row.version_no);

      if (target) {
        await tx.execute(sql`
          UPDATE dealer_lead_commercials
             SET is_current = true, updated_at = NOW()
           WHERE commercial_id = ${target.commercial_id}
        `);
      }

      return {
        status: 200 as const,
        decision: "rejected" as const,
        leadId: row.dealer_lead_id,
        value: Number(row.final_price ?? row.price_quoted ?? 0),
        restoredVersion: target?.version_no ?? null,
      };
    });

    if (outcome.status !== 200) {
      return NextResponse.json(
        { success: false, error: { message: outcome.message } },
        { status: outcome.status },
      );
    }

    // Touchpoints are written AFTER the transaction commits. They are a history
    // note, not part of the decision — a failure to log one must not roll back
    // an approval the CEO has already made.
    const money =
      outcome.value > 0 ? ` — ₹${outcome.value.toLocaleString("en-IN")}` : "";
    if (outcome.decision === "approved") {
      // E-242 — the approval is committed; now produce the document it entitles
      // the dealer to. Deliberately AFTER the transaction: rendering a PDF
      // launches a browser, and neither its latency nor its failure modes may
      // hold a row lock or undo a decision the CEO has already made.
      // tryGenerateQuotationDraft never throws — a failure lands in
      // quote_pdf_error and is reported to the sales manager as "retry".
      const draft = await tryGenerateQuotationDraft(commercialId);

      await writeTouchpoint({
        dealerLeadId: outcome.leadId,
        touchpointType: "quote_sent",
        performedBy: user.id,
        remarks:
          `Quote approved by CEO and released${money}` +
          (draft ? ` — draft ${draft.quote_number}` : " — draft generation failed"),
        attachments: [
          ...(draft ? [{ url: draft.quote_pdf_url, type: "quote" }] : []),
          // The rep's own attachment, when there is one. Kept alongside rather
          // than replaced by the generated draft: they are different documents.
          ...(outcome.quoteUrl ? [{ url: outcome.quoteUrl, type: "quote" }] : []),
        ],
      });

      // Tell the people who have to act on it. Until E-242 nobody was told at
      // all — the rep who raised the quote learned the outcome by going and
      // looking. emit() never throws, so this cannot fail the decision.
      await notifyQuotationApproved({
        leadId: outcome.leadId,
        commercialId,
        ownerUserId: outcome.ownerId,
        dealerName: outcome.dealerName,
        quoteNumber: draft?.quote_number ?? null,
        value: outcome.value,
        mode: "manual",
        approverName: user.name,
        draftReady: !!draft,
      });
    } else {
      await writeTouchpoint({
        dealerLeadId: outcome.leadId,
        touchpointType: "quote_rejected",
        performedBy: user.id,
        remarks:
          `Quote rejected by CEO${money} — ${body.reason}` +
          (outcome.restoredVersion
            ? ` (restored v${outcome.restoredVersion})`
            : " (lead left with no current quote)"),
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        decision: outcome.decision,
        restoredVersion:
          outcome.decision === "rejected" ? outcome.restoredVersion : undefined,
      },
    });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    if (e instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: { message: e.issues[0]?.message ?? "Invalid body" } },
        { status: 400 },
      );
    }
    // Log the WHOLE chain, then tell the CEO something they can act on.
    //
    // errorMessage() returns only `e.message`, and for a DrizzleQueryError that
    // is the SQL text plus every bound parameter — which is how a failed
    // decision came to render raw SQL, a user id and a commercial id inside the
    // approvals panel, while the actual cause (in `e.cause`) was dropped. The
    // useful half went nowhere and the half that leaked was the half that
    // should not have.
    console.error("[ceo/quotations/decision] failed", {
      commercialId: (await ctx.params).commercialId,
      message: e instanceof Error ? e.message : String(e),
      cause: e instanceof Error && e.cause instanceof Error ? e.cause.message : undefined,
    });
    return NextResponse.json(
      {
        success: false,
        error: { message: "Couldn't record that decision. Please try again." },
      },
      { status: 500 },
    );
  }
}
