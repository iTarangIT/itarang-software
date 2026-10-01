/**
 * Feature Request & Approval — the state machine (E-316).
 *
 * Pure: no I/O. The API routes load the request + the active seat directory,
 * call applyAction(), and persist what it returns inside one transaction.
 * Permissions come from the actor's SEAT (feature_request_members), never from
 * users.role, so adding a developer is a row, not a code change.
 */

export const SEATS = ["requester", "product_reviewer", "tech_reviewer", "developer"] as const;
export type Seat = (typeof SEATS)[number];

export const STATUSES = [
  "pending_product_review",
  "changes_requested",
  "pending_tech_review",
  "rejected",
  "ready_for_assignment",
  "assigned",
  "in_development",
  "testing",
  "ready_for_deployment",
  "deployed",
  "closed",
] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_LABELS: Record<Status, string> = {
  pending_product_review: "Pending Product Review",
  changes_requested: "Changes Requested",
  pending_tech_review: "Pending Technical Review",
  rejected: "Rejected",
  ready_for_assignment: "Ready for Assignment",
  assigned: "Assigned",
  in_development: "In Development",
  testing: "Testing",
  ready_for_deployment: "Ready for Deployment",
  deployed: "Deployed",
  closed: "Closed",
};

export const SEAT_LABELS: Record<Seat, string> = {
  requester: "CEO",
  product_reviewer: "Product Head",
  tech_reviewer: "Tech Head",
  developer: "Developer",
};

export const PRIORITIES = ["low", "medium", "high", "critical"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** The developer's own track, in order. */
export const DEV_FLOW: Status[] = [
  "assigned",
  "in_development",
  "testing",
  "ready_for_deployment",
  "deployed",
  "closed",
];

/** Where a developer may move a request from its current status. */
export function devNextStatuses(status: Status): Status[] {
  const i = DEV_FLOW.indexOf(status);
  if (i < 0 || i === DEV_FLOW.length - 1) return [];
  const next: Status[] = [DEV_FLOW[i + 1]];
  if (status === "testing" || status === "ready_for_deployment") next.push("in_development");
  return next;
}

export type FrState = {
  status: Status;
  createdBy: string;
  currentOwnerId: string | null;
  assignedDeveloperId: string | null;
  resubmitToStatus: Status | null;
  revision: number;
};

export type Actor = { userId: string; seat: Seat | null };

/** The ACTIVE seat holders, as loaded from feature_request_members. */
export type Directory = {
  productReviewerId: string | null;
  techReviewerId: string | null;
  developerIds: string[];
};

export type ActionInput =
  | { action: "approve"; note?: string }
  | { action: "request_changes"; reason: string; target?: "requester" | "product_reviewer" }
  | { action: "reject"; reason: string }
  | { action: "resubmit"; note?: string }
  | { action: "reopen"; reason: string }
  | { action: "assign"; developerId: string; note?: string }
  | { action: "set_status"; toStatus: Status; note?: string };

export type ActionName = ActionInput["action"];

export type CommentKind =
  | "comment"
  | "created"
  | "edited"
  | "approval"
  | "rejection"
  | "changes_requested"
  | "assignment"
  | "status_change"
  | "resubmission"
  | "reopen";

export type ActionResult = {
  patch: {
    status: Status;
    currentOwnerId: string | null;
    resubmitToStatus: Status | null;
    assignedDeveloperId: string | null;
    revision: number;
    closedAt: "now" | null;
  };
  event: { action: ActionName; fromStatus: Status; toStatus: Status; targetUserId: string | null; note: string | null };
  comment: { kind: CommentKind; body: string };
  /** Users to notify (the actor is already removed). */
  notifyUserIds: string[];
};

/** A refused transition. `status` is honoured by withErrorHandler. */
export class WorkflowError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409 = 409,
  ) {
    super(message);
  }
}

const clean = (s: string | undefined | null) => (s ?? "").trim();

/** Whether this actor may edit the request's fields right now. */
export function canEditRequest(fr: FrState, actor: Actor): boolean {
  return fr.status === "changes_requested" && fr.currentOwnerId === actor.userId;
}

/** Every action this actor may take on the request in its current state. */
export function availableActions(fr: FrState, actor: Actor): ActionName[] {
  const { seat } = actor;
  const out: ActionName[] = [];
  switch (fr.status) {
    case "pending_product_review":
      if (seat === "product_reviewer") out.push("approve", "request_changes", "reject");
      break;
    case "pending_tech_review":
      if (seat === "tech_reviewer") out.push("approve", "request_changes", "reject");
      break;
    case "changes_requested":
      if (fr.currentOwnerId === actor.userId) out.push("resubmit");
      break;
    case "rejected":
      if (seat === "requester") out.push("reopen");
      break;
    case "ready_for_assignment":
      if (seat === "tech_reviewer") out.push("assign");
      break;
    case "assigned":
      if (seat === "tech_reviewer") out.push("assign"); // reassign before work starts
      break;
  }
  if (
    seat === "developer" &&
    fr.assignedDeveloperId === actor.userId &&
    devNextStatuses(fr.status).length > 0
  ) {
    out.push("set_status");
  }
  return out;
}

