/**
 * Tracker ID 173 — server guard for every stock upload (rule:
 * stockUploadRules.ts). Used by /api/inventory/bulk-upload,
 * /api/admin/inventory/bulk-upload and /api/admin/inventory/add-item, and —
 * through requireStockTransferer — /api/admin/inventory/transfer (POST).
 *
 * A dedicated guard on purpose: requireInventoryAdmin() also gates VIEWING
 * Admin › Inventory (all items, ageing, transfer, upload reports), and the
 * decision keeps the Sales Head's views while refusing its uploads.
 */
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, users } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import { resolveDealerCode } from "@/lib/auth/requireLeadAccess";
import { decideStockTransfer, decideStockUpload } from "@/lib/inventory/stockUploadRules";

/** Thrown refusal; withErrorHandler answers with `.status`. */
export class StockUploadRefused extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
        super(message);
        this.name = "StockUploadRefused";
        this.status = status;
    }
}

export type StockUploader = Awaited<ReturnType<typeof requireAuth>>;

/** The caller's own dealer account, for a dealer login (null otherwise). */
export async function ownDealerCodeOf(user: StockUploader): Promise<string | null> {
    if (user.role !== "dealer") return null;
    return resolveDealerCode({ id: user.id, role: user.role, dealer_id: user.dealer_id ?? null });
}

/**
 * Who is uploading and to which dealer. Throws 403 / 400 per the ID 173 rule.
 * The dealer id returned is the one to write — for a dealer login, its own
 * account, whatever the body said.
 */
export async function requireStockUploader(requestedDealerId: string | null | undefined): Promise<{
    user: StockUploader;
    dealerId: string;
    scope: "any" | "own";
}> {
    const user = await requireAuth();
    const decision = decideStockUpload({
        role: user.role,
        requestedDealerId,
        ownDealerCode: await ownDealerCodeOf(user),
    });
    if (!decision.ok) throw new StockUploadRefused(decision.message, decision.status);
    return { user, dealerId: decision.dealerId, scope: decision.scope };
}

/**
 * The dealer account must exist, be active and have a login (users.dealer_id
 * = accounts.id) — stock on an account without a login is invisible in every
 * dealer portal. Returns the account name, or throws 400.
 */
export async function requireStockDealerAccount(dealerId: string): Promise<{ id: string; name: string | null }> {
    const [dealer] = await db
        .select({ id: accounts.id, status: accounts.status, name: accounts.business_entity_name })
        .from(accounts)
        .where(eq(accounts.id, dealerId))
        .limit(1);
    if (!dealer || dealer.status !== "active") {
        throw new StockUploadRefused(`Dealer '${dealerId}' not found or inactive`, 400);
    }
    const [{ n }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(users)
        .where(eq(users.dealer_id, dealerId));
    if (!n) {
        throw new StockUploadRefused(
            `Dealer '${dealer.name || dealerId}' has no dealer login — inventory would be invisible in the dealer portal. Link a login user before allocating stock.`,
            400,
        );
    }
    return { id: dealer.id, name: dealer.name };
}

/**
 * Who is moving stock and between which dealers (ID 173 rule applied to
 * transfers — decideStockTransfer). Throws 403 / 400. For a dealer login the
 * source returned is always its own account.
 */
export async function requireStockTransferer(
    sourceDealerId: string | null | undefined,
    targetDealerId: string | null | undefined,
): Promise<{ user: StockUploader; sourceDealerId: string; targetDealerId: string; scope: "any" | "own" }> {
    const user = await requireAuth();
    const decision = decideStockTransfer({
        role: user.role,
        sourceDealerId,
        targetDealerId,
        ownDealerCode: await ownDealerCodeOf(user),
    });
    if (!decision.ok) throw new StockUploadRefused(decision.message, decision.status);
    return {
        user,
        sourceDealerId: decision.sourceDealerId,
        targetDealerId: decision.targetDealerId,
        scope: decision.scope,
    };
}
