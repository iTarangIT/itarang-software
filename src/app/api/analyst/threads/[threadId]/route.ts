import "server-only";

// E-381 — one of the caller's AI Analyst conversations.
//
//   PATCH  { title?, pinned?, archived? }     rename / pin / archive
//   DELETE                                    delete from the list (soft: nothing is removed)
//   POST   { action: "restore" | "share" | "unshare" }

import { z } from "zod";

import { ownsThread, requireAnalystUser, type AnalystUser } from "@/lib/analyst/access";
import { agentJson } from "@/lib/analyst/client";
import { errorResponse } from "@/lib/analyst/errors";
import { stripMetricRules } from "@/lib/analyst/metricRules";
import {
  ensureShareToken,
  ensureThreadRow,
  hasThreadTable,
  patchThread,
  restoreThread,
  revokeShare,
  softDeleteThread,
} from "@/lib/analyst/threadStore";
import type { Thread } from "@/lib/analyst/types";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ threadId: string }> };

const PatchBody = z
  .object({
    title: z.string().max(500).optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .refine((b) => b.title !== undefined || b.pinned !== undefined || b.archived !== undefined, "nothing to change");

const ActionBody = z.object({ action: z.enum(["restore", "share", "unshare"]) });

const noTable = () =>
  Response.json(
    { error: "conversation settings are not set up on this server yet (migration E-381)", code: "not_configured" },
    { status: 503 },
  );
const notFound = () => Response.json({ error: "conversation not found", code: "not_found" }, { status: 404 });

async function threadOf(user: AnalystUser, context: Context): Promise<string | null> {
  const { threadId } = await context.params;
  const id = decodeURIComponent(threadId);
  return ownsThread(user, id) ? id : null;
}

/**
 * Run `change`; when the CRM has no row for the thread yet (asked before E-381), make one from
 * the agent's record and try once more.
 */
async function withRow<T>(user: AnalystUser, threadId: string, change: () => Promise<T | false | null>): Promise<T | false | null> {
  const first = await change();
  if (first) return first;
  const agent = await agentJson<Thread[]>("/runs/threads?limit=200");
  const thread = agent.find((t) => t.thread_id === threadId);
  if (!thread) return first;
  await ensureThreadRow({
    userId: user.id,
    threadId,
    title: stripMetricRules(thread.title),
    connectionId: thread.connection_id || null,
    runCount: thread.run_count,
    lastAskedAt: thread.last_run_at || null,
  });
  return change();
}

export async function PATCH(request: Request, context: Context) {
  try {
    const user = await requireAnalystUser();
    const threadId = await threadOf(user, context);
    if (!threadId) return notFound();
    const parsed = PatchBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "that change could not be saved", code: "invalid_request" }, { status: 422 });
    }
    if (!(await hasThreadTable())) return noTable();
    const ok = await withRow(user, threadId, () => patchThread(user.id, threadId, parsed.data));
    return ok ? Response.json({ ok: true }) : notFound();
  } catch (error) {
    return errorResponse(error, "could not save that change");
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const user = await requireAnalystUser();
    const threadId = await threadOf(user, context);
    if (!threadId) return notFound();
    if (!(await hasThreadTable())) return noTable();
    const ok = await withRow(user, threadId, () => softDeleteThread(user.id, threadId));
    return ok ? Response.json({ ok: true }) : notFound();
  } catch (error) {
    return errorResponse(error, "could not delete that conversation");
  }
}

export async function POST(request: Request, context: Context) {
  try {
    const user = await requireAnalystUser();
    const threadId = await threadOf(user, context);
    if (!threadId) return notFound();
    const parsed = ActionBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "unknown action", code: "invalid_request" }, { status: 422 });
    }
    if (!(await hasThreadTable())) return noTable();

    switch (parsed.data.action) {
      case "restore": {
        const ok = await restoreThread(user.id, threadId);
        return ok ? Response.json({ ok: true }) : notFound();
      }
      case "share": {
        const token = await withRow(user, threadId, () => ensureShareToken(user.id, threadId));
        if (!token) return notFound();
        return Response.json({ ok: true, token, path: `/analyst/shared/${token}` });
      }
      case "unshare": {
        const ok = await revokeShare(user.id, threadId);
        return ok ? Response.json({ ok: true }) : notFound();
      }
    }
  } catch (error) {
    return errorResponse(error, "could not do that");
  }
}
