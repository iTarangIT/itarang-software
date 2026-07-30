/**
 * LangChain tools for the security agent, following the repo's tool() pattern
 * (src/lib/ai/langgraph/risk-tools.ts): a factory closes over the scan context
 * and each tool returns a truncated JSON string.
 *
 * The planner uses navigateAndInspect to look at pages (starting from dealer
 * onboarding) and decide which extra API paths are worth probing. Tools NEVER
 * decide severity — they only gather surface information.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { ProbeContext } from "../probe-context";
import { abs } from "../probe-context";
import { SEED_PAGES, SENSITIVE_UNAUTH_ROUTES, ADMIN_SURFACES } from "../crawl";

/** Fetch a page and extract title, links and form actions — no full DOM dump. */
export async function navigateAndInspect(
  ctx: ProbeContext,
  path: string,
): Promise<{ status: number; title: string; links: string[]; forms: string[] }> {
  const res = await ctx.anon.get(abs(ctx.baseUrl, path), { maxRedirects: 0, failOnStatusCode: false });
  let html = "";
  try {
    html = (await res.text()).slice(0, 60_000);
  } catch {
    /* ignore */
  }
  const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "").trim();
  const links = uniq(
    [...html.matchAll(/href="(\/[^"#?]*)"/g)].map((m) => m[1]).filter((h) => !h.startsWith("/_next")),
  ).slice(0, 40);
  const forms = uniq([...html.matchAll(/<form[^>]*action="([^"]+)"/gi)].map((m) => m[1])).slice(0, 20);
  return { status: res.status(), title, links, forms };
}

function uniq(a: string[]): string[] {
  return [...new Set(a)];
} 

export function buildSecurityTools(ctx: ProbeContext) {
  const inspectPage = tool(
    async (input: { path: string }) => {
      const r = await navigateAndInspect(ctx, input.path);
      return JSON.stringify(r);
    },
    {
      name: "inspectPage",
      description:
        "Fetch a CRM page and return its HTTP status, title, in-app links and form actions. Use it to discover surfaces to probe, starting from dealer onboarding.",
      schema: z.object({
        path: z.string().describe("App-relative path, e.g. /dealer-onboarding"),
      }),
    },
  );

  const listKnownSurfaces = tool(
    async () => {
      return JSON.stringify({
        seedPages: SEED_PAGES,
        sensitiveApiRoutes: SENSITIVE_UNAUTH_ROUTES.map((t) => t.path),
        adminSurfaces: ADMIN_SURFACES.map((s) => s.path),
      });
    },
    {
      name: "listKnownSurfaces",
      description: "Return the curated seed pages and known sensitive/admin routes the scanner already covers.",
      schema: z.object({}),
    },
  );

  return [inspectPage, listKnownSurfaces];
}
