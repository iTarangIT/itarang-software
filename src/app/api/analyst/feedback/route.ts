import "server-only";

// E-380 — thumbs up / down on an AI Analyst answer, and the review queue's "mark reviewed".
//
//   GET   ?thread_id=…   the caller's own ratings on one of their conversations
//   POST  { run_id, thread_id, rating: "up"|"down"|null, comment? }   rate / re-rate / take back
//   PATCH { id, status: "reviewed"|"new", note? }   CEO / admin only

import { z } from "zod";

import { canReviewFeedback, ownsThread, requireAnalystUser } from "@/lib/analyst/access";
import { agentJson } from "@/lib/analyst/client";
import { errorResponse } from "@/lib/analyst/errors";
import {
  clearRating,
  hasFeedbackTable,
  ratingsForThread,
  saveRating,
  setReviewed,
} from "@/lib/analyst/feedbackStore";
import { stripMetricRules } from "@/lib/analyst/metricRules";
import type { RunDetail } from "@/lib/analyst/types";

export const dynamic = "force-dynamic";

// Built per request: a Response body can only be sent once.
const noTable = () =>
  Response.json(
    { error: "answer feedback is not set up on this server yet (migration E-380)", code: "not_configured" },
    { status: 503 },
  );

const RateBody = z.object({
  run_id: z.string().min(1).max(64),
  thread_id: z.string().min(1).max(100),
  rating: z.enum(["up", "down"]).nullable(),
  comment: z.string().trim().max(1000).optional().nullable(),
});

const ReviewBody = z.object({
  id: z.string().min(1).max(64),
  status: z.enum(["reviewed", "new"]),
  note: z.string().trim().max(1000).optional().nullable(),
});

export async function GET(request: Request) {
  try {
    const user = await requireAnalystUser();
    const threadId = new URL(request.url).searchParams.get("thread_id");
    if (!ownsThread(user, threadId)) {
      return Response.json({ error: "that conversation is not yours", code: "forbidden" }, { status: 403 });
    }
    if (!(await hasFeedbackTable())) return Response.json({ enabled: false, ratings: {} });
    return Response.json({ enabled: true, ratings: await ratingsForThread(user.id, threadId!) });
  } catch (error) {
    return errorResponse(error, "could not load your ratings");
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireAnalystUser();
    const parsed = RateBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "that rating could not be saved", code: "invalid_request" }, { status: 422 });
    }
    const { run_id, thread_id, rating } = parsed.data;
    if (!ownsThread(user, thread_id)) {
      return Response.json({ error: "that conversation is not yours", code: "forbidden" }, { status: 403 });
    }
    if (!(await hasFeedbackTable())) return noTable();

    if (rating === null) {
      await clearRating(run_id, user.id);
      return Response.json({ ok: true, rating: null });
    }

    // Every CRM user shares one agent tenant, so the run is checked to be on this thread, and
    // its question and answer are snapshotted for the reviewer from the agent, not the browser.
    const detail = await agentJson<RunDetail>(`/runs/${encodeURIComponent(run_id)}`);
    if (detail.thread_id !== thread_id) {
      return Response.json({ error: "run not found", code: "not_found" }, { status: 404 });
    }
    await saveRating({
      runId: run_id,
      threadId: thread_id,
      userId: user.id,
      rating,
      comment: parsed.data.comment || null,
      question: stripMetricRules(detail.question),
      answer: detail.answer ?? detail.error ?? null,
    });
    return Response.json({ ok: true, rating });
  } catch (error) {
    return errorResponse(error, "could not save that rating");
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await requireAnalystUser();
    if (!canReviewFeedback(user.role)) {
      return Response.json({ error: "only the CEO or an admin reviews answer feedback", code: "forbidden" }, { status: 403 });
    }
    const parsed = ReviewBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "that review could not be saved", code: "invalid_request" }, { status: 422 });
    }
    if (!(await hasFeedbackTable())) return noTable();
    const ok = await setReviewed({
      id: parsed.data.id,
      reviewerId: user.id,
      status: parsed.data.status,
      note: parsed.data.note || null,
    });
    if (!ok) return Response.json({ error: "feedback not found", code: "not_found" }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error, "could not save that review");
  }
}
