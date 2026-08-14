// "sent by <name> [ROLE]" — who handed a lead to its current owner.
//
// Extracted from the /leads oversight table so the rep and ASM queues can show
// the SAME stamp. That was the whole point of the complaint it fixes: a lead the
// CEO sent to Nidhi was stamped on the CEO's own screen and nowhere on Nidhi's,
// so the one person who needed to know who sent it was the one person who
// couldn't see it.
//
// Client-safe: the only import from @/lib is TYPE-ONLY. leadAssignedBy.ts pulls
// in `db`, so a value import here would drag the postgres driver into every
// bundle that renders a queue.

import type { LeadAssignedBy } from "@/lib/leads/leadAssignedBy";

function pretty(value: string | null | undefined): string {
    if (!value) return "—";
    return value.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Sender-role label for the stamp. Initials for the long titles, because the
// token sits inside a table cell that already carries a name — "Sales Manager"
// spelled out wraps the row and buries the two labels that matter, CEO and
// Admin. The full title is in the stamp's tooltip either way.
function senderRole(role: string): string {
    const r = role.toLowerCase();
    if (r === "ceo") return "CEO";
    if (r === "admin") return "Admin";
    if (r === "asm") return "ASM";
    return role
        .split("_")
        .map((w) => w[0]?.toUpperCase() ?? "")
        .join("");
}

function fmtDate(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
        ? iso
        : d.toLocaleDateString("en-IN", {
              timeZone: "Asia/Kolkata",
              day: "2-digit",
              month: "short",
              year: "numeric",
          });
}

type Props = {
    assignedBy: LeadAssignedBy | null | undefined;
    /** Current owner of the lead — used to suppress self-claims. */
    currentOwnerId: string | null | undefined;
};

/**
 * Renders nothing when there is no hand-off to report.
 *
 * ⚠ SUPPRESSED WHEN SENDER === OWNER. A rep claiming a lead off the Unassigned
 * queue was not SENT it by anyone, and "sent by Nidhi" on Nidhi's own lead
 * states the opposite of what happened. `lead_claimed` is already excluded
 * server-side (see leadAssignedBy.ts); this also covers an admin who assigns a
 * lead to themselves.
 */
export function SentByStamp({ assignedBy, currentOwnerId }: Props) {
    if (!assignedBy) return null;
    if (currentOwnerId && assignedBy.id === currentOwnerId) return null;

    return (
        <div
            className="mt-1 flex items-center gap-1 text-[10px] leading-none text-gray-500"
            title={`Assigned by ${assignedBy.name ?? "a user"}${
                assignedBy.role ? ` (${pretty(assignedBy.role)})` : ""
            }${assignedBy.at ? ` on ${fmtDate(assignedBy.at)}` : ""}`}
        >
            <span className="text-gray-400">sent by</span>
            <span className="truncate font-medium text-gray-600">
                {assignedBy.name ?? "—"}
            </span>
            {assignedBy.role && (
                <span className="shrink-0 rounded border border-gray-200 bg-white px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-gray-500">
                    {senderRole(assignedBy.role)}
                </span>
            )}
        </div>
    );
}
