/**
 * E-390 — Battery Pool diagram 1: the iTarang House dealer login checks the
 * dealer assignment of an "uncertain" application (20 Nov: moved from the
 * iTarang Admin to the house). Until the house approves or changes the dealer
 * the file is held: it cannot go to a lender and it stays off the Admin /
 * Sales Head KYC review queue.
 * Pure rules (no I/O; unit-tested in __tests__/dealer-assignment-rules.test.ts).
 * The DB side lives in ./dealer-assignment.ts.
 *
 * Uncertain = the dealer was
 *   multi_pick         — picked by an iTarang salesperson from the several dealers he owns;
 *   single_owned       — auto-tagged to the one dealer the salesperson owns;
 *   manual_pick        — named by an iTarang salesperson by search / mobile (no ownership link);
 *   house_push         — assigned by the iTarang House admin (push to dealer);
 *   dealer_salesperson — the lead was created by a dealer sales-team member (E-277);
 *   resubmit           — re-picked by the initiator after the admin rejected the dealer.
 * A dealer creating his own lead is never checked.
 *
 * While a check is open the lead carries leads.assignment_status =
 * 'pending_verification'; after a rejection 'dealer_rejected'. Both block the
 * Step 4 send-to-lender and keep the file off the admin KYC review queue. The
 * dealer can carry on with KYC and consent meanwhile.
 */

export const DEALER_CHECK_PENDING = "pending_verification";
export const DEALER_CHECK_REJECTED = "dealer_rejected";

export const DEALER_CHECK_KINDS = [
  "multi_pick",
  "single_owned",
  "manual_pick",
  "house_push",
  "dealer_salesperson",
  "resubmit",
] as const;
export type DealerCheckKind = (typeof DEALER_CHECK_KINDS)[number];

export type DealerReviewStatus = "pending" | "approved" | "changed" | "rejected";

export function isDealerCheckKind(v: unknown): v is DealerCheckKind {
  return typeof v === "string" && (DEALER_CHECK_KINDS as readonly string[]).includes(v);
}

/** Why the house is being asked, in the words the queue shows. */
export function dealerCheckKindLabel(kind: string): string {
  switch (kind) {
    case "multi_pick":
      return "Salesperson picked one of several dealers he owns";
    case "single_owned":
      return "Auto-tagged to the only dealer the salesperson owns";
    case "manual_pick":
      return "Salesperson named the dealer (search / mobile)";
    case "house_push":
      return "Assigned by iTarang House admin";
    case "dealer_salesperson":
      return "Created by the dealer's sales team";
    case "resubmit":
      return "Re-picked after iTarang House rejected the dealer";
    default:
      return kind;
  }
}

/** How many dealers a salesperson owns decides what the initiator sees. */
export function pickOutcome(eligibleCount: number): "house" | "auto" | "pick" {
  if (eligibleCount <= 0) return "house";
  if (eligibleCount === 1) return "auto";
  return "pick";
}

/** The reason kind for a dealer an iTarang salesperson chose. */
export function kindForSalespersonPick(opts: { eligibleCount: number; pickedFromOwned: boolean }): DealerCheckKind {
  if (!opts.pickedFromOwned) return "manual_pick";
  return opts.eligibleCount === 1 ? "single_owned" : "multi_pick";
}

/** Is the file held by an open (or rejected) dealer check? */
export function isDealerCheckHold(assignmentStatus: string | null | undefined): boolean {
  return assignmentStatus === DEALER_CHECK_PENDING || assignmentStatus === DEALER_CHECK_REJECTED;
}

/** The assignment_status values that hold a file (for SQL filters). */
export const DEALER_CHECK_HOLD_STATUSES = [DEALER_CHECK_PENDING, DEALER_CHECK_REJECTED] as const;

export type RoutingBlock = { blocked: false } | { blocked: true; message: string };

/**
 * May this file be sent to a lender (Step 4) now? Only the two dealer-check
 * states block; every other value ('assigned', 'unassigned', null, …) passes
 * so nothing that worked before this change stops working.
 */
export function isNbfcRoutingBlocked(assignmentStatus: string | null | undefined): RoutingBlock {
  if (assignmentStatus === DEALER_CHECK_PENDING) {
    return {
      blocked: true,
      message:
        "The dealer on this application is waiting for iTarang House to confirm it. It can be sent to a lender once iTarang House approves.",
    };
  }
  if (assignmentStatus === DEALER_CHECK_REJECTED) {
    return {
      blocked: true,
      message:
        "iTarang House rejected the dealer on this application. Pick the correct dealer again; it can be sent to a lender once iTarang House approves.",
    };
  }
  return { blocked: false };
}

export type DealerDecision = "approve" | "change" | "reject";

/** Validates a dealer-check decision's inputs. */
export function validateDealerDecision(input: {
  decision: DealerDecision;
  newDealerId?: string | null;
  currentDealerId: string;
  reason?: string | null;
}): { ok: true } | { ok: false; message: string } {
  if (input.decision === "reject" && !(input.reason ?? "").trim()) {
    return { ok: false, message: "A reason is required to reject the dealer." };
  }
  if (input.decision === "change") {
    const next = (input.newDealerId ?? "").trim();
    if (!next) return { ok: false, message: "Pick the correct dealer." };
    if (next === input.currentDealerId) {
      return { ok: false, message: "That is the dealer already on the file — use Approve instead." };
    }
  }
  return { ok: true };
}
