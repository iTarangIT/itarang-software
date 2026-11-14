import "server-only";

// AI Analyst — a whole conversation read back from the agent (oldest first, answers and SQL
// included), for Download (E-381) and the read-only shared view.

import { agentJson } from "./client";
import { cleanRun } from "./metricRules";
import type { RunDetail, RunPage } from "./types";
import { hasVerifiedTable, verifiedForSql } from "./verifiedStore";

export type TranscriptRun = RunDetail & { verified: boolean };

/** The thread's runs, oldest first, with their answers. At most 50 (the agent's page). */
export async function loadTranscript(threadId: string): Promise<TranscriptRun[]> {
  const page = await agentJson<RunPage>(`/runs?limit=50&thread_id=${encodeURIComponent(threadId)}`);
  const ids = [...page.items].reverse().map((r) => r.id);
  const details: RunDetail[] = [];
  // Four at a time: a long conversation should not open fifty connections to the agent at once.
  for (let i = 0; i < ids.length; i += 4) {
    const batch = await Promise.all(
      ids.slice(i, i + 4).map((id) => agentJson<RunDetail>(`/runs/${encodeURIComponent(id)}`).catch(() => null)),
    );
    for (const d of batch) if (d && d.thread_id === threadId) details.push(cleanRun(d));
  }
  const checkVerified = await hasVerifiedTable().catch(() => false);
  return Promise.all(
    details.map(async (d) => ({
      ...d,
      verified: checkVerified ? Boolean(await verifiedForSql(d.connection_id, d.sql).catch(() => null)) : false,
    })),
  );
}
