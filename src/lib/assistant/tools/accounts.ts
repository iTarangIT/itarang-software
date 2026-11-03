// ID 211 — the WhatsApp assistant knows the person's dealer ACCOUNTS (converted
// dealers), not only leads: "my dealers", an account's details, the visit link
// and (tools/write/createAccountQuote.ts) a quotation on an account.
//
// Scope is the account page's own: accountQuoteAccess (owner; an ASM also
// their direct reports' accounts). An account outside it is NOT_FOUND —
// indistinguishable from one that does not exist (Invariant 1). Rows are an
// allowlisted projection (Invariant 8): never the OEM evaluation, GSTIN or
// contact details.

import { z } from "zod";
import { crmBaseUrl } from "../config";
import { istIso } from "../format";
import { MAX_TOOL_ROWS, pageOffset, pagingArgs, type AccountRowSummary, type ToolContext, type ToolResult } from "../types";
import { defineTool, NOT_FOUND, type ToolFactory } from "./spec";

export const AccountId = z
    .string()
    .trim()
    .min(1)
    .max(64)
    .describe("A dealer account id exactly as returned by my_dealers. Never invent or guess one.");

export function accountUrl(accountId: string): string {
    return `${crmBaseUrl()}/my-dealers/${encodeURIComponent(accountId)}`;
}

/** The camera + live-location page for a visit on a dealer account (as visitCaptureUrl for a lead). */
export function accountVisitCaptureUrl(accountId: string): string {
    return `${crmBaseUrl()}/visits/capture?account=${encodeURIComponent(accountId)}`;
}

export const ACCOUNT_VISIT_REASON =
    "A visit on a dealer account is logged in the CRM with a shop photo and your live location. Open this link at the shop:";

type ScopedAccount = Awaited<ReturnType<typeof import("@/lib/accounts/quotations/access").accountQuoteAccess>>;

/**
 * The account if the user may see it (`view`) or act on it (`create`), else
 * the result to return. Out of scope ≡ not found.
 */
export async function accountInScopeOr(
    ctx: Pick<ToolContext, "user">,
    accountId: string,
    need: "view" | "create",
): Promise<{ access: NonNullable<ScopedAccount>; result?: undefined } | { access?: undefined; result: ToolResult }> {
    const { accountQuoteAccess } = await import("@/lib/accounts/quotations/access");
    const access = await accountQuoteAccess(ctx.user, accountId);
    if (!access || !access.canView) return { result: NOT_FOUND };
    if (need === "create" && !access.canCreate) {
        return { result: { kind: "declined", reason: "This dealer account belongs to someone else, so it is read-only for you." } };
    }
    return { access };
}

/** Allowlisted account row. Pure. */
export function toAccountSummary(
    r: {
        account_id: string | null;
        dealer: string;
        city: string | null;
        owner_id: string | null;
        owner_name: string | null;
        last_order: string | null;
        days_since_last_order: number | null;
        bucket: string;
    },
    userId: string,
    bucketLabel: (b: string) => string,
): AccountRowSummary {
    return {
        id: r.account_id ?? "",
        name: r.dealer,
        city: r.city,
        owner_name: r.owner_name,
        owned_by_you: r.owner_id === userId,
        last_order: r.last_order,
        days_since_last_order: r.days_since_last_order,
        health: bucketLabel(r.bucket),
        crm_url: accountUrl(r.account_id ?? ""),
    };
}

