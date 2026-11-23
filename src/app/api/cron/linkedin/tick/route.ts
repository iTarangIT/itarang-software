// Manual / external twin of the in-process LinkedIn ticker
// (startLinkedInTicker in src/instrumentation-node.ts). Bearer CRON_SECRET.
import { NextResponse } from "next/server";

import { isCronAuthorised } from "@/lib/cron-auth";
import { runLinkedInTick } from "@/lib/linkedin/workers/searchTick";

export const dynamic = "force-dynamic";

async function handle(req: Request) {
  if (!isCronAuthorised(req)) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  const result = await runLinkedInTick();
  return NextResponse.json({ success: true, result });
}

export const GET = handle;
export const POST = handle;
