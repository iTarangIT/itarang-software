/**
 * Prospect state machine for a campaign row (doc §6.2). Every state change in
 * the module goes through nextState(); a transition it does not allow is a bug
 * and is refused (returns null), never written.
 *
 *   selected → approved → queued
 *      ├─ connected      → message_sent → seen → replied
 *      └─ not connected  → invite_sent → accepted → message_sent → seen → replied
 *   Side exits: invite_expired · failed · stopped
 *
 * A reply at any live point ends automatic sending (→ replied).
 */

export const PROSPECT_STATES = [
  "selected",
  "approved",
  "queued",
  "invite_sent",
  "accepted",
  "message_sent",
  "seen",
  "replied",
  "invite_expired",
  "failed",
  "stopped",
] as const;
export type ProspectState = (typeof PROSPECT_STATES)[number];

export type ProspectEvent =
  | "approve"
  | "void" // approval voided (template / attachment edited)
  | "enqueue"
  | "invite_sent"
  | "accepted"
  | "message_sent"
  | "seen"
  | "replied"
  | "expire"
  | "fail"
  | "stop";

export const TERMINAL_STATES: ReadonlySet<ProspectState> = new Set([
  "replied",
  "invite_expired",
  "failed",
  "stopped",
]);

/** States in which the prospect is "live" in a campaign (one live campaign per prospect). */
export const LIVE_STATES: readonly ProspectState[] = [
  "approved",
  "queued",
  "invite_sent",
  "accepted",
  "message_sent",
  "seen",
];

/** States the send ticker acts on. */
export const SENDABLE_STATES: readonly ProspectState[] = ["queued", "accepted"];

const TABLE: Partial<Record<ProspectState, Partial<Record<ProspectEvent, ProspectState>>>> = {
  selected: { approve: "approved", stop: "stopped" },
  approved: { enqueue: "queued", void: "selected", stop: "stopped", fail: "failed" },
  queued: {
    invite_sent: "invite_sent",
    message_sent: "message_sent",
    void: "selected",
    replied: "replied",
    fail: "failed",
    stop: "stopped",
  },
  invite_sent: { accepted: "accepted", expire: "invite_expired", replied: "replied", fail: "failed", stop: "stopped" },
  accepted: { message_sent: "message_sent", replied: "replied", fail: "failed", stop: "stopped" },
  message_sent: { seen: "seen", replied: "replied", stop: "stopped" },
  seen: { replied: "replied", stop: "stopped" },
};

export function nextState(current: ProspectState, event: ProspectEvent): ProspectState | null {
  return TABLE[current]?.[event] ?? null;
}

export function isProspectState(s: string): s is ProspectState {
  return (PROSPECT_STATES as readonly string[]).includes(s);
}

/** UI wording (R4): "Sent", never "Delivered". */
export const STATE_LABEL: Record<ProspectState, string> = {
  selected: "Selected",
  approved: "Approved",
  queued: "Queued",
  invite_sent: "Invite sent",
  accepted: "Accepted",
  message_sent: "Sent",
  seen: "Seen",
  replied: "Replied",
  invite_expired: "Invite expired",
  failed: "Failed",
  stopped: "Stopped",
};