function ownerForStage(stage: Status, dir: Directory): string {
  const id = stage === "pending_tech_review" ? dir.techReviewerId : dir.productReviewerId;
  if (!id) {
    throw new WorkflowError(
      `No active ${stage === "pending_tech_review" ? "Tech Head" : "Product Head"} is set up for feature requests.`,
    );
  }
  return id;
}

export function applyAction(
  fr: FrState,
  actor: Actor,
  input: ActionInput,
  dir: Directory,
): ActionResult {
  if (!availableActions(fr, actor).includes(input.action)) {
    throw new WorkflowError(
      `You can't "${input.action.replace("_", " ")}" a request that is ${STATUS_LABELS[fr.status]}.`,
      403,
    );
  }

  const base = {
    status: fr.status,
    currentOwnerId: fr.currentOwnerId,
    resubmitToStatus: fr.resubmitToStatus,
    assignedDeveloperId: fr.assignedDeveloperId,
    revision: fr.revision,
    closedAt: null as "now" | null,
  };
  let patch = { ...base };
  let kind: CommentKind;
  let note: string | null = null;
  let targetUserId: string | null = null;

  switch (input.action) {
    case "approve": {
      note = clean(input.note) || null;
      kind = "approval";
      if (fr.status === "pending_product_review") {
        patch = { ...patch, status: "pending_tech_review", currentOwnerId: ownerForStage("pending_tech_review", dir) };
      } else {
        patch = { ...patch, status: "ready_for_assignment", currentOwnerId: actor.userId };
      }
      patch.resubmitToStatus = null;
      break;
    }
    case "request_changes": {
      note = clean(input.reason);
      if (!note) throw new WorkflowError("Explain what needs to change.", 400);
      kind = "changes_requested";
      let owner = fr.createdBy;
      if (fr.status === "pending_tech_review" && input.target === "product_reviewer") {
        owner = ownerForStage("pending_product_review", dir);
      } else if (fr.status === "pending_product_review" && input.target === "product_reviewer") {
        throw new WorkflowError("The Product Head can only send a request back to the CEO.", 400);
      }
      patch = { ...patch, status: "changes_requested", currentOwnerId: owner, resubmitToStatus: fr.status };
      targetUserId = owner;
      break;
    }
    case "reject": {
      note = clean(input.reason);
      if (!note) throw new WorkflowError("A rejection needs a reason.", 400);
      kind = "rejection";
      patch = { ...patch, status: "rejected", currentOwnerId: fr.createdBy, resubmitToStatus: null };
      targetUserId = fr.createdBy;
      break;
    }
    case "resubmit": {
      note = clean(input.note) || null;
      kind = "resubmission";
      const stage: Status = fr.resubmitToStatus ?? "pending_product_review";
      patch = { ...patch, status: stage, currentOwnerId: ownerForStage(stage, dir), resubmitToStatus: null };
      break;
    }
    case "reopen": {
      note = clean(input.reason);
      if (!note) throw new WorkflowError("Say what changed before reopening.", 400);
      kind = "reopen";
      patch = {
        ...patch,
        status: "pending_product_review",
        currentOwnerId: ownerForStage("pending_product_review", dir),
        resubmitToStatus: null,
        revision: fr.revision + 1,
      };
      break;
    }
    case "assign": {
      note = clean(input.note) || null;
      if (!dir.developerIds.includes(input.developerId)) {
        throw new WorkflowError("Pick an active developer.", 400);
      }
      kind = "assignment";
      patch = { ...patch, status: "assigned", currentOwnerId: input.developerId, assignedDeveloperId: input.developerId };
      targetUserId = input.developerId;
      break;
    }
    case "set_status": {
      note = clean(input.note) || null;
      if (!devNextStatuses(fr.status).includes(input.toStatus)) {
        throw new WorkflowError(
          `A request can't move from ${STATUS_LABELS[fr.status]} to ${STATUS_LABELS[input.toStatus] ?? input.toStatus}.`,
          400,
        );
      }
      kind = "status_change";
      patch = { ...patch, status: input.toStatus, closedAt: input.toStatus === "closed" ? "now" : null };
      break;
    }
  }

  const notify = new Set<string>();
  if (patch.currentOwnerId) notify.add(patch.currentOwnerId);
  notify.add(fr.createdBy);
  notify.delete(actor.userId);

  return {
    patch,
    event: { action: input.action, fromStatus: fr.status, toStatus: patch.status, targetUserId, note },
    comment: { kind, body: note ?? "" },
    notifyUserIds: [...notify],
  };
}
