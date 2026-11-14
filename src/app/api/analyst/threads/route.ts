import "server-only";

import { requireAnalystUser } from "@/lib/analyst/access";
import { agentJson } from "@/lib/analyst/client";
import { errorResponse } from "@/lib/analyst/errors";
import { ownThreadList } from "@/lib/analyst/threadStore";
import type { Thread } from "@/lib/analyst/types";

export const dynamic = "force-dynamic";

/**
 * The caller's own conversations (active and archived), pinned first, then newest. Only the
 * caller's: the agent's tenant-wide list is cut to their thread prefix, and E-381's rows are
 * read by their user id. ID 32 — titles are cleaned of the old rules' tail.
 */
export async function GET() {
  try {
    const user = await requireAnalystUser();
    const agent = await agentJson<Thread[]>("/runs/threads?limit=200");
    return Response.json(await ownThreadList(user, agent));
  } catch (error) {
    return errorResponse(error, "could not load your conversations");
  }
}
