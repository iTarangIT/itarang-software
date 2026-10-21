/**
 * A32 — a NeoDove call by an agent nobody has linked to a CRM user lands with
 * no performer: it counts on nobody's numbers and (until A33) moved no
 * interest. Tell Admin, once a day per agent per process, so the link is made
 * on /leads/neodove-campaigns/agents instead of the calls quietly piling up.
 *
 * Best-effort: never throws, never awaited by the caller; silent under vitest.
 */

const ONE_DAY = 24 * 60 * 60_000;
const lastAlerted = new Map<string, number>();

/** The agent key the alert dedupes on (case- and space-insensitive). */
export function agentAlertKey(agentName: string): string {
    return agentName.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Should this agent be alerted now? Pure apart from the in-memory clock. */
export function shouldAlertAgent(agentName: string | null | undefined, now = Date.now()): boolean {
    if (!agentName || !agentName.trim()) return false;
    const key = agentAlertKey(agentName);
    if (now - (lastAlerted.get(key) ?? 0) < ONE_DAY) return false;
    lastAlerted.set(key, now);
    return true;
}

export function alertUnmappedAgent(agentName: string | null | undefined, campaignName: string | null | undefined): void {
    if (process.env.NODE_ENV === "test") return;
    if (!shouldAlertAgent(agentName)) return;
    void import("@/lib/notifications/notify")
        .then(({ notifyRoles }) =>
            notifyRoles(["admin"], {
                type: "neodove.agent_unmapped",
                title: `NeoDove agent not linked: ${agentName!.trim()}`,
                message:
                    `Calls by "${agentName!.trim()}"${campaignName ? ` (campaign ${campaignName})` : ""} are arriving with no CRM user, ` +
                    "so they count on nobody's numbers. Link the agent on Leads › NeoDove campaigns › Agents — past calls move with it.",
                data: { agent: agentName!.trim(), campaign: campaignName ?? null, link: "/leads/neodove-campaigns/agents" },
            }),
        )
        .catch((e) => console.error("[neodove] could not alert admins:", e instanceof Error ? e.message : e));
}
