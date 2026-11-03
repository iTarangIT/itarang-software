/**
 * Vyapar payment sync — what Accounts Receivable WILL be once an upload is
 * imported, by the same rule the receivables page sums today
 * (lib/dashboard/receivables.ts listReceivables + netOwed):
 *
 *   * an invoice counts while it is outstanding: status not paid / void /
 *     draft, and a balance above zero;
 *   * a credit note (status 'credit_note', negative balance) nets only
 *     against a customer who still has an outstanding invoice;
 *   * per customer (owe_key), the net is never below zero.
 *
 * PURE — the rows come from ./paymentSyncProjection.ts; unit tested.
 */

export type ProjectionRow = {
    source: string;
    id: string;
    owe_key: string;
    balance: number;
    status: string | null;
    name: string | null;
};

/** What the upload changes on one existing row. */
export type RowOverride = { balance: number; status: string | null };

export type CustomerChange = { owe_key: string; name: string | null; before: number; after: number };

export type ReceivableProjection = {
    before: number;
    after: number;
    /** Customers whose net owed changes, largest change first. */
    customers: CustomerChange[];
};

const isCredit = (r: Pick<ProjectionRow, "source">) => r.source === "credit";

function outstanding(r: ProjectionRow): boolean {
    return !isCredit(r) && !["paid", "void", "draft"].includes(r.status ?? "") && r.balance > 0;
}

/** Net owed per customer, by the receivables page's rule. */
export function owedByCustomer(rows: ProjectionRow[]): Map<string, number> {
    const owing = new Set(rows.filter(outstanding).map((r) => r.owe_key));
    const per = new Map<string, number>();
    for (const r of rows) {
        if (!owing.has(r.owe_key)) continue;
        const counts = outstanding(r) || (isCredit(r) && r.status === "credit_note" && r.balance < 0);
        if (counts) per.set(r.owe_key, (per.get(r.owe_key) ?? 0) + r.balance);
    }
    for (const [k, v] of per) per.set(k, Math.max(0, v));
    return per;
}

const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Before = the rows as they are; after = with `overrides` applied (keyed
 * `${source}:${id}`) and `added` rows (invoices / credit notes the upload
 * creates) included. A void or draft row keeps its status.
 */
export function projectReceivable(
    rows: ProjectionRow[],
    overrides: Map<string, RowOverride>,
    added: ProjectionRow[] = [],
): ReceivableProjection {
    const after = rows.map((r) => {
        const o = overrides.get(`${r.source}:${r.id}`);
        if (!o) return r;
        const keep = r.status === "void" || r.status === "draft";
        return { ...r, balance: o.balance, status: keep ? r.status : o.status };
    });
    after.push(...added);
    const b = owedByCustomer(rows);
    const a = owedByCustomer(after);
    const names = new Map<string, string | null>();
    for (const r of [...rows, ...added]) if (!names.get(r.owe_key)) names.set(r.owe_key, r.name);
    const customers: CustomerChange[] = [];
    for (const k of new Set([...b.keys(), ...a.keys()])) {
        const before = r2(b.get(k) ?? 0);
        const aft = r2(a.get(k) ?? 0);
        if (Math.abs(before - aft) > 0.5) customers.push({ owe_key: k, name: names.get(k) ?? null, before, after: aft });
    }
    customers.sort((x, y) => Math.abs(y.before - y.after) - Math.abs(x.before - x.after));
    return { before: r2(total(b)), after: r2(total(a)), customers };
}
