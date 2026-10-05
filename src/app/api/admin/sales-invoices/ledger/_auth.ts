/**
 * Shared guard for the E-322 invoice-ledger routes (tracker IDs 39, 71):
 * finance, CEO and Admin; 503 when E-322 is not applied to this database.
 */
import { requireRole } from "@/lib/auth-utils";
import { hasInvoiceLedgerTables } from "@/lib/sales/ledgerTables";

export const LEDGER_ROLES = ["finance_controller", "ceo", "admin"];

class LedgerUnavailable extends Error {
    readonly status = 503;
}

export async function requireLedger() {
    const user = await requireRole(LEDGER_ROLES);
    if (!(await hasInvoiceLedgerTables())) {
        throw new LedgerUnavailable("The invoice ledger needs migration E-322 on this database.");
    }
    return user;
}
