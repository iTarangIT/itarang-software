/**
 * Agent tools (doc §9), LangChain tool-calling. There is NO tool that sends a
 * message: the most an agent can do is queue an already-approved campaign,
 * which the send ticker still re-checks against the approval hashes.
 */
import { tool } from "@langchain/core/tools";
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { liApprovals, liConversations, liMessages, liProspects } from "@/lib/db/schema";

import { getCampaign, setCampaignStatus } from "../services/campaigns";
import { draftFor } from "../services/inbox";
import { createSearchRun, getRun, startSearchRun } from "../services/search";

export function linkedInAgentTools(actorId: string | null) {
  return [
    tool(
      async ({ keywords, account_id, location, company }) => {
        const run = await createSearchRun({ keywords, filters: { location, company }, accountId: account_id ?? null, actorId });
        await startSearchRun(run.id);
        return JSON.stringify({ run_id: run.id });
      },
      {
        name: "search_profiles",
        description: "Start a LinkedIn profile search for keywords; results are saved as prospects and scored.",
        schema: z.object({
          keywords: z.string().min(2),
          account_id: z.string().uuid().optional(),
          location: z.string().optional(),
          company: z.string().optional(),
        }),
      },
    ),
    tool(
      async ({ run_id }) => {
        const r = await getRun(run_id);
        if (!r) return "run not found";
        return JSON.stringify({
          status: r.run.status,
          shortlist: r.results.slice(0, 20).map((p) => ({ name: p.full_name, company: p.company, score: p.fit_score, reason: p.fit_reason })),
        });
      },
      { name: "summarise_run", description: "Shortlist of a search run with fit reasons.", schema: z.object({ run_id: z.string().uuid() }) },
    ),
    tool(
      async ({ campaign_id }) => {
        const [approval] = await db
          .select({ id: liApprovals.id })
          .from(liApprovals)
          .where(and(eq(liApprovals.campaign_id, campaign_id), isNull(liApprovals.voided_at)))
          .limit(1);
        if (!approval) return "rejected: this campaign has no valid approval — the Sales Head must approve it in the CRM";
        const c = await getCampaign(campaign_id);
        if (c.status === "paused") await setCampaignStatus(campaign_id, "resume", actorId);
        return `queued: campaign ${c.name} is ${c.status === "paused" ? "running again" : c.status}; the send worker paces it`;
      },
      {
        name: "enqueue_campaign",
        description: "Queue an APPROVED campaign for the paced send worker. Rejected without a valid approval. Does not send.",
        schema: z.object({ campaign_id: z.string().uuid() }),
      },
    ),
    tool(
      async ({ since }) => {
        const rows = await db
          .select({ m: liMessages, p: liProspects })
          .from(liMessages)
          .innerJoin(liConversations, eq(liConversations.id, liMessages.conversation_id))
          .leftJoin(liProspects, eq(liProspects.id, liConversations.prospect_id))
          .where(and(eq(liMessages.direction, "in"), gte(liMessages.sent_at, new Date(since))))
          .orderBy(desc(liMessages.sent_at))
          .limit(50);
        return JSON.stringify(
          rows.map((r) => ({ conversation_id: r.m.conversation_id, from: r.p?.full_name, company: r.p?.company, text: r.m.body, at: r.m.sent_at })),
        );
      },
      { name: "list_replies", description: "New inbound replies since an ISO date.", schema: z.object({ since: z.string() }) },
    ),
    tool(
      async ({ conversation_id }) => JSON.stringify(await draftFor(conversation_id)),
      {
        name: "draft_reply",
        description: "A suggested reply for the admin to review. Never sent on its own.",
        schema: z.object({ conversation_id: z.string().uuid() }),
      },
    ),
  ];
}
