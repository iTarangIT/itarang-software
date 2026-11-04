/**
 * FIFO allocation of one payment across a loan's unpaid EMIs (3 Nov): money
 * clears the OLDEST unpaid EMI first, then the next, and so on. A customer
 * who missed January and February and pays in March has January cleared
 * first; whatever is left stays pending on the later EMIs.
 *
 * Pure (no db) so it is unit-tested; applyLoanPaymentFifo.ts does the writes.
 */

export type OpenEmi = {
  id: string;
  /** YYYY-MM-DD */
  dueDate: string;
  /** What is still owed on this EMI, in paise. */
  remainingPaise: number;
};

export type FifoAllocation = { id: string; paise: number };

/** Split `amountPaise` over `open`, oldest due date first. */
export function allocateFifo(
  open: readonly OpenEmi[],
  amountPaise: number,
): { allocations: FifoAllocation[]; leftoverPaise: number } {
  let left = Math.max(0, Math.round(amountPaise));
  const allocations: FifoAllocation[] = [];
  const sorted = [...open].sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
  for (const e of sorted) {
    if (left <= 0) break;
    const owed = Math.max(0, Math.round(e.remainingPaise));
    if (owed <= 0) continue;
    const take = Math.min(owed, left);
    allocations.push({ id: e.id, paise: take });
    left -= take;
  }
  return { allocations, leftoverPaise: left };
}

/** Total still owed over the given EMIs, in paise. */
export function totalOwedPaise(open: readonly OpenEmi[]): number {
  return open.reduce((s, e) => s + Math.max(0, Math.round(e.remainingPaise)), 0);
}
