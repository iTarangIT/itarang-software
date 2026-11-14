import "server-only";

// 251 item 20 — an AI Analyst answer's table was downloaded. The file is built in the browser
// from the answer already on screen; this records it in data_download_log like every other
// download (ID 13), so Reports › Data downloads › Recent downloads shows it.
//
//   POST { thread_id, run_id, rows, columns }

import { z } from "zod";

import { ownsThread, requireAnalystUser } from "@/lib/analyst/access";
import { errorResponse } from "@/lib/analyst/errors";
import { logDataDownload } from "@/lib/exports/downloadLog";

export const dynamic = "force-dynamic";

const Body = z.object({
  thread_id: z.string().min(1).max(100),
  run_id: z.string().min(1).max(64),
  rows: z.number().int().min(0).max(1_000_000),
  columns: z.number().int().min(0).max(1000),
});

export async function POST(request: Request) {
  try {
    const user = await requireAnalystUser();
    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "that download could not be recorded", code: "invalid_request" }, { status: 422 });
    }
    if (!ownsThread(user, parsed.data.thread_id)) {
      return Response.json({ error: "that conversation is not yours", code: "forbidden" }, { status: 403 });
    }
    await logDataDownload({
      userId: user.id,
      role: user.role,
      dataset: "analyst_answer",
      rowCount: parsed.data.rows,
      ownOnly: false,
      filters: { thread_id: parsed.data.thread_id, run_id: parsed.data.run_id, columns: parsed.data.columns },
      fullPhone: false,
      format: "xlsx",
    });
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error, "could not record the download");
  }
}
