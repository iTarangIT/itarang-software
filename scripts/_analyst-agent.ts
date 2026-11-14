// Scripts' own way to the AI Analyst agent. src/lib/analyst/client.ts is server-only and will not
// load outside Next, so this signs in the same way (the ANALYST_* service account) and offers a
// JSON GET and a streamed ask. Used by verify-analyst-golden.ts and _list-analyst-questions.ts.

import { createSseFrameDecoder } from "../src/lib/analyst/sse-frame";

const NEED = ["ANALYST_API_URL", "ANALYST_SUPABASE_URL", "ANALYST_SUPABASE_KEY", "ANALYST_SERVICE_EMAIL", "ANALYST_SERVICE_PASSWORD"];

export function analystEnvMissing(): string[] {
  return NEED.filter((k) => !process.env[k]?.trim());
}

let token: string | null = null;

async function bearer(): Promise<string> {
  if (token) return token;
  const supabase = process.env.ANALYST_SUPABASE_URL!.trim().replace(/\/+$/, "");
  const login = await fetch(`${supabase}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: process.env.ANALYST_SUPABASE_KEY!.trim(), "content-type": "application/json" },
    body: JSON.stringify({ email: process.env.ANALYST_SERVICE_EMAIL!.trim(), password: process.env.ANALYST_SERVICE_PASSWORD }),
  });
  const session = (await login.json()) as { access_token?: string; error_description?: string };
  if (!login.ok || !session.access_token) throw new Error(`service sign-in failed: ${session.error_description ?? login.status}`);
  token = session.access_token;
  return token;
}

function api(path: string): string {
  return `${process.env.ANALYST_API_URL!.trim().replace(/\/+$/, "")}${path}`;
}

export async function agentGet<T>(path: string): Promise<T> {
  const response = await fetch(api(path), { headers: { authorization: `Bearer ${await bearer()}`, accept: "application/json" } });
  if (!response.ok) throw new Error(`GET ${path}: ${response.status} ${await response.text().catch(() => "")}`.slice(0, 300));
  return (await response.json()) as T;
}

export type AskOutcome = {
  runId: string | null;
  sql: string | null;
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
  answer: string;
  error: string | null;
  ms: number;
};

/** Ask one question and read its whole SSE stream. */
export async function agentAsk(input: {
  connectionId: string;
  threadId: string;
  question: string;
  instructions?: string;
  timeoutMs?: number;
}): Promise<AskOutcome> {
  const started = Date.now();
  const out: AskOutcome = { runId: null, sql: null, columns: [], rows: [], truncated: false, answer: "", error: null, ms: 0 };
  const response = await fetch(api("/runs"), {
    method: "POST",
    headers: { authorization: `Bearer ${await bearer()}`, accept: "text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({
      connection_id: input.connectionId,
      thread_id: input.threadId,
      question: input.question,
      instructions: input.instructions || undefined,
    }),
    signal: AbortSignal.timeout(input.timeoutMs ?? 240_000),
  });
  if (!response.ok || !response.body) {
    out.error = `HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 300)}`;
    out.ms = Date.now() - started;
    return out;
  }
  const reader = response.body.getReader();
  const decoder = createSseFrameDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const frame of decoder.push(value)) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(frame.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (frame.event === "sql") out.sql = String(data.sql ?? "");
      else if (frame.event === "rows") {
        out.columns = (data.columns as string[]) ?? [];
        out.rows = (data.rows as unknown[][]) ?? [];
        out.truncated = Boolean(data.truncated);
      } else if (frame.event === "token") out.answer += String(data.text ?? "");
      else if (frame.event === "done") out.runId = String(data.run_id ?? "") || null;
      else if (frame.event === "error") out.error = String(data.message ?? "agent error");
    }
  }
  out.ms = Date.now() - started;
  return out;
}
