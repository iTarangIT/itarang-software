/**
 * Approval hashes (doc §6.1, R7). Approve stores the hashes of the template,
 * invite note and attachment; the send ticker recomputes them from what it is
 * about to send and refuses on any mismatch. Pure apart from node:crypto.
 */
import { createHash } from "node:crypto";

export const NO_ATTACHMENT = "none";

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export type ApprovalHashes = { template_hash: string; note_hash: string; attachment_hash: string };

export function approvalHashes(args: {
  template: string;
  inviteNote: string | null | undefined;
  attachmentSha256: string | null | undefined;
}): ApprovalHashes {
  return {
    template_hash: sha256(args.template),
    note_hash: sha256(args.inviteNote ?? ""),
    attachment_hash: args.attachmentSha256 || NO_ATTACHMENT,
  };
}

export type ApprovalCheck = { ok: true } | { ok: false; reason: string };

/**
 * The send-time gate. `approval` is the live (unvoided) li_approvals row or
 * null; `current` is what is about to be sent; `frozen` / `fresh` are the
 * prospect's stored rendered text and a re-render of the current template.
 */
export function checkApproval(args: {
  approval: (ApprovalHashes & { voided_at?: Date | string | null }) | null;
  current: ApprovalHashes;
  frozen?: string | null;
  fresh?: string | null;
}): ApprovalCheck {
  const { approval, current } = args;
  if (!approval) return { ok: false, reason: "no approval record" };
  if (approval.voided_at) return { ok: false, reason: "approval voided" };
  if (approval.template_hash !== current.template_hash) return { ok: false, reason: "message text changed after approval" };
  if (approval.note_hash !== current.note_hash) return { ok: false, reason: "invite note changed after approval" };
  if (approval.attachment_hash !== current.attachment_hash) return { ok: false, reason: "attachment changed after approval" };
  if (args.frozen !== undefined && args.fresh !== undefined && (args.frozen ?? "") !== (args.fresh ?? "")) {
    return { ok: false, reason: "rendered message does not match the approved template" };
  }
  return { ok: true };
}
