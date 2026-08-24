/**
 * The customer-facing name of a lender, in chat.
 *
 * WHY LENDERS ARE NEVER NAMED. A WhatsApp message is forwardable, screenshotable
 * and outside our control the moment it is delivered. Naming the NBFC that
 * offered a given rate leaks which lenders iTarang works with and on what terms
 * — commercial information the portal deliberately masks too. So the borrower
 * sees "iTarang Scheme 1", and the real ids travel only inside row payloads.
 *
 * WHY THERE ARE TWO FUNCTIONS. `schemeName(index)` is positional over whatever
 * list is being rendered right now. That is correct while the customer is still
 * CHOOSING at Step 4 — nothing is committed, and the list is the only context.
 *
 * It stops being correct the moment anything is remembered. The Step-4 option
 * list comes from the BRE and is re-derived on every turn; a lender can be
 * deactivated, a product can drop out of band, and the list reorders. If the
 * offer phase called `schemeName(index)` again, "Scheme 2" in the offer message
 * could be a different lender from the "Scheme 2" the customer picked an hour
 * earlier — and the customer would accept terms believing they came from someone
 * else. That is a silent mis-sale, not a cosmetic bug.
 *
 * So everything after Step-4 submit uses `schemeLabelsForLead`, which numbers
 * lenders by `product_selections.selected_nbfcs` — the order frozen at submit,
 * which is exactly the order the customer was looking at when they chose.
 *
 * The database read is imported lazily so the two pure functions here stay
 * importable without a DATABASE_URL — that is what lets the rule above be unit
 * tested at all, and this repo's vitest scope is deliberately no-I/O helpers.
 */

/**
 * Positional label — valid only within one rendering of one list. Use while the
 * customer is still choosing; use `schemeLabelsForLead` for anything afterwards.
 */
export function schemeName(index: number): string {
  return `iTarang Scheme ${index + 1}`;
}

/**
 * `nbfc_id → "iTarang Scheme N"` in the order the customer picked at Step 4.
 *
 * Reads the newest `product_selections` row for the lead. Returns an empty map
 * when nothing has been submitted yet or the row carries no lenders — callers
 * fall back to a positional label, which is the best that can be said when
 * there is no frozen order to honour.
 */
export async function schemeLabelsForLead(
  leadId: string,
): Promise<Map<number, string>> {
  const [{ db }, { productSelections }, { desc, eq }] = await Promise.all([
    import("@/lib/db"),
    import("@/lib/db/schema"),
    import("drizzle-orm"),
  ]);

  const [row] = await db
    .select({ selected_nbfcs: productSelections.selected_nbfcs })
    .from(productSelections)
    .where(eq(productSelections.lead_id, leadId))
    .orderBy(desc(productSelections.created_at))
    .limit(1);

  const labels = new Map<number, string>();
  const picked = row?.selected_nbfcs;
  if (!Array.isArray(picked)) return labels;

  picked.forEach((p, i) => {
    // `selected_nbfcs` is jsonb written as [{ nbfc_id, loan_product_id }], and
    // nbfc_id has been stored as both a number and a string over the table's
    // life. Coerce rather than trust, and skip anything that is not an id.
    const raw = (p as { nbfc_id?: unknown } | null)?.nbfc_id;
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) return;
    if (!labels.has(id)) labels.set(id, schemeName(i));
  });
  return labels;
}

/**
 * The label for one lender, with a positional fallback for a lead whose frozen
 * order cannot be read. `fallbackIndex` is the lender's position in whatever
 * list the caller is rendering.
 */
export function labelFor(
  labels: Map<number, string>,
  nbfcId: number,
  fallbackIndex: number,
): string {
  return labels.get(nbfcId) ?? schemeName(fallbackIndex);
}
