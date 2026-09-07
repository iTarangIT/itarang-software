/**
 * E-282 — where is this file, how long has it been there, and whose move is it?
 *
 * Once `submitStep4ProductSelection` writes `nbfc_lead_assignments` and flips
 * `leads.kyc_status` to `pending_final_approval`, the admin has had no
 * cross-lead view of the file at all: `/api/admin/kyc-reviews` never touches
 * the assignment table, and every other admin NBFC route is keyed by a single
 * leadId. The only rendering of a file's age lives on the NBFC's own
 * tenant-scoped portal, which the admin cannot see.
 *
 * The NBFC leg also has NO event table — `lead_flow_events` (E-278) records
 * WhatsApp console transitions and nothing about NBFC routing. So "what stage
 * is this in" has to be DERIVED from columns spread across five tables. That
 * derivation is here, as one pure function, so the table, the CSV export and
 * anything built on them later cannot disagree about what a stage means.
 */

/**
 * The `nbfc_doc_requests.status` vocabulary, restated.
 *
 * Deliberately NOT imported from `@/lib/nbfc/doc-requests` — that module
 * imports the Drizzle client at load time, which would drag a database
 * connection into both the browser bundle (this file backs the client-side
 * tracker table) and the Vitest run (whose scope is pure, no-I/O helpers).
 * Same client-safe split as `leads/bajaj-fallback-text.ts`.
 *
 * If a status is ever added there, add it here: an unknown status falls back to
 * "admin" below, which is the safe default — it surfaces the file to the people
 * who can act on it rather than hiding it on a counterparty.
 */
const DOC_STATUS = {
  RAISED: "nbfc_raised",
  ADMIN_REVIEW: "admin_review",
  FORWARDED: "forwarded_to_dealer",
  WITH_CUSTOMER: "with_customer",
  DEALER_REVIEW: "dealer_review",
  ADMIN_REVIEW_UPLOAD: "admin_review_upload",
} as const;

export type WaitingOn = "nbfc" | "admin" | "dealer" | "customer" | "none";

export type FileStageKey =
  | "rejected"
  | "docs"
  | "verdict"
  | "disbursed"
  | "sanctioned"
  | "offer"
  | "with_nbfc"
  | "unknown";

export interface FileStage {
  key: FileStageKey;
  label: string;
  waitingOn: WaitingOn;
  /** When the file entered this stage — the clock "time in stage" runs from. */
  since: Date | null;
  /** The SLA deadline governing this stage, when one is armed. */
  slaDueAt: Date | null;
}

/** The narrowest set of facts `deriveFileStage` needs. All nullable. */
export interface FileStageInput {
  assignmentStatus: string;
  assignedAt: Date | null;
  decidedAt: Date | null;
  rejectionForwardedAt: Date | null;
  rejectionAdminDueAt: Date | null;

  /** The oldest still-open `nbfc_doc_requests` row, if any. */
  openRequest: {
    status: string;
    updatedAt: Date | null;
    slaDueAt: Date | null;
  } | null;

  /** The oldest `queried|rejected` verdict not yet forwarded, if any. */
  pendingVerdict: {
    verdict: string;
    verifiedAt: Date | null;
    slaDueAt: Date | null;
  } | null;

  offerSubmittedAt: Date | null;
  sanctionedAt: Date | null;
  disbursedAt: Date | null;
}

/**
 * Which party a still-open document request is sitting with.
 *
 * The seven-hop `nbfc_doc_requests` lifecycle alternates between iTarang and
 * the dealer; `pushed_to_nbfc` / `closed` / `rejected` are terminal and never
 * reach here (the caller only passes OPEN requests).
 */
export function waitingOnForDocStatus(status: string): WaitingOn {
  switch (status) {
    case DOC_STATUS.RAISED:
    case DOC_STATUS.ADMIN_REVIEW:
    case DOC_STATUS.ADMIN_REVIEW_UPLOAD:
      return "admin";
    case DOC_STATUS.FORWARDED:
    case DOC_STATUS.DEALER_REVIEW:
      return "dealer";
    case DOC_STATUS.WITH_CUSTOMER:
      return "customer";
    default:
      return "admin";
  }
}

