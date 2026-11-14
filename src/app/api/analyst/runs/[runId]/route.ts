import "server-only";

import { ownsThread, requireAnalystUser } from "@/lib/analyst/access";
import { agentJson } from "@/lib/analyst/client";
import { errorResponse } from "@/lib/analyst/errors";
import { cleanRun } from "@/lib/analyst/metricRules";
import { hasThreadTable, threadByShareToken } from "@/lib/analyst/threadStore";
import type { RunDetail } from "@/lib/analyst/types";
import { hasVerifiedTable, verifiedForSql, type VerifiedMark } from "@/lib/analyst/verifiedStore";

export const dynamic = "force-dynamic";

/**
 * One saved run — its answer, SQL and trace — for replaying an earlier turn of a thread.
 * `?share=<token>` (E-381) also opens a run of a conversation shared with the caller.
 * `verified` (E-382) is the verified query this run's SQL is, if any.
 */
export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  try {
    const user = await requireAnalystUser();
    const { runId } = await context.params;
    const detail = await agentJson<RunDetail>(`/runs/${encodeURIComponent(runId)}`);
    // Every CRM user shares one agent tenant, so the agent would hand over anyone's run.
    // Answered as not-found rather than forbidden: whether the id exists is not yours to learn.
    let allowed = ownsThread(user, detail.thread_id);
    if (!allowed) {
      const token = new URL(request.url).searchParams.get("share");
      if (token && (await hasThreadTable())) {
        const shared = await threadByShareToken(token);
        allowed = shared?.thread_id === detail.thread_id;
      }
    }
    if (!allowed) {
      return Response.json({ error: "run not found", code: "not_found" }, { status: 404 });
    }
    let verified: VerifiedMark | null = null;
    try {
      if (await hasVerifiedTable()) verified = await verifiedForSql(detail.connection_id, detail.sql);
    } catch (error) {
      console.error("[analyst] verified lookup failed:", error);
    }
    return Response.json({ ...cleanRun(detail), verified });
  } catch (error) {
    return errorResponse(error, "could not load that answer");
  }
}
