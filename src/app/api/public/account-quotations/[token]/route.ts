/**
 * E-358 — the account-facing quotation endpoint. NO SESSION REQUIRED; the
 * signed token (readAccountQuoteToken — a lead token never verifies here) is
 * the only credential. Same contract as /api/public/quotations/[token], so the
 * one response page serves both:
 *
 *   GET  — what the page renders (name, number, total, document link, state).
 *   POST — { decision: "approved" | "declined", note? }, recorded once.
 *
 * A bad signature, an unknown quotation and a version mismatch are all the
 * same 404.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { mintAccountQuoteToken, readAccountQuoteToken } from "@/lib/leads/quoteToken";
import { recordAccountDealerDecision } from "@/lib/accounts/quotations/decision";
import { latestLiveAccountQuote, loadAccountQuotationById } from "@/lib/accounts/quotations/store";
import { loadAccountSummary } from "@/lib/accounts/quotations/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
    decision: z.enum(["approved", "declined"]),
    note: z.string().trim().max(1000).nullable().optional(),
});

const NOT_FOUND = { success: false, error: { message: "This quotation link is not valid or has expired." } };

const pageUrl = (l: { quotation_id: string; version_no: number } | null) =>
    l ? `/quote/a/${mintAccountQuoteToken({ quotationId: l.quotation_id, versionNo: l.version_no })}` : null;

async function resolve(token: string) {
    const claims = readAccountQuoteToken(token);
    if (!claims) return null;
    const row = await loadAccountQuotationById(claims.quotationId);
    return row && row.version_no === claims.versionNo ? row : null;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
    try {
        const row = await resolve((await ctx.params).token);
        if (!row) return NextResponse.json(NOT_FOUND, { status: 404 });
        const account = await loadAccountSummary(row.account_id);
        const live = await latestLiveAccountQuote(row.account_id);
        const replaced = !row.withdrawn_at && row.approval_status === "approved" && !row.is_latest_live;
        const stale = !!row.withdrawn_at || replaced;
        return NextResponse.json({
            success: true,
            data: {
                quote_number: row.quote_number,
                dealer_name: account?.name ?? null,
                value: Number(row.total ?? row.price_quoted ?? 0),
                pdf_url: row.quote_pdf_url,
                open: row.approval_status === "approved" && !!row.quote_pdf_url && !row.dealer_decision && !stale,
                decision: row.dealer_decision,
                decided_at: row.dealer_decision_at,
                withdrawn: row.approval_status !== "approved" || !!row.withdrawn_at,
                replaced,
                latest_url: stale && live && live.quotation_id !== row.quotation_id ? pageUrl(live) : null,
            },
        });
    } catch (e) {
        console.error("[public/account-quotations] GET failed", e);
        return NextResponse.json({ success: false, error: { message: "Couldn't load this quotation." } }, { status: 500 });
    }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
    try {
        const row = await resolve((await ctx.params).token);
        if (!row) return NextResponse.json(NOT_FOUND, { status: 404 });
        const body = Body.parse(await req.json());
        const r = await recordAccountDealerDecision({
            quotationId: row.quotation_id,
            decision: body.decision,
            via: "link",
            actor: "token",
            note: body.note ?? null,
        });
        if (r.outcome === "recorded" || r.outcome === "already_answered") {
            return NextResponse.json({
                success: true,
                data: { decision: r.decision, quote_number: r.quoteNumber, repeat: r.outcome === "already_answered" },
            });
        }
        if (r.outcome === "not_open") {
            const replaced = !!r.latest && !row.withdrawn_at;
            return NextResponse.json(
                { success: false, error: { message: r.reason }, data: { replaced, latest_url: pageUrl(r.latest) } },
                { status: 409 },
            );
        }
        return NextResponse.json(NOT_FOUND, { status: 404 });
    } catch (e) {
        if (e instanceof z.ZodError) {
            return NextResponse.json({ success: false, error: { message: "Invalid response." } }, { status: 400 });
        }
        console.error("[public/account-quotations] POST failed", e);
        return NextResponse.json(
            { success: false, error: { message: "Couldn't record your response. Please try again." } },
            { status: 500 },
        );
    }
}
