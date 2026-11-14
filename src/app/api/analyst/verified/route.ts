import "server-only";

// E-382 — verified AI Analyst queries.
//
//   GET                           the active verified queries (any analyst user)
//   POST   { run_id, note? }      mark that run's SQL verified (CEO / Sales Head / admin)
//   DELETE ?id=avq_…              take a verification back (same roles)
//
// The SQL is always re-read from the agent's run, never taken from the browser.

import { z } from "zod";

import { canVerifyQueries, ownsThread, requireAnalystUser } from "@/lib/analyst/access";
import { agentJson } from "@/lib/analyst/client";
import { errorResponse } from "@/lib/analyst/errors";
import { stripMetricRules } from "@/lib/analyst/metricRules";
import type { RunDetail } from "@/lib/analyst/types";
import { hasVerifiedTable, listVerified, unverifyQuery, verifyQuery } from "@/lib/analyst/verifiedStore";

export const dynamic = "force-dynamic";

const noTable = () =>
  Response.json(
    { error: "verified queries are not set up on this server yet (migration E-382)", code: "not_configured" },
    { status: 503 },
  );
const forbidden = () =>
  Response.json(
    { error: "only the CEO, Sales Head or an admin can verify queries", code: "forbidden" },
    { status: 403 },
  );

const VerifyBody = z.object({
  run_id: z.string().min(1).max(64),
  note: z.string().trim().max(1000).optional().nullable(),
});

export async function GET() {
  try {
    await requireAnalystUser();
    if (!(await hasVerifiedTable())) return Response.json({ enabled: false, items: [] });
    return Response.json({ enabled: true, items: await listVerified() });
  } catch (error) {
    return errorResponse(error, "could not load the verified queries");
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireAnalystUser();
    if (!canVerifyQueries(user.role)) return forbidden();
    const parsed = VerifyBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "that run could not be verified", code: "invalid_request" }, { status: 422 });
    }
    if (!(await hasVerifiedTable())) return noTable();

    const detail = await agentJson<RunDetail>(`/runs/${encodeURIComponent(parsed.data.run_id)}`);
    if (!ownsThread(user, detail.thread_id)) {
      return Response.json({ error: "run not found", code: "not_found" }, { status: 404 });
    }
    if (detail.status !== "done" || !detail.sql?.trim()) {
      return Response.json(
        { error: "only an answered question with a query can be verified", code: "invalid_request" },
        { status: 422 },
      );
    }
    const id = await verifyQuery({
      connectionId: detail.connection_id,
      question: stripMetricRules(detail.question),
      sql: detail.sql,
      sourceRunId: detail.id,
      userId: user.id,
      note: parsed.data.note || null,
    });
    return Response.json({ ok: true, verified: { id, question: stripMetricRules(detail.question) } });
  } catch (error) {
    return errorResponse(error, "could not verify that query");
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireAnalystUser();
    if (!canVerifyQueries(user.role)) return forbidden();
    const id = new URL(request.url).searchParams.get("id");
    if (!id || !/^avq_[0-9a-f]{32}$/.test(id)) {
      return Response.json({ error: "verified query not found", code: "not_found" }, { status: 404 });
    }
    if (!(await hasVerifiedTable())) return noTable();
    const ok = await unverifyQuery(id);
    return ok
      ? Response.json({ ok: true })
      : Response.json({ error: "verified query not found", code: "not_found" }, { status: 404 });
  } catch (error) {
    return errorResponse(error, "could not remove that verification");
  }
}
