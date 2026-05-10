/**
 * Pure logic for the audit-log preview endpoint, factored out of route.ts so
 * it can be unit-tested without booting Supabase / Drizzle.
 *
 * BRD ref: Section 6.4.2 — Audit Log Entry Preview discloses exactly seven
 * fields (timestamp, IMEI, action, reason, requested_by, approver,
 * borrower_notice_record). The shape returned by `composeWillLog` MUST stay
 * 1:1 with the audit_logs writer once that lands.
 */
import { z } from "zod";

export const PreviewRequestSchema = z.object({
  entity_type: z.string().min(1),
  entity_id: z.string().min(1),
  action: z.string().min(1),
  reason_code: z.string().min(1),
  imei: z.string().optional(),
  borrower_notice_id: z.string().optional(),
  approver_user_id: z.string().uuid().optional(),
});

export type PreviewRequest = z.infer<typeof PreviewRequestSchema>;

export interface WillLog {
  timestamp: string;
  imei: string | null;
  action: string;
  reason: string;
  requested_by: { user_id: string; display_name: string };
  approver: { user_id: string | null; display_name: string | null };
  borrower_notice_record: { id: string | null; channel: string | null };
}

export interface SessionLike {
  id: string;
  email: string | null;
}

export interface ComposeDeps {
  session: SessionLike | null;
  /** Returns the display name (or null) for an existing users.id. */
  lookupUserDisplayName: (userId: string) => Promise<string | null>;
  /** Returns the channel for a borrower notice (or null when table absent). */
  lookupBorrowerNoticeChannel: (noticeId: string) => Promise<string | null>;
  /** Allows tests to pin the preview timestamp. Defaults to `new Date()`. */
  now?: () => Date;
}

export async function composeWillLog(
  body: PreviewRequest,
  deps: ComposeDeps,
): Promise<WillLog> {
  const { session, lookupUserDisplayName, lookupBorrowerNoticeChannel, now } = deps;

  const requestedBy = session
    ? {
        user_id: session.id,
        display_name:
          (await lookupUserDisplayName(session.id)) ?? session.email ?? "unknown",
      }
    : { user_id: "dev", display_name: "dev (no session)" };

  let approver: WillLog["approver"] = { user_id: null, display_name: null };
  if (body.approver_user_id) {
    const name = await lookupUserDisplayName(body.approver_user_id);
    approver = { user_id: body.approver_user_id, display_name: name };
  }

  const borrowerNoticeRecord: WillLog["borrower_notice_record"] = body.borrower_notice_id
    ? {
        id: body.borrower_notice_id,
        channel: await lookupBorrowerNoticeChannel(body.borrower_notice_id),
      }
    : { id: null, channel: null };

  const ts = (now ? now() : new Date()).toISOString();

  return {
    timestamp: ts,
    imei: body.imei ?? null,
    action: body.action,
    reason: body.reason_code,
    requested_by: requestedBy,
    approver,
    borrower_notice_record: borrowerNoticeRecord,
  };
}
