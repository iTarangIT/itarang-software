// Single-owner guard helpers (BRD §0.3).
//
// Every mutate route on a dealer_lead calls assertOwner before doing work.
// Admin paths that explicitly need to bypass (escalation resolution per
// BRD §0.6) skip this and audit through their own touchpoint type — admin
// is supposed to reassign-then-edit, not silently override.

import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export class ForbiddenLeadAccessError extends Error {
  code = "FORBIDDEN_LEAD_ACCESS";
  currentOwnerId: string | null;
  constructor(currentOwnerId: string | null) {
    super(
      currentOwnerId
        ? `Not the current owner of this lead (current_owner_id=${currentOwnerId}).`
        : "Lead has no current owner.",
    );
    this.currentOwnerId = currentOwnerId;
  }
}

export class StaleLeadError extends Error {
  code = "STALE_LEAD";
  // BRD §0.3 concurrency banner needs to surface who the new owner is and
  // when the update happened so the UI can render: "Lead has been
  // reassigned to [name] by [actor] at [time]. Please coordinate before
  // retrying."
  currentOwnerId: string | null;
  currentUpdatedAt: Date | null;
  constructor(
    currentOwnerId: string | null,
    currentUpdatedAt: Date | null,
  ) {
    super("Lead was updated by someone else. Refresh required.");
    this.currentOwnerId = currentOwnerId;
    this.currentUpdatedAt = currentUpdatedAt;
  }
}

export async function assertOwner(
  leadId: string,
  userId: string,
): Promise<void> {
  const [row] = await db
    .select({ current_owner_id: dealerLeads.current_owner_id })
    .from(dealerLeads)
    .where(eq(dealerLeads.id, leadId))
    .limit(1);

  if (!row || row.current_owner_id !== userId) {
    throw new ForbiddenLeadAccessError(row?.current_owner_id ?? null);
  }
}

export async function assertNotStale(
  leadId: string,
  updatedAtSeen: Date,
): Promise<void> {
  const [row] = await db
    .select({
      current_owner_id: dealerLeads.current_owner_id,
      updated_at: dealerLeads.updated_at,
    })
    .from(dealerLeads)
    .where(eq(dealerLeads.id, leadId))
    .limit(1);

  if (!row) {
    throw new StaleLeadError(null, null);
  }

  const dbUpdated = row.updated_at ? new Date(row.updated_at) : null;
  if (dbUpdated && dbUpdated.getTime() > updatedAtSeen.getTime()) {
    throw new StaleLeadError(row.current_owner_id ?? null, dbUpdated);
  }
}
