/**
 * The Drizzle transaction handle type.
 *
 * Split into its own module so `transition.ts` and `activity.ts` can require a
 * transaction *by signature* — a caller physically cannot pass the bare `db`
 * client. That is what makes "the audit row is written in the same transaction
 * as the change" (BRD invariant 5) a compile-time property rather than a
 * convention people have to remember.
 */

import type { db } from "@/lib/db";

export type BuybackTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
