/**
 * Human-readable request references: BB-1024, BB-1025, …
 *
 * The design uses them everywhere and M23 makes them searchable, so they must be
 * short, stable and quotable on the phone. The UUID is the primary key; this is
 * the label a human says out loud.
 *
 * Drawn from `buyback_request_no_seq` (created in E-185). A sequence, not
 * `max(request_no) + 1` — that would hand two concurrent dealers the same number.
 */

import { sql } from "drizzle-orm";

import type { BuybackTx } from "./tx";

export async function nextRequestNo(tx: BuybackTx): Promise<string> {
  const rows = await tx.execute(sql`SELECT nextval('buyback_request_no_seq') AS n`);
  const n = (rows as unknown as Array<{ n: string | number }>)[0].n;

  return `BB-${n}`;
}
