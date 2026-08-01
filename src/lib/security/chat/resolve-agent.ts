/**
 * The per-finding resolution-chat agent. A human discusses ONE security finding
 * with an assistant that has read the actual affected source file; when they
 * agree on a fix, the assistant emits a machine-readable PROPOSED_FIX block
 * describing an exact search/replace edit. The Resolve step applies it.
 *
 * Reuses the scanner's ChatOpenAI model (gpt-4o-mini) to keep the security
 * namespace self-contained. If OPENAI_API_KEY is absent, returns a templated
 * remediation message (no proposed fix) so the UI still works.
 */
import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { LocatedSource } from "../resolve/locate";

export const FIX_START = "===PROPOSED_FIX_START===";
export const FIX_END = "===PROPOSED_FIX_END===";

export interface FindingContext {
  title: string;
  severity: string;
  category: string;
  summary: string;
  target_url: string;
  http_method: string | null;
  reproduction: string | null;
  remediation: string | null;
  evidence_json: unknown;
  owasp_ref: string | null;
  cwe_ref: string | null;
}

export interface ChatTurn {
  role: "user" | "assistant" | "system";
  message: string;
}

export interface ProposedFix {
  file: string;
  search: string;
  replace: string;
  explanation: string;
}

export interface ResolveTurnResult {
  reply: string;
  proposedFix: ProposedFix | null;
  model: string;
}

function makeModel(): ChatOpenAI | null {
  if (!process.env.OPENAI_API_KEY) return null;
  return new ChatOpenAI({
    openAIApiKey: process.env.OPENAI_API_KEY,
    modelName: process.env.SECURITY_OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.1,
  });
}

const MODEL_NAME = process.env.SECURITY_OPENAI_MODEL || "gpt-4o-mini";

function systemPrompt(finding: FindingContext, source: LocatedSource | null): string {
  const evidence = (() => {
    try {
      return JSON.stringify(finding.evidence_json ?? {}, null, 2);
    } catch {
      return "{}";
    }
  })();

  const sourceBlock = source
    ? `The affected source file is \`${source.repoRelPath}\`${source.truncated ? " (truncated)" : ""}:
\`\`\`
${source.content}
\`\`\``
    : `The affected source file could NOT be located on disk. Give best-practice guidance and, if you propose a fix, describe it in prose — do NOT emit a PROPOSED_FIX block (there is no verified file to patch).`;

  return `You are a senior application-security engineer helping fix ONE vulnerability in the iTarang CRM, a Next.js 16 (App Router) + Drizzle ORM + Supabase Auth codebase. Middleware treats /api/* as public, so each API route must authorize itself.

Be concise, concrete, and honest. Explain the risk in plain language when asked, and propose a fix that matches the ACTUAL code shown below — reuse existing helpers where they exist (e.g. requireLeadAccess in src/lib/auth/requireLeadAccess.ts, requireSalesHead, getAuthenticatedAppUser).

THE FINDING
- Title: ${finding.title}
- Severity: ${finding.severity} · Category: ${finding.category}
- Target: ${finding.http_method ?? ""} ${finding.target_url}
- Summary: ${finding.summary}
- Reproduction: ${finding.reproduction ?? "n/a"}
- Suggested remediation: ${finding.remediation ?? "n/a"}
- OWASP: ${finding.owasp_ref ?? "n/a"} · CWE: ${finding.cwe_ref ?? "n/a"}
- Evidence: ${evidence}

${sourceBlock}

WHEN THE USER IS READY TO APPLY A FIX (they say so, or ask you to proceed), append a machine-readable block to your reply, delimited EXACTLY by a line "${FIX_START}" and a line "${FIX_END}", containing a single JSON object with keys:
  "file"        — the exact path shown above (${source ? source.repoRelPath : "n/a"})
  "search"      — an EXACT snippet copied verbatim from the source above, unique in the file, large enough to be unambiguous
  "replace"     — the full replacement for that snippet, implementing the fix
  "explanation" — one sentence on what changed and why it closes the finding
Rules for the block: valid JSON only (properly escape newlines/quotes); "search" must appear exactly once in the file; keep the edit minimal and self-contained; do not reformat unrelated code. Only include the block when you are actually proposing an applyable edit — omit it while still discussing.`;
}

function parseProposedFix(reply: string): { visible: string; fix: ProposedFix | null } {
  const start = reply.indexOf(FIX_START);
  const end = reply.indexOf(FIX_END);
  if (start === -1 || end === -1 || end < start) return { visible: reply, fix: null };

  const jsonText = reply.slice(start + FIX_START.length, end).trim();
  const visible = (reply.slice(0, start) + reply.slice(end + FIX_END.length)).trim();

  try {
    const raw = JSON.parse(jsonText) as Partial<ProposedFix>;
    if (
      typeof raw.file === "string" &&
      typeof raw.search === "string" &&
      typeof raw.replace === "string" &&
      raw.search.length > 0 &&
      raw.search !== raw.replace
    ) {
      return {
        visible,
        fix: {
          file: raw.file,
          search: raw.search,
          replace: raw.replace,
          explanation: typeof raw.explanation === "string" ? raw.explanation : "",
        },
      };
    }
  } catch {
    // Malformed block — keep the prose, drop the fix.
  }
  return { visible: visible || reply, fix: null };
}

function fallbackReply(finding: FindingContext): string {
  const rem = finding.remediation?.trim();
  return `AI resolution chat is not configured (no OPENAI_API_KEY set), so I can't read the source or draft an auto-apply patch.

Based on the finding, here is the remediation direction:
${rem ? `- ${rem}` : `- Add an authorization/validation check at the entry of \`${finding.target_url}\` before any data is read or written.`}

A developer can apply this by hand and then mark the finding resolved. Set OPENAI_API_KEY to enable the interactive fix + auto-apply flow.`;
}

export async function runResolveTurn(input: {
  finding: FindingContext;
  source: LocatedSource | null;
  history: ChatTurn[];
  userMessage: string;
}): Promise<ResolveTurnResult> {
  const model = makeModel();
  if (!model) {
    return { reply: fallbackReply(input.finding), proposedFix: null, model: "none" };
  }

  const messages = [
    new SystemMessage(systemPrompt(input.finding, input.source)),
    ...input.history.map((t) =>
      t.role === "assistant" ? new AIMessage(t.message) : new HumanMessage(t.message),
    ),
    new HumanMessage(input.userMessage),
  ];

  const res = await model.invoke(messages);
  const text = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
  const { visible, fix } = parseProposedFix(text);
  return { reply: visible, proposedFix: fix, model: MODEL_NAME };
}