/** Every word of the query in the dealer's name or city. Pure. */
export function matchesAccountQuery(r: { dealer: string; city: string | null }, q: string | undefined): boolean {
    const words = (q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const hay = `${r.dealer} ${r.city ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
}

async function bucketLabeler(): Promise<(b: string) => string> {
    const { ACCOUNT_BUCKET_LABELS } = await import("@/lib/dealers/accountHealthRules");
    return (b) => (ACCOUNT_BUCKET_LABELS as Record<string, string>)[b] ?? b;
}

export const myDealers: ToolFactory = () =>
    defineTool({
        name: "my_dealers",
        kind: "read",
        description:
            "The user's dealer ACCOUNTS (converted dealers — 'my dealers', 'mere dealers', 'counters'), and for an ASM " +
            "also their team's: name, city, owner, last order and health. `query` finds one by name or city. Use this, " +
            "not search_lead, for a dealer who already buys from us.",
        schema: z.object({
            query: z.string().trim().max(80).optional().describe("Part of the dealer's name or city"),
            page: z.number().int().min(1).max(50).optional(),
        }),
        run: async (ctx, input): Promise<ToolResult> => {
            const { myDealerRows } = await import("@/lib/accounts/myDealers");
            const { rows } = await myDealerRows(ctx.user);
            const label = await bucketLabeler();
            const found = rows.filter((r) => matchesAccountQuery(r, input.query));
            const offset = pageOffset(input.page);
            return {
                kind: "accounts",
                title: input.query ? `Dealers matching "${input.query}"` : "My dealers",
                rows: found.slice(offset, offset + MAX_TOOL_ROWS).map((r) => toAccountSummary(r, ctx.user.id, label)),
                total: found.length,
                crm_url: `${crmBaseUrl()}/my-dealers`,
                paging: { page: input.page ?? 1, page_size: MAX_TOOL_ROWS, args: pagingArgs(input) },
            };
        },
    });

export const getAccountDetails: ToolFactory = () =>
    defineTool({
        name: "get_account_details",
        kind: "read",
        description:
            "One dealer account (account_id from my_dealers): owner, city, last order, health and its quotations " +
            "(version, total, approval, dealer's answer). Read-only.",
        schema: z.object({ account_id: AccountId }),
        run: async (ctx, input): Promise<ToolResult> => {
            const scoped = await accountInScopeOr(ctx, input.account_id, "view");
            if (scoped.result) return scoped.result;
            const { account, canCreate } = scoped.access;
            const [{ myDealerRows }, { listAccountQuotations }, { hasAccountQuotationTables }, label] = await Promise.all([
                import("@/lib/accounts/myDealers"),
                import("@/lib/accounts/quotations/store"),
                import("@/lib/accounts/quotations/access"),
                bucketLabeler(),
            ]);
            const [{ rows }, quotes] = await Promise.all([
                myDealerRows(ctx.user),
                (await hasAccountQuotationTables()) ? listAccountQuotations(account.id) : Promise.resolve([]),
            ]);
            const health = rows.find((r) => r.account_id === account.id);
            return {
                kind: "account",
                account: {
                    id: account.id,
                    name: account.name,
                    city: account.city,
                    state: account.state,
                    owner_name: account.owner_name,
                    owned_by_you: account.owner_id === ctx.user.id,
                    can_quote: canCreate,
                    last_order: health?.last_order ?? null,
                    days_since_last_order: health?.days_since_last_order ?? null,
                    health: health ? label(health.bucket) : null,
                    // Allowlist: never oem_evaluation, product prices beyond the total, or files.
                    quotations: quotes.slice(0, 5).map((q) => ({
                        version: q.version_no,
                        quote_number: q.quote_number,
                        total: q.total ?? q.price_quoted,
                        approval: q.approval_status,
                        rejection_reason: q.approval_status === "rejected" ? q.rejection_reason : null,
                        dealer_decision: q.dealer_decision,
                        created_at: istIso((q as { created_at?: unknown }).created_at),
                    })),
                    crm_url: accountUrl(account.id),
                },
            };
        },
    });

export const accountVisitLink: ToolFactory = () =>
    defineTool({
        name: "account_visit_link",
        kind: "read",
        description:
            "Log a visit on a dealer ACCOUNT (account_id from my_dealers): replies with the CRM link that records it " +
            "with a shop photo and live location. A visit is never saved from a chat photo or a location pin.",
        schema: z.object({ account_id: AccountId }),
        run: async (ctx, input): Promise<ToolResult> => {
            const scoped = await accountInScopeOr(ctx, input.account_id, "create");
            if (scoped.result) return scoped.result;
            return {
                kind: "declined",
                reason: `${ACCOUNT_VISIT_REASON} ${scoped.access.account.name}`,
                crm_url: accountVisitCaptureUrl(scoped.access.account.id),
            };
        },
    });
