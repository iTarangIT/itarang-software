// Campaign KPIs (R4 + E-398). Pure.

export type KpiRow = {
  invite_sent_at: Date | null;
  accepted_at: Date | null;
  message_sent_at: Date | null;
  replied_at: Date | null;
  /** E-398: the Sales Head marked "meeting scheduled" for this row. */
  meeting?: boolean;
};

/**
 * Funnel for the Sales Head: Approached → Accepted → Replied → Meeting.
 * "Approached" = we reached out at all: an invite, or a direct message to an
 * existing connection (who never needed an invite). Acceptance % is over
 * invites only, since a direct message has nothing to accept.
 * "Seen" is never a KPI.
 */
export function kpis(rows: KpiRow[], positiveReplies: number) {
  const approached = rows.filter((r) => r.invite_sent_at || r.message_sent_at).length;
  const invited = rows.filter((r) => r.invite_sent_at).length;
  const accepted = rows.filter((r) => r.invite_sent_at && r.accepted_at).length;
  const messaged = rows.filter((r) => r.message_sent_at).length;
  const replied = rows.filter((r) => r.replied_at).length;
  const meetings = rows.filter((r) => r.meeting).length;
  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
  return {
    approached,
    invited,
    accepted,
    messaged,
    replied,
    meetings,
    positive: positiveReplies,
    acceptance_pct: pct(accepted, invited),
    reply_pct: pct(replied, messaged),
    positive_reply_pct: pct(positiveReplies, replied),
    meeting_pct: pct(meetings, approached),
  };
}
