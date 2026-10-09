import "server-only";

import { requireAnalystUser } from "@/lib/analyst/access";
import { agentJson } from "@/lib/analyst/client";
import { errorResponse } from "@/lib/analyst/errors";
import { stripMetricRules } from "@/lib/analyst/metricRules";
import { ownThreads } from "@/lib/analyst/threads";
import type { Thread } from "@/lib/analyst/types";

export const dynamic = "force-dynamic";

/** The caller's own conversations, newest first, for the thread column. */
export async function GET() {
  try {
    const user = await requireAnalystUser();
    const threads = ownThreads(user, await agentJson<Thread[]>("/runs/threads?limit=200"));
    // ID 32 — a title cut from a first question can still carry the rules' tail.
    return Response.json(threads.map((t) => ({ ...t, title: stripMetricRules(t.title) })));
  } catch (error) {
    return errorResponse(error, "could not load your conversations");
  }
}
