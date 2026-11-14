import "server-only";

// Data Analyst — the server half of /ceo/analyst and /sales-head/analyst. Reads the caller's
// data sources, conversation list and (when continuing one) its history straight from the
// agent, then hands the ask screen everything it needs in one render.

import { randomUUID } from "node:crypto";

import {
  canManageSources,
  canReviewFeedback,
  canVerifyQueries,
  newThreadId,
  ownsThread,
  requireAnalystUser,
} from "@/lib/analyst/access";
import { agentJson, analystConfigured } from "@/lib/analyst/client";
import { AnalystError } from "@/lib/analyst/errors";
import { cleanRun } from "@/lib/analyst/metricRules";
import { crmDsnIsMasked } from "@/lib/analyst/sources-routes";
import { personalStarters } from "@/lib/analyst/starters";
import type { ListThread } from "@/lib/analyst/threadList";
import { hasThreadTable, ownThreadList, recentQuestions, threadMeta } from "@/lib/analyst/threadStore";
import type { Connection, RunPage, Thread } from "@/lib/analyst/types";
import { hasVerifiedTable } from "@/lib/analyst/verifiedStore";

import { AnalystWorkspace } from "./AnalystWorkspace";

export async function AnalystPage({
  basePath,
  searchParams,
}: {
  basePath: string;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const empty = {
    basePath,
    threadId: randomUUID(),
    connections: [] as Connection[],
    history: [],
    threads: [] as ListThread[],
    starters: personalStarters([]),
    unreachable: false,
  };

  let user;
  try {
    user = await requireAnalystUser();
  } catch (error) {
    if (error instanceof AnalystError) return <AnalystWorkspace {...empty} problem={error.message} />;
    throw error; // NEXT_REDIRECT to /login, among others
  }

  if (!analystConfigured()) {
    return (
      <AnalystWorkspace
        {...empty}
        problem="It is not configured on this server yet (the ANALYST_* environment settings are missing)."
      />
    );
  }

  const { thread } = await searchParams;
  // E-381: the CRM's own conversation settings; a missing table only hides those controls.
  const threadsEnabled = await hasThreadTable().catch(() => false);
  const verifiedEnabled = await hasVerifiedTable().catch(() => false);
  const requested = typeof thread === "string" && ownsThread(user, thread) ? thread : null;
  const meta = requested && threadsEnabled ? await threadMeta(user.id, requested).catch(() => null) : null;
  // A deleted conversation opened from an old link starts a new one instead.
  const continuing = requested !== null && !meta?.deleted_at;
  const threadId = continuing ? requested : newThreadId(user);

  // No /health pre-flight: the agent runs always-on, so the loads go straight out in parallel and
  // an unreachable agent shows up as their failure instead of costing every page a round-trip.
  let loaded: [Connection[], RunPage, Thread[]];
  try {
    loaded = await Promise.all([
      agentJson<Connection[]>("/connections"),
      continuing
        ? agentJson<RunPage>(`/runs?limit=50&thread_id=${encodeURIComponent(threadId)}`)
        : Promise.resolve<RunPage>({ items: [], next_cursor: null }),
      agentJson<Thread[]>("/runs/threads?limit=200").catch(() => [] as Thread[]),
    ]);
  } catch (error) {
    if (error instanceof AnalystError && error.code === "upstream" && error.status >= 502 && error.status <= 504) {
      return <AnalystWorkspace {...empty} threadId={threadId} unreachable problem={null} />;
    }
    console.error("[analyst] page load failed:", error);
    const message = error instanceof AnalystError ? error.message : "the analyst service returned an unexpected error";
    return <AnalystWorkspace {...empty} threadId={threadId} problem={message} />;
  }
  const [connections, history, agentThreads] = loaded;
  const threads = await ownThreadList(user, agentThreads);
  // Item 12 — starter questions from what this user asks most, then the usual ones.
  const asked = threadsEnabled
    ? await recentQuestions(user.id).catch(() => [] as string[])
    : threads.map((t) => t.title);
  const current = threads.find((t) => t.thread_id === threadId) ?? null;

  return (
    <AnalystWorkspace
      // Keyed on the thread, so opening another conversation starts from a clean transcript.
      key={threadId}
      basePath={basePath}
      threadId={threadId}
      connections={connections}
      // The agent returns newest first; a transcript reads oldest first. Runs asked before 13 Nov
      // stored the CRM metric rules inside the question (and so the title): both are cleaned
      // here, or a reopened conversation shows them and "Ask again" re-sends them.
      history={[...history.items].reverse().map(cleanRun)}
      threads={threads}
      starters={personalStarters(asked)}
      current={
        current
          ? { title: current.title, pinned: current.pinned, archived: current.archived, shared: current.shared }
          : null
      }
      threadsEnabled={threadsEnabled}
      verifiedEnabled={verifiedEnabled}
      canVerify={verifiedEnabled && canVerifyQueries(user.role)}
      unreachable={false}
      problem={null}
      canManage={canManageSources(user.role)}
      canReview={canReviewFeedback(user.role)}
      crmMasked={crmDsnIsMasked(process.env.ANALYST_CRM_READONLY_DSN)}
    />
  );
}
