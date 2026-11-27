/**
 * Suggested replies for the inbox (doc §9). A draft is only ever shown to the
 * admin; pressing Send is the approval (doc §6.1). Also classifies the latest
 * inbound message's sentiment for the "positive reply %" KPI.
 */
import { askJson } from "./llm";

export type ThreadLine = { fromMe: boolean; text: string | null; at: Date };

const SYSTEM = `You help the Sales Head of iTarang Technologies (lithium-ion batteries, EV battery finance, dealer network in India) reply to LinkedIn messages.
Given the prospect's profile and the conversation, return ONLY JSON:
{"draft":"the reply, 1-4 short sentences, plain text, no emojis, no sign-off","sentiment":"positive|neutral|negative","meeting":true|false}
"sentiment" describes the prospect's LATEST message: positive = interested / wants a call or details; negative = not interested / asks to stop.
"meeting" is true ONLY when both sides have agreed a call or meeting (a day, a time, or "call me tomorrow" accepted); asking "can we talk?" alone is false.
Never promise prices, discounts or dates. If they asked to stop, the draft is a one-line polite acknowledgement.`;

/** Validate a model answer. Pure; exported for tests. */
export function parseDraft(
  raw: unknown,
): { draft: string; sentiment: "positive" | "neutral" | "negative" | null; meeting: boolean } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const draft = typeof r.draft === "string" ? r.draft.trim() : "";
  if (!draft) return null;
  const s = String(r.sentiment ?? "").toLowerCase();
  const sentiment = s === "positive" || s === "neutral" || s === "negative" ? s : null;
  return { draft: draft.slice(0, 2000), sentiment, meeting: r.meeting === true || r.meeting === "true" };
}

export async function draftReply(args: {
  prospect: { full_name: string | null; headline: string | null; company: string | null };
  thread: ThreadLine[];
}) {
  const raw = await askJson(
    SYSTEM,
    JSON.stringify({
      prospect: args.prospect,
      conversation: args.thread.slice(-20).map((m) => ({
        from: m.fromMe ? "us" : "prospect",
        text: m.text ?? "",
        at: m.at.toISOString(),
      })),
    }),
  );
  return parseDraft(raw);
}