const DOC_STATUS_LABEL: Record<string, string> = {
  [DOC_STATUS.RAISED]: "Lender asked for documents",
  [DOC_STATUS.ADMIN_REVIEW]: "Request awaiting admin",
  [DOC_STATUS.FORWARDED]: "Forwarded to dealer",
  [DOC_STATUS.WITH_CUSTOMER]: "With customer",
  [DOC_STATUS.DEALER_REVIEW]: "Dealer collecting documents",
  [DOC_STATUS.ADMIN_REVIEW_UPLOAD]: "Uploads awaiting admin review",
};

/**
 * The single most blocking thing true about this file, most urgent first.
 *
 * Order matters and is deliberate: a rejection outranks an open document
 * request, which outranks an unforwarded verdict, which outranks the happy
 * path — because that is the order in which someone has to act.
 */
export function deriveFileStage(input: FileStageInput): FileStage {
  // 1. The lender said no. Waiting on admin until the rejection is passed on.
  if (input.assignmentStatus === "declined") {
    return {
      key: "rejected",
      label: "Rejected by lender",
      waitingOn: input.rejectionForwardedAt ? "dealer" : "admin",
      since: input.decidedAt ?? input.assignedAt,
      slaDueAt: input.rejectionForwardedAt ? null : input.rejectionAdminDueAt,
    };
  }

  // 2. An open document request — the commonest reason a file stalls.
  if (input.openRequest) {
    const { status, updatedAt, slaDueAt } = input.openRequest;
    return {
      key: "docs",
      label: DOC_STATUS_LABEL[status] ?? `Documents — ${status}`,
      waitingOn: waitingOnForDocStatus(status),
      since: updatedAt ?? input.assignedAt,
      slaDueAt,
    };
  }

  // 3. A queried/rejected document verdict nobody has forwarded yet.
  if (input.pendingVerdict) {
    return {
      key: "verdict",
      label:
        input.pendingVerdict.verdict === "rejected"
          ? "Document rejected — awaiting forward"
          : "Document queried — awaiting forward",
      waitingOn: "admin",
      since: input.pendingVerdict.verifiedAt ?? input.assignedAt,
      slaDueAt: input.pendingVerdict.slaDueAt,
    };
  }

  // 4. Done.
  if (input.disbursedAt) {
    return {
      key: "disbursed",
      label: "Disbursed",
      waitingOn: "none",
      since: input.disbursedAt,
      slaDueAt: null,
    };
  }
  if (input.sanctionedAt) {
    return {
      key: "sanctioned",
      label: "Sanctioned",
      waitingOn: "none",
      since: input.sanctionedAt,
      slaDueAt: null,
    };
  }

  // 5. The lender has made an offer; the dealer/customer has to accept it.
  if (input.assignmentStatus === "offer_submitted" || input.offerSubmittedAt) {
    return {
      key: "offer",
      label: "Offer submitted",
      waitingOn: "dealer",
      since: input.offerSubmittedAt ?? input.assignedAt,
      slaDueAt: null,
    };
  }

  // 6. Sitting with the lender, untouched.
  if (
    input.assignmentStatus === "pending" ||
    input.assignmentStatus === "in_progress"
  ) {
    return {
      key: "with_nbfc",
      label:
        input.assignmentStatus === "in_progress"
          ? "Under lender review"
          : "With lender",
      waitingOn: "nbfc",
      since: input.assignedAt,
      slaDueAt: null,
    };
  }

  // selected / not_selected / withdrawn — resolved, nobody is blocked.
  return {
    key: "unknown",
    label: humanise(input.assignmentStatus),
    waitingOn: "none",
    since: input.decidedAt ?? input.assignedAt,
    slaDueAt: null,
  };
}

export const WAITING_ON_LABEL: Record<WaitingOn, string> = {
  nbfc: "Lender",
  admin: "iTarang",
  dealer: "Dealer",
  customer: "Customer",
  none: "—",
};

/**
 * Coarse elapsed time — "4d 2h", "3h 12m", "just now".
 *
 * Shared by the table and the CSV so a row and its exported line never print
 * different ages. The repo already carries six ad-hoc relativeTime/timeAgo/
 * ageDays copies; this is deliberately not a seventh private one.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** Whole days elapsed — what the amber/red age thresholds key on. */
export function daysElapsed(ms: number | null | undefined): number {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return 0;
  return Math.floor(ms / 86_400_000);
}

function humanise(status: string): string {
  if (!status) return "Unknown";
  return status
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
