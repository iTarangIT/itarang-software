"use client";

// Tracker ID 199 — a manager's "Team member" pick on My Visits, the Inside
// Sales queue and the Leads list: My whole team (default) / Me / each direct
// report. Sent as ?member= (the API ignores anyone outside the team). Shown
// only to someone with people reporting to them; the team's leads stay
// read-only (the lead page gates every action on ownership).

import { MEMBER_ME, MEMBER_TEAM } from "@/lib/users/teamRules";

export type TeamPerson = { id: string; name: string };

export function TeamMemberFilter({
    people,
    value,
    onChange,
}: {
    /** The viewer's direct reports. Empty = not a manager = nothing rendered. */
    people: readonly TeamPerson[];
    /** "" or "team" = whole team, "me", or a report's id. */
    value: string;
    onChange: (member: string) => void;
}) {
    if (people.length === 0) return null;
    return (
        <label className="flex items-center gap-2 text-sm text-gray-700">
            <span className="font-medium">Team member</span>
            <select
                value={value || MEMBER_TEAM}
                onChange={(e) => onChange(e.target.value === MEMBER_TEAM ? "" : e.target.value)}
                className="h-9 min-w-[11rem] rounded-md border border-gray-300 bg-white px-2 text-sm"
                aria-label="Whose leads to show"
            >
                <option value={MEMBER_TEAM}>My whole team</option>
                <option value={MEMBER_ME}>Me</option>
                {people.map((p) => (
                    <option key={p.id} value={p.id}>
                        {p.name}
                    </option>
                ))}
            </select>
        </label>
    );
}
