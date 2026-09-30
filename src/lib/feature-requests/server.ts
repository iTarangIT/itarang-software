/**
 * Feature Request & Approval — server-side helpers shared by the API routes
 * (E-316). All authorization lives here: a caller acts through their SEAT in
 * feature_request_members, never through users.role.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";

import { requireAuth } from "@/lib/auth-utils";
import { db } from "@/lib/db";
import {
  featureRequestAttachments,
  featureRequestMembers,
  featureRequests,
  users,
} from "@/lib/db/schema";
import { notifyUser } from "@/lib/notifications/notify";

import {
  SEATS,
  STATUS_LABELS,
  type Actor,
  type Directory,
  type FrState,
  type Seat,
  type Status,
} from "./workflow";

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type SeatedUser = Awaited<ReturnType<typeof requireAuth>> & { seat: Seat };

/** The signed-in user plus their active seat; 403 for anyone without one. */
export async function requireSeat(allowed?: Seat[]): Promise<SeatedUser> {
  const user = await requireAuth();
  const [row] = await db
    .select({ seat: featureRequestMembers.seat })
    .from(featureRequestMembers)
    .where(and(eq(featureRequestMembers.user_id, user.id), eq(featureRequestMembers.is_active, true)))
    .limit(1);
  const seat = row?.seat as Seat | undefined;
  if (!seat || !SEATS.includes(seat)) {
    throw new HttpError("You don't have access to feature requests.", 403);
  }
  if (allowed && !allowed.includes(seat)) {
    throw new HttpError("Your role can't do that on feature requests.", 403);
  }
  return { ...user, seat };
}

export function actorOf(user: SeatedUser): Actor {
  return { userId: user.id, seat: user.seat };
}

export type Member = { id: string; name: string; email: string; seat: Seat };

/** Every active member, with names — used for the directory and for display. */
export async function loadMembers(): Promise<Member[]> {
  const rows = await db
    .select({
      id: featureRequestMembers.user_id,
      seat: featureRequestMembers.seat,
      name: users.name,
      email: users.email,
    })
    .from(featureRequestMembers)
    .innerJoin(users, eq(users.id, featureRequestMembers.user_id))
    .where(eq(featureRequestMembers.is_active, true));
  return rows.map((r) => ({ ...r, seat: r.seat as Seat }));
}

/** id → display name for any set of user ids (owners, authors, uploaders). */
export async function userNames(ids: (string | null | undefined)[]): Promise<Map<string, { name: string; role: string }>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, name: users.name, role: users.role })
    .from(users)
    .where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, { name: r.name, role: r.role }]));
}

export function directoryOf(members: Member[]): Directory {
  return {
    productReviewerId: members.find((m) => m.seat === "product_reviewer")?.id ?? null,
    techReviewerId: members.find((m) => m.seat === "tech_reviewer")?.id ?? null,
    developerIds: members.filter((m) => m.seat === "developer").map((m) => m.id),
  };
}

type FrRow = typeof featureRequests.$inferSelect;

export function stateOf(row: FrRow): FrState {
  return {
    status: row.status as Status,
    createdBy: row.created_by,
    currentOwnerId: row.current_owner_id,
    assignedDeveloperId: row.assigned_developer_id,
    resubmitToStatus: (row.resubmit_to_status as Status | null) ?? null,
    revision: row.revision,
  };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Attach previously uploaded files (see /api/feature-requests/uploads) to a
 * request and optionally a comment. Only the uploader's own, still-unclaimed
 * files can be claimed; anything else fails the whole call.
 */
export async function claimAttachments(
  tx: Tx,
  ids: string[],
  userId: string,
  featureRequestId: string,
  commentId: string | null,
): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const claimed = await tx
    .update(featureRequestAttachments)
    .set({ feature_request_id: featureRequestId, comment_id: commentId })
    .where(
      and(
        inArray(featureRequestAttachments.id, unique),
        eq(featureRequestAttachments.uploaded_by, userId),
        isNull(featureRequestAttachments.feature_request_id),
      ),
    )
    .returning({ id: featureRequestAttachments.id });
  if (claimed.length !== unique.length) {
    throw new HttpError("One of the attached files is no longer available. Remove it and upload it again.", 400);
  }
}

/** Best-effort in-app notifications; never fails the action. */
export async function notifyMembers(
  userIds: string[],
  fr: { id: string; code: string; title: string },
  headline: string,
  type: string,
): Promise<void> {
  await Promise.all(
    userIds.map(async (uid) => {
      try {
        await notifyUser(uid, {
          type: `feature_request.${type}`,
          title: `${fr.code}: ${headline}`,
          message: fr.title,
          data: { href: `/feature-requests/${fr.id}`, feature_request_id: fr.id },
        });
      } catch (e) {
        console.warn("[feature-requests] notify failed", e);
      }
    }),
  );
}

export function headlineFor(action: string, to: Status): string {
  switch (action) {
    case "approve":
      return `approved — now ${STATUS_LABELS[to]}`;
    case "request_changes":
      return "changes requested";
    case "reject":
      return "rejected";
    case "resubmit":
      return "resubmitted for review";
    case "reopen":
      return "reopened";
    case "assign":
      return "assigned for development";
    default:
      return `moved to ${STATUS_LABELS[to]}`;
  }
}

// ---- Uploads --------------------------------------------------------------

export const ATTACHMENT_BUCKET = "documents";
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const ALLOWED_EXTENSIONS = new Set([
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "csv",
  "ppt",
  "pptx",
  "txt",
  "md",
  "rtf",
  "odt",
  "ods",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "heic",
  "mp4",
  "mov",
  "webm",
  "zip",
  "rar",
  "7z",
]);

export function extensionOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : "";
}

export function assertAllowedFile(name: string, size: number): void {
  const ext = extensionOf(name);
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new HttpError(`".${ext || "?"}" files can't be attached. Zip it first if needed.`, 400);
  }
  if (size <= 0) throw new HttpError("The file is empty.", 400);
  if (size > MAX_ATTACHMENT_BYTES) {
    throw new HttpError(
      `The file is too large (${Math.round(size / 1024 / 1024)} MB). Maximum is ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`,
      400,
    );
  }
}

/** A storage-safe version of the original name (the DB keeps the original). */
export function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_+/g, "_").slice(-120) || "file";
}
