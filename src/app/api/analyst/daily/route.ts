import "server-only";

// 251 item 23 — "Email me this every morning" (E-385).
//
//   GET                  the caller's morning questions
//   POST   { run_id }    start mailing that answer's question (re-read from the agent's run)
//   DELETE ?id=adq_…     stop one of the caller's own
//
// The mail itself is the analyst_daily digest (src/lib/digests/kinds/analyst-daily.ts).

import { z } from "zod";

import { ownsThread, requireAnalystUser } from "@/lib/analyst/access";
import { agentJson } from "@/lib/analyst/client";
import { addDaily, DAILY_QUESTIONS_MAX, hasDailyTable, listDaily, stopDaily } from "@/lib/analyst/dailyStore";
import { errorResponse } from "@/lib/analyst/errors";
import { stripMetricRules } from "@/lib/analyst/metricRules";
import type { RunDetail } from "@/lib/analyst/types";

export const dynamic = "force-dynamic";

const noTable = () =>
  Response.json(
    { error: "morning emails are not set up on this server yet (migration E-385)", code: "not_configured" },
    { status: 503 },
  );

const AddBody = z.object({ run_id: z.string().min(1).max(64) });

export async function GET() {
  try {
    const user = await requireAnalystUser();
    if (!(await hasDailyTable())) return Response.json({ enabled: false, items: [], max: DAILY_QUESTIONS_MAX });
    return Response.json({ enabled: true, items: await listDaily(user.id), max: DAILY_QUESTIONS_MAX });
  } catch (error) {
    return errorResponse(error, "could not load your morning questions");
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireAnalystUser();
    const parsed = AddBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "that answer could not be added", code: "invalid_request" }, { status: 422 });
    }
    if (!(await hasDailyTable())) return noTable();

    // The question is always re-read from the run, never taken from the browser.
    const detail = await agentJson<RunDetail>(`/runs/${encodeURIComponent(parsed.data.run_id)}`);
    if (!ownsThread(user, detail.thread_id)) {
      return Response.json({ error: "run not found", code: "not_found" }, { status: 404 });
    }
    if (detail.status !== "done") {
      return Response.json(
        { error: "only an answered question can be emailed each morning", code: "invalid_request" },
        { status: 422 },
      );
    }
    const result = await addDaily({
      userId: user.id,
      connectionId: detail.connection_id,
      question: stripMetricRules(detail.question),
      sourceRunId: detail.id,
    });
    if (!result.ok) {
      return Response.json(
        {
          error: `you already get ${DAILY_QUESTIONS_MAX} questions every morning — stop one first`,
          code: "limit",
        },
        { status: 409 },
      );
    }
    return Response.json({ ok: true, item: result.item, already: result.already });
  } catch (error) {
    return errorResponse(error, "could not add that question");
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireAnalystUser();
    if (!(await hasDailyTable())) return noTable();
    const id = new URL(request.url).searchParams.get("id") ?? "";
    if (!/^adq_[0-9a-f]{32}$/.test(id)) {
      return Response.json({ error: "that question was not found", code: "not_found" }, { status: 404 });
    }
    const stopped = await stopDaily(id, user.id);
    if (!stopped) return Response.json({ error: "that question was not found", code: "not_found" }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error, "could not stop that question");
  }
}
