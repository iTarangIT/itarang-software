/**
 * Tracker ID 173 — who may add stock (bulk upload, Add item) and to which
 * dealer. One rule for BOTH stock uploads: the older Inventory › Bulk upload
 * (/api/inventory/bulk-upload) and Admin › Inventory › Bulk Upload / Add item
 * (/api/admin/inventory/bulk-upload, /add-item).
 *
 * Decision (Kartik, 10 Oct): Admin, Inventory Manager and partner (Chirag,
 * via ID 174) for any dealer; a dealer login only for its own account;
 * everyone else refused — Sales Head and Ops included, although they keep
 * VIEWING Admin › Inventory (INVENTORY_ADMIN_ROLES in auth-utils.ts is the
 * view list and is deliberately not this one).
 *
 * `super_admin` is in some older role lists but no login has it (checked on
 * database-1, 16 Oct), so it is not carried here.
 *
 * Pure: no I/O, unit-tested in __tests__/stockUploadRules.test.ts. The server
 * guard is stockUploadGuard.ts.
 */

/** Roles that may upload stock to any dealer account. */
export const STOCK_UPLOAD_ANY_DEALER_ROLES: ReadonlySet<string> = new Set([
    "admin",
    "inventory_manager",
    "partner",
]);

export type StockUploadDecision =
    | { ok: true; dealerId: string; scope: "any" | "own" }
    | { ok: false; status: 400 | 403; message: string };

/** What the upload page should offer this role: a dealer picker, the own account only, or nothing. */
export function stockUploadMode(role: string | null | undefined): "any" | "own" | "none" {
    const r = (role ?? "").trim();
    if (STOCK_UPLOAD_ANY_DEALER_ROLES.has(r)) return "any";
    if (r === "dealer") return "own";
    return "none";
}

/**
 * Decide one upload. `requestedDealerId` is what the request body names;
 * `ownDealerCode` is the caller's own dealer account (users.dealer_id, which
 * equals accounts.id — resolveDealerCode), only meaningful for a dealer.
 *
 * A dealer never picks the account: it is taken from the login. Naming a
 * different dealer in the request is refused outright, so a forged body is
 * visible as a 403 rather than silently redirected.
 */
export function decideStockUpload(input: {
    role: string | null | undefined;
    requestedDealerId: string | null | undefined;
    ownDealerCode: string | null | undefined;
}): StockUploadDecision {
    const mode = stockUploadMode(input.role);
    const requested = (input.requestedDealerId ?? "").trim();

    if (mode === "any") {
        if (!requested) return { ok: false, status: 400, message: "Pick the dealer the stock goes to." };
        return { ok: true, dealerId: requested, scope: "any" };
    }

    if (mode === "own") {
        const own = (input.ownDealerCode ?? "").trim();
        if (!own) {
            return {
                ok: false,
                status: 403,
                message: "Your login is not linked to a dealer account, so stock cannot be added. Ask iTarang to link it.",
            };
        }
        if (requested && requested !== own) {
            return { ok: false, status: 403, message: "You can add stock only to your own dealer account." };
        }
        return { ok: true, dealerId: own, scope: "own" };
    }

    return {
        ok: false,
        status: 403,
        message: "Only Admin, the Inventory Manager, the partner login or the dealer itself can add stock.",
    };
}

export type StockTransferDecision =
    | { ok: true; sourceDealerId: string; targetDealerId: string; scope: "any" | "own" }
    | { ok: false; status: 400 | 403; message: string };

/**
 * Decide one stock transfer (Admin › Inventory › Transfer). Same rule as an
 * upload, because a transfer puts serials into the target dealer's stock (the
 * target's acknowledgement rewrites inventory.dealer_id): Admin, Inventory
 * Manager and partner from any dealer to any dealer; a dealer only out of its
 * own stock; everyone else refused — Sales Head and Ops included, although
 * they keep the transfer list view.
 */
export function decideStockTransfer(input: {
    role: string | null | undefined;
    sourceDealerId: string | null | undefined;
    targetDealerId: string | null | undefined;
    ownDealerCode: string | null | undefined;
}): StockTransferDecision {
    const mode = stockUploadMode(input.role);
    if (mode === "none") {
        return {
            ok: false,
            status: 403,
            message: "Only Admin, the Inventory Manager, the partner login or the dealer itself can move stock.",
        };
    }
    const source = (input.sourceDealerId ?? "").trim();
    if (mode === "any" && !source) {
        return { ok: false, status: 400, message: "Pick the dealer the stock comes from." };
    }
    if (mode === "own") {
        const own = (input.ownDealerCode ?? "").trim();
        if (!own) {
            return {
                ok: false,
                status: 403,
                message: "Your login is not linked to a dealer account, so stock cannot be moved. Ask iTarang to link it.",
            };
        }
        if (source && source !== own) {
            return { ok: false, status: 403, message: "You can move stock only out of your own dealer account." };
        }
    }
    const sourceDealerId = mode === "own" ? (input.ownDealerCode ?? "").trim() : source;
    const targetDealerId = (input.targetDealerId ?? "").trim();
    if (!targetDealerId) return { ok: false, status: 400, message: "Pick the dealer the stock goes to." };
    if (targetDealerId === sourceDealerId) {
        return { ok: false, status: 400, message: "Source and target dealer must differ." };
    }
    return { ok: true, sourceDealerId, targetDealerId, scope: mode };
}
