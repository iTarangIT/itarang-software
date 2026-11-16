import "server-only";

// 251 item 23 — ask the AI Analyst one question on the server and read the whole answer, for
// the morning email (no browser on the other end). Same rules as a question asked on screen
// (api/analyst/runs): only an allowed source, the iTarang database only while this server's
// DSN is the masked login, the metric rules and any verified queries in `instructions`.
//
// The run goes on its own thread ("crm.daily.<id>.<day>"), outside the person's prefix, so the
// morning answers do not fill their conversation list.

import { agentFetch, agentJson } from "./client";
import { AGENT_INSTRUCTIONS_MAX, metricInstructions } from "./metricRules";
import { canAskSource, CRM_SOURCE_NAME, crmDsnIsMasked } from "./sources-routes";
import { createSseFrameDecoder } from "./sse-frame";
import type { Connection } from "./types";
import { joinInstructions, type VerifiedMatch } from "./verified";
import { hasVerifiedTable, matchVerified } from "./verifiedStore";

export type AskedOnce = {
    answer: string;
    columns: string[];
    rows: unknown[][];
    truncated: boolean;
    runId: string | null;
    error: string | null;
};

/** Ask once and wait for the whole answer (the agent allows a run 180 s). */
export async function askOnce(input: {
    connectionId: string;
    threadId: string;
    question: string;
    timeoutMs?: number;
}): Promise<AskedOnce> {
    const out: AskedOnce = { answer: "", columns: [], rows: [], truncated: false, runId: null, error: null };

    const sources = await agentJson<Connection[]>("/connections");
    const source = sources.find((c) => c.id === input.connectionId);
    if (!canAskSource(source)) {
        out.error = source ? "outside databases are switched off" : "that data source no longer exists";
        return out;
    }
    if (source?.name === CRM_SOURCE_NAME && !crmDsnIsMasked(process.env.ANALYST_CRM_READONLY_DSN)) {
        out.error = "the iTarang database is switched off on this server until personal data is masked";
        return out;
    }

    let verified: VerifiedMatch[] = [];
    try {
        if (await hasVerifiedTable()) verified = await matchVerified(input.connectionId, input.question);
    } catch {
        // Verified queries only help; a failure here never stops the question.
    }
    const instructions = joinInstructions(metricInstructions(input.question), verified, AGENT_INSTRUCTIONS_MAX);

    const response = await agentFetch("/runs", {
        method: "POST",
        body: {
            connection_id: input.connectionId,
            thread_id: input.threadId,
            question: input.question,
            instructions: instructions || undefined,
        },
        accept: "text/event-stream",
        timeoutMs: input.timeoutMs ?? 200_000,
    });
    if (!response.ok || !response.body) {
        out.error = `the analyst refused the question (HTTP ${response.status})`;
        return out;
    }

    const reader = response.body.getReader();
    const decoder = createSseFrameDecoder();
    try {
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
                if (frame.event === "rows") {
                    out.columns = Array.isArray(data.columns) ? (data.columns as string[]) : [];
                    out.rows = Array.isArray(data.rows) ? (data.rows as unknown[][]) : [];
                    out.truncated = Boolean(data.truncated);
                } else if (frame.event === "token") out.answer += String(data.text ?? "");
                else if (frame.event === "done") out.runId = String(data.run_id ?? "") || null;
                else if (frame.event === "error") out.error = String(data.message ?? "the analyst could not answer");
            }
        }
    } finally {
        reader.releaseLock();
    }
    if (!out.error && !out.answer.trim() && out.rows.length === 0) out.error = "the analyst returned no answer";
    return out;
}
