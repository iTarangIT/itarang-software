import "server-only";

import { z } from "zod";

import { ownsThread, requireAnalystUser } from "@/lib/analyst/access";
import { agentFetch, agentJson } from "@/lib/analyst/client";
import { errorResponse, normalizeAgentError } from "@/lib/analyst/errors";
import { ANALYST_QUESTION_MAX, stripMetricRules, withMetricRules } from "@/lib/analyst/metricRules";
import { canAskSource, CRM_SOURCE_NAME, crmDsnIsMasked } from "@/lib/analyst/sources-routes";
import type { Connection, RunPage } from "@/lib/analyst/types";

export const dynamic = "force-dynamic";
// A run takes up to ~40s on the agent and it allows 180s (RUN_TIMEOUT_S). The handler must
// outlive the run, which is also why this only works on a long-lived Node process (PM2), not a
// short-lived serverless function that would cut the stream mid-answer.
export const maxDuration = 180;

const RunBody = z.object({
  connection_id: z.string().min(1).max(100),
  thread_id: z.string().min(1).max(100),
  // ID 32: capped so the CRM metric rules always ride with it (metricRules.ts).
  question: z
    .string()
    .trim()
    .min(3)
    .max(ANALYST_QUESTION_MAX, `Questions can be up to ${ANALYST_QUESTION_MAX} characters — please shorten it.`),
});

const encoder = new TextEncoder();

// ID 167 — the source list, cached briefly: the agent sleeps on its free tier and a run should
// not wait on a second round-trip each time. A source only ever moves from allowed to deleted.
const SOURCES_TTL_MS = 5 * 60_000;
let sourcesCache: { at: number; byId: Map<string, Connection> } | null = null;

async function sourceById(id: string): Promise<Connection | undefined> {
  if (!sourcesCache || Date.now() - sourcesCache.at > SOURCES_TTL_MS || !sourcesCache.byId.has(id)) {
    const list = await agentJson<Connection[]>("/connections");
    sourcesCache = { at: Date.now(), byId: new Map(list.map((c) => [c.id, c])) };
  }
  return sourcesCache.byId.get(id);
}

function streamHeaders(): HeadersInit {
  // Built fresh rather than copied from upstream: its hop-by-hop headers must not be forwarded.
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    // nginx on the VPS buffers proxied responses by default, which would hold the whole answer
    // back until the run ends. This turns that off for this response.
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff",
    connection: "keep-alive",
  };
}

/**
 * Ask the analyst a question, streaming its Server-Sent Events back to the browser.
 *
 * Bytes are forwarded exactly as they arrive: re-framing here would corrupt a multi-byte
 * character (₹, an em dash) split across a chunk boundary.
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireAnalystUser();
  } catch (error) {
    return errorResponse(error, "could not check your access");
  }

  const parsed = RunBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    // ID 32: say so when it is only too long, so the user can shorten it.
    const tooLong = parsed.error.issues.find((i) => i.code === "too_big" && i.path[0] === "question");
    return Response.json(
      { error: tooLong ? tooLong.message : "that question could not be sent", code: "invalid_request" },
      { status: 422 },
    );
  }
  if (!ownsThread(user, parsed.data.thread_id)) {
    return Response.json({ error: "that conversation is not yours", code: "forbidden" }, { status: 403 });
  }

  // ID 167: an outside database bypasses the read-only role's withheld columns — never asked.
  // Fail closed (18 Oct): a source the agent does not list is refused too, not let through.
  try {
    const source = await sourceById(parsed.data.connection_id);
    if (!canAskSource(source)) {
      return Response.json(
        {
          error: source
            ? "outside databases are switched off — ask the iTarang database or an uploaded file"
            : "that data source was not found — pick the iTarang database or an uploaded file",
          code: "forbidden",
        },
        { status: 403 },
      );
    }
    // ID 167 (23 Oct): the saved iTarang source is only asked while this server's DSN is the
    // masked login — until then its answers would carry raw names and notes.
    if (source?.name === CRM_SOURCE_NAME && !crmDsnIsMasked(process.env.ANALYST_CRM_READONLY_DSN)) {
      return Response.json(
        {
          error: "the iTarang database is switched off on this server until personal data is masked — ask an uploaded file",
          code: "forbidden",
        },
        { status: 403 },
      );
    }
  } catch (error) {
    return errorResponse(error, "could not check that data source");
  }

  let upstream: Response;
  try {
    upstream = await agentFetch("/runs", {
      method: "POST",
      // ID 32 — the agreed metric rules travel with the question.
      body: { ...parsed.data, question: withMetricRules(parsed.data.question) },
      accept: "text/event-stream",
      // Covers the wait before headers arrive; the stream's own cancel covers the rest.
      signal: request.signal,
      timeoutMs: null,
    });
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    return errorResponse(error, "could not reach the analyst service");
  }

  // Anything that fails before the stream opens (unknown connection, spent budget, rate limit)
  // is a real HTTP status with a JSON body, re-sent as such rather than as an SSE error event.
  if (!upstream.ok || !upstream.body) {
    return errorResponse(await normalizeAgentError(upstream), "that question could not be run");
  }

  const body = upstream.body;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Next flushes headers only with the first chunk, so without this the browser's fetch
      // would not settle until the agent's first event. A valid SSE comment; the reader skips it.
      controller.enqueue(encoder.encode(": open\n\n"));
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
    cancel(reason) {
      // The browser went away (Stop, or navigated off): tear the upstream run down too.
      body.cancel(reason).catch(() => {});
    },
  });

  return new Response(stream, { status: 200, headers: streamHeaders() });
}

/** Past runs of one of the caller's own threads, newest first. */
export async function GET(request: Request) {
  try {
    const user = await requireAnalystUser();
    const threadId = new URL(request.url).searchParams.get("thread_id");
    if (!ownsThread(user, threadId)) {
      return Response.json({ error: "that conversation is not yours", code: "forbidden" }, { status: 403 });
    }
    const page = await agentJson<RunPage>(
      `/runs?limit=50&thread_id=${encodeURIComponent(threadId!)}`,
    );
    return Response.json({
      ...page,
      items: page.items.map((r) => ({ ...r, question: stripMetricRules(r.question) })),
    });
  } catch (error) {
    return errorResponse(error, "could not load that conversation");
  }
}
