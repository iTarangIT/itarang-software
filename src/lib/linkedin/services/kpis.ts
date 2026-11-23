// Campaign KPIs (R4). Pure.

/** KPIs (R4): invite acceptance %, reply %, positive reply %. "Seen" is never a KPI. Pure. */
export function kpis(
  rows: { invite_sent_at: Date | null; accepted_at: Date | null; message_sent_at: Date | null; replied_at: Date | null }[],
  positiveReplies: number,
) {
  const invited = rows.filter((r) => r.invite_sent_at).length;
  const accepted = rows.filter((r) => r.invite_sent_at && r.accepted_at).length;
  const messaged = rows.filter((r) => r.message_sent_at).length;
  const replied = rows.filter((r) => r.replied_at).length;
  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
  return {
    invited,
    accepted,
    messaged,
    replied,
    positive: positiveReplies,
    acceptance_pct: pct(accepted, invited),
    reply_pct: pct(replied, messaged),
    positive_reply_pct: pct(positiveReplies, replied),
  };
}
