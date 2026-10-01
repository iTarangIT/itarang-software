import "server-only";

// Data Analyst — the analyst's data sources, proxied to the agent's /connections API.
//
// One handler for every source call (list, connect a Postgres database, upload files, Google
// Sheets/Drive, choose tables, sync, delete). What may pass is decided by the allowlist in
// src/lib/analyst/sources-routes.ts: reads are open to every analyst user, changes only to a
// source manager (ceo/admin), because sources are shared by the whole CRM.
//
// Uploads are streamed through untouched — the multipart boundary is in the content-type, so
// the header travels with the bytes and nothing is buffered in this process.

import { requireAnalystManager, requireAnalystUser } from "@/lib/analyst/access";
import { agentFetch } from "@/lib/analyst/client";
import { AnalystError, errorResponse, normalizeAgentError } from "@/lib/analyst/errors";
import {
  CreateConnectionBody,
  forwardQuery,
  matchSourceRoute,
  MAX_UPLOAD_REQUEST_BYTES,
  type SourceRoute,
} from "@/lib/analyst/sources-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A Postgres connect lists every table and an upload is converted before the agent answers.
export const maxDuration = 180;

type Ctx = { params: Promise<{ path?: string[] }> };

/** The JSON the agent receives. Only the create call is reshaped; the rest pass as validated. */
function agentBody(route: SourceRoute, data: unknown): unknown {
  if (route.schema !== CreateConnectionBody) return data;
  const body = data as { preset: "crm"; name?: string } | { name: string; dsn: string };
  if ("preset" in body) {
    // The CRM's own database, through a read-only role. The DSN stays on this server.
    const dsn = process.env.ANALYST_CRM_READONLY_DSN?.trim();
    if (!dsn) {
      throw new AnalystError(
        "the iTarang database is not set up for the analyst on this server (ANALYST_CRM_READONLY_DSN is missing)",
        503,
        "not_configured",
      );
    }
    return { name: body.name ?? "iTarang CRM", kind: "postgres", secret: { dsn } };
  }
  return { name: body.name, kind: "postgres", secret: { dsn: body.dsn } };
}

async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { path = [] } = await ctx.params;
  const route = matchSourceRoute(request.method, path);
  if (!route) {
    return Response.json({ error: "not found", code: "not_found" }, { status: 404 });
  }

  try {
    await (route.manage ? requireAnalystManager() : requireAnalystUser());

    const target = route.agentPath + forwardQuery(route, new URL(request.url).searchParams);
    let upstream: Response;

    if (route.body === "multipart") {
      const contentType = request.headers.get("content-type") ?? "";
      const length = request.headers.get("content-length");
      if (!contentType.startsWith("multipart/form-data") || !request.body) {
        return Response.json({ error: "send the files as a form upload", code: "invalid_request" }, { status: 422 });
      }
      // Checked before a byte is read: an unbounded upload must not reach the agent.
      if (!length) {
        return Response.json({ error: "the upload size is unknown", code: "invalid_request" }, { status: 411 });
      }
      if (Number(length) > MAX_UPLOAD_REQUEST_BYTES) {
        return Response.json(
          { error: "that upload is too large — at most 20 files of 25 MB each", code: "invalid_request" },
          { status: 413 },
        );
      }
      upstream = await agentFetch(target, {
        method: "POST",
        raw: { stream: request.body, contentType, length },
        signal: request.signal,
        timeoutMs: route.timeoutMs,
      });
    } else if (route.body === "json") {
      const parsed = route.schema!.safeParse(await request.json().catch(() => null));
      if (!parsed.success) {
        const message = parsed.error.issues[0]?.message ?? "that request was not valid";
        return Response.json({ error: message, code: "invalid_request" }, { status: 422 });
      }
      upstream = await agentFetch(target, {
        method: request.method as "POST" | "PUT",
        body: agentBody(route, parsed.data),
        signal: request.signal,
        timeoutMs: route.timeoutMs,
      });
    } else {
      upstream = await agentFetch(target, {
        method: request.method as "GET" | "POST" | "DELETE",
        signal: request.signal,
        timeoutMs: route.timeoutMs,
      });
    }

    if (!upstream.ok) throw await normalizeAgentError(upstream);
    if (upstream.status === 204) return new Response(null, { status: 204 });
    return Response.json(await upstream.json(), { status: upstream.status });
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    if (!(error instanceof AnalystError)) console.error("[analyst] source call failed:", request.method, path, error);
    return errorResponse(error, "the analyst could not complete that");
  }
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
