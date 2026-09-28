import "server-only";

import { requireAnalystUser } from "@/lib/analyst/access";
import { agentJson } from "@/lib/analyst/client";
import { errorResponse } from "@/lib/analyst/errors";
import { ownThreads } from "@/lib/analyst/threads";
import type { Thread } from "@/lib/analyst/types";

export const dynamic = "force-dynamic";

/** The caller's own conversations, newest first, for the thread column. */
export async function GET() {
  try {
    const user = await requireAnalystUser();
    return Response.json(ownThreads(user, await agentJson<Thread[]>("/runs/threads?limit=200")));
  } catch (error) {
    return errorResponse(error, "could not load your conversations");
  }
}
