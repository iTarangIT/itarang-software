/**
 * The LLM for LinkedIn scoring and reply drafts — the CRM's EXISTING assistant
 * configuration (src/lib/assistant/config.ts): Gemini on WA_ASSIST_GEMINI_API_KEY,
 * OpenRouter (OPENROUTER_API_KEY) as the backup. No new keys.
 */
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";

import { assistantConfig } from "@/lib/assistant/config";

type Chat = { invoke(messages: unknown[], opts?: { signal?: AbortSignal }): Promise<{ content: unknown }> };

function models(): { name: string; chat: Chat }[] {
  const cfg = assistantConfig();
  const out: { name: string; chat: Chat }[] = [];
  if (cfg.apiKey) {
    out.push({
      name: cfg.model,
      chat: new ChatGoogleGenerativeAI({
        model: cfg.model,
        apiKey: cfg.apiKey,
        temperature: 0.2,
        maxRetries: 1,
        thinkingConfig: { thinkingLevel: "LOW" },
      } as ConstructorParameters<typeof ChatGoogleGenerativeAI>[0]) as unknown as Chat,
    });
  }
  if (cfg.openRouterApiKey) {
    out.push({
      name: cfg.backupModel,
      chat: new ChatOpenAI({
        model: cfg.backupModel,
        apiKey: cfg.openRouterApiKey,
        temperature: 0.2,
        maxRetries: 0,
        configuration: {
          baseURL: "https://openrouter.ai/api/v1",
          defaultHeaders: { "X-Title": "iTarang LinkedIn Outreach" },
        },
      }) as unknown as Chat,
    });
  }
  return out;
}

export function llmConfigured(): boolean {
  const cfg = assistantConfig();
  return !!(cfg.apiKey || cfg.openRouterApiKey);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === "string" ? p : ((p as { text?: string }).text ?? ""))).join("");
  }
  return "";
}

/** First JSON object / array in a model reply. Pure; exported for tests. */
export function extractJson(text: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.search(/[[{]/);
  if (start < 0) return null;
  const open = body[start];
  const close = open === "{" ? "}" : "]";
  const end = body.lastIndexOf(close);
  if (end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Ask for JSON; tries the primary then the backup model. null = no model or no parseable answer. */
export async function askJson(system: string, user: string, timeoutMs = 40_000): Promise<unknown | null> {
  for (const m of models()) {
    try {
      const res = await m.chat.invoke([new SystemMessage(system), new HumanMessage(user)], {
        signal: AbortSignal.timeout(timeoutMs),
      });
      const parsed = extractJson(textOf(res.content));
      if (parsed !== null) return parsed;
    } catch (err) {
      console.warn(`[linkedin:llm] ${m.name} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return null;
}

/** Plain text answer (reply drafts). */
export async function askText(system: string, user: string, timeoutMs = 40_000): Promise<string | null> {
  for (const m of models()) {
    try {
      const res = await m.chat.invoke([new SystemMessage(system), new HumanMessage(user)], {
        signal: AbortSignal.timeout(timeoutMs),
      });
      const t = textOf(res.content).trim();
      if (t) return t;
    } catch (err) {
      console.warn(`[linkedin:llm] ${m.name} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return null;
}
