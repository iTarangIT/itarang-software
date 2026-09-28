import "server-only";

import { z } from "zod";

import { ownsThread, requireAnalystUser } from "@/lib/analyst/access";
import { agentFetch, agentJson } from "@/lib/analyst/client";
import { errorResponse, normalizeAgentError } from "@/lib/analyst/errors";
import type { RunPage } from "@/lib/analyst/types";

export const dynamic = "force-dynamic";
// A run takes up to ~40s on the agent and it allows 180s (RUN_TIMEOUT_S). The handler must
// outlive the run, which is also why this only works on a long-lived Node process (PM2), not a
// short-lived serverless function that would cut the stream mid-answer.
export const maxDuration = 180;

const RunBody = z.object({
  connection_id: z.string().min(1).max(100),
  thread_id: z.string().min(1).max(100),
  question: z.string().trim().min(3).max(2000),
});

const encoder = new TextEncoder();

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
    return Response.json({ error: "that question could not be sent", code: "invalid_request" }, { status: 422 });
  }
  if (!ownsThread(user, parsed.data.thread_id)) {
    return Response.json({ error: "that conversation is not yours", code: "forbidden" }, { status: 403 });
  }

  let upstream: Response;
  try {
    upstream = await agentFetch("/runs", {
      method: "POST",
      body: parsed.data,
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
    return Response.json(page);
  } catch (error) {
    return errorResponse(error, "could not load that conversation");
  }
}
