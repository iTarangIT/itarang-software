/**
 * EMI Messages digest (tracker ID 204) — every morning, one line per lender
 * for the day before: EMI messages sent, delivered and failed, and how many
 * EMIs were paid within 3 days of their first message (over the messages
 * sent 3 days earlier, the last day whose window has closed).
 *
 * Ships OFF, like the other new digests: switch it on and pick recipients on
 * its settings screen. The messages themselves are set up at
 * Admin > Settings > EMI messages (src/lib/emi-messages).
 */

import type { DigestDetail, DigestFigures, DigestKindDescriptor, DigestSection, DigestTable } from "../types";

const SECTIONS: DigestSection[] = [
  { key: "sent", label: "Messages sent", hint: "EMI messages that went out that day, all lenders.", group: "activity" },
  { key: "lenders", label: "Per lender", hint: "Sent, delivered, failed, and paid within 3 days.", group: "backlog" },
];

async function collect(istDay: string): Promise<{ ok: boolean; figures: DigestFigures; error?: string }> {
  try {
    const { emiMessagesDailyLines } = await import("@/lib/emi-messages/run");
    const lines = await emiMessagesDailyLines(istDay);
    const table: DigestTable = {
      key: "lenders",
      title: "EMI messages per lender",
      columns: ["Lender", "Sent", "Delivered", "Failed", "Paid within 3 days", "EMIs messaged 3 days before"],
      rows: lines.map((l) => [l.lender, l.sent, l.delivered, l.failed, l.paid_within_3d, l.messaged_3d_ago]),
      empty: "No EMI messages that day.",
    };
    return {
      ok: true,
      figures: {
        activity: [{ key: "sent", label: "EMI messages sent", value: lines.reduce((n, l) => n + l.sent, 0) }],
        backlog: [],
        tables: [table],
      },
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[digest:emi_messages] build failed:", error);
    return { ok: false, figures: { activity: [], backlog: [] }, error };
  }
}

async function collectDetail(): Promise<{ ok: boolean; detail: DigestDetail; error?: string }> {
  return { ok: true, detail: {} };
}

export const emiMessagesDigest: DigestKindDescriptor = {
  id: "emi_messages",
  label: "EMI Messages Daily",
  description:
    "One mail every morning with a line per lender for the day before: EMI messages to customers sent, " +
    "delivered and failed, and how many EMIs were paid within 3 days of their first message.",
  settingsKey: "emi_messages_digest",
  settingsHref: "/admin/settings/emi-messages-daily",
  ctaHref: "/admin/settings/emi-messages",
  ctaLabel: "Open EMI messages",
  sections: SECTIONS,
  slots: ["morning"],
  defaults: { enabled: false, recipients: [] },
  subject: () => "iTarang EMI Messages — daily",
  collect,
  collectDetail,
};
