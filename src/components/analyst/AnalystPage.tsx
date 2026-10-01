import "server-only";

// Data Analyst — the server half of /ceo/analyst and /sales-head/analyst. Reads the caller's
// data sources, conversation list and (when continuing one) its history straight from the
// agent, then hands the ask screen everything it needs in one render.

import { randomUUID } from "node:crypto";

import { canManageSources, newThreadId, ownsThread, requireAnalystUser } from "@/lib/analyst/access";
import { agentAwake, agentJson, analystConfigured } from "@/lib/analyst/client";
import { AnalystError } from "@/lib/analyst/errors";
import { ownThreads } from "@/lib/analyst/threads";
import type { Connection, RunPage, Thread } from "@/lib/analyst/types";

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
    threads: [] as Thread[],
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
  const continuing = typeof thread === "string" && ownsThread(user, thread);
  const threadId = continuing ? thread : newThreadId(user);

  if (!(await agentAwake())) {
    return <AnalystWorkspace {...empty} threadId={threadId} unreachable problem={null} />;
  }

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
    console.error("[analyst] page load failed:", error);
    const message = error instanceof AnalystError ? error.message : "the analyst service returned an unexpected error";
    return <AnalystWorkspace {...empty} threadId={threadId} problem={message} />;
  }
  const [connections, history, threads] = loaded;

  return (
    <AnalystWorkspace
      // Keyed on the thread, so opening another conversation starts from a clean transcript.
      key={threadId}
      basePath={basePath}
      threadId={threadId}
      connections={connections}
      // The agent returns newest first; a transcript reads oldest first.
      history={[...history.items].reverse()}
      threads={ownThreads(user, threads)}
      unreachable={false}
      problem={null}
      canManage={canManageSources(user.role)}
    />
  );
}
