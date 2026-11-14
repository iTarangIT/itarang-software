import "server-only";

// E-381 — download one of the caller's conversations as Markdown (questions, answers, the SQL
// behind each, in IST). Results are never stored by the agent, so tables are not included.

import { ownsThread, requireAnalystUser } from "@/lib/analyst/access";
import { errorResponse } from "@/lib/analyst/errors";
import { exportFileName, threadToMarkdown } from "@/lib/analyst/exportThread";
import { hasThreadTable, threadMeta } from "@/lib/analyst/threadStore";
import { loadTranscript } from "@/lib/analyst/transcript";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(_request: Request, context: { params: Promise<{ threadId: string }> }) {
  try {
    const user = await requireAnalystUser();
    const { threadId } = await context.params;
    if (!ownsThread(user, threadId)) {
      return Response.json({ error: "conversation not found", code: "not_found" }, { status: 404 });
    }
    const runs = await loadTranscript(threadId);
    if (runs.length === 0) {
      return Response.json({ error: "this conversation has no questions yet", code: "not_found" }, { status: 404 });
    }
    const meta = (await hasThreadTable().catch(() => false)) ? await threadMeta(user.id, threadId).catch(() => null) : null;
    const title = meta?.title || runs[0].question;
    const body = threadToMarkdown({ title, runs });
    return new Response(body, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${exportFileName(title)}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(error, "could not export that conversation");
  }
}
