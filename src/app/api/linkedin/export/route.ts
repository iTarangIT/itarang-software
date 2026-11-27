// LinkedIn Outreach — downloads (E-398). Same filters as the screen it is on.
//   GET ?type=campaign_rows|prospects|analytics&format=xlsx|csv&…filters
//   campaign_rows / analytics: from, to (YYYY-MM-DD IST), category, account_id, campaign_id, status, state
//   prospects: run, state, company, city, title, q
import { z } from "zod";

import { withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { LINKEDIN_ROLES } from "@/lib/linkedin/roles";
import { analyticsTables, campaignRowsTable, prospectsTable, toCsv, toXlsx, type Table } from "@/lib/linkedin/services/export";

export const dynamic = "force-dynamic";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
const Query = z.object({
  type: z.enum(["campaign_rows", "prospects", "analytics"]),
  format: z.enum(["xlsx", "csv"]).default("xlsx"),
  from: date,
  to: date,
  category: z.string().trim().max(24).optional(),
  account_id: z.string().uuid().optional(),
  campaign_id: z.string().uuid().optional(),
  status: z.string().trim().max(12).optional(),
  state: z.string().trim().max(16).optional(),
  run: z.string().uuid().optional(),
  company: z.string().trim().max(150).optional(),
  city: z.string().trim().max(80).optional(),
  title: z.string().trim().max(120).optional(),
  q: z.string().trim().max(150).optional(),
});

export const GET = withErrorHandler(async (req: Request) => {
  await requireRole([...LINKEDIN_ROLES]);
  const sp = new URL(req.url).searchParams;
  const q = Query.parse(Object.fromEntries([...sp.entries()].filter(([, v]) => v !== "")));
  const af = {
    from: q.from,
    to: q.to,
    category: q.category,
    accountId: q.account_id,
    campaignId: q.campaign_id,
    status: q.status,
  };

  let tables: Table[];
  if (q.type === "campaign_rows") tables = [await campaignRowsTable({ ...af, state: q.state })];
  else if (q.type === "analytics") tables = await analyticsTables(af);
  else
    tables = [
      await prospectsTable({ runId: q.run, state: q.state, company: q.company, city: q.city, title: q.title, q: q.q }),
    ];

  const stamp = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const base = `linkedin-${q.type.replace("_", "-")}-${stamp}`;
  if (q.format === "csv") {
    // CSV holds one table; analytics CSV is the category table.
    return new Response(toCsv(tables[0]), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${base}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }
  const buf = await toXlsx(tables);
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${base}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
});
