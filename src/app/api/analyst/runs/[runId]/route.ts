import "server-only";

import { ownsThread, requireAnalystUser } from "@/lib/analyst/access";
import { agentJson } from "@/lib/analyst/client";
import { errorResponse } from "@/lib/analyst/errors";
import { stripMetricRules } from "@/lib/analyst/metricRules";
import type { RunDetail } from "@/lib/analyst/types";

export const dynamic = "force-dynamic";

/** One saved run — its answer, SQL and trace — for replaying an earlier turn of a thread. */
export async function GET(_request: Request, context: { params: Promise<{ runId: string }> }) {
  try {
    const user = await requireAnalystUser();
    const { runId } = await context.params;
    const detail = await agentJson<RunDetail>(`/runs/${encodeURIComponent(runId)}`);
    // Every CRM user shares one agent tenant, so the agent would hand over anyone's run.
    // Answered as not-found rather than forbidden: whether the id exists is not yours to learn.
    if (!ownsThread(user, detail.thread_id)) {
      return Response.json({ error: "run not found", code: "not_found" }, { status: 404 });
    }
    return Response.json({ ...detail, question: stripMetricRules(detail.question) });
  } catch (error) {
    return errorResponse(error, "could not load that answer");
  }
}
