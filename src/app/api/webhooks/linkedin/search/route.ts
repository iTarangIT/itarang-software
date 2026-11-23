// Bright Data delivery for a LinkedIn search run (doc §3.2). No session: the
// caller proves itself with `Authorization: Bearer <LinkedIn webhook secret>`
// (Bright Data's auth_header), compared in constant time. A repeated delivery
// creates no duplicates — ingestResults upserts on profile slug / URL.
import { NextResponse } from "next/server";

import { webhookSecret } from "@/lib/linkedin/credentials";
import { searchProvider } from "@/lib/linkedin/providers";
import { ingestResults } from "@/lib/linkedin/services/search";
import { bearerProof, guardWebhook } from "@/lib/security/webhookAuth";

export const dynamic = "force-dynamic";

const ROUTE = "/api/webhooks/linkedin/search";

export async function POST(req: Request) {
  const secret = await webhookSecret();
  const refused = guardWebhook({
    route: ROUTE,
    secret,
    proof: bearerProof(secret, req.headers.get("authorization")),
    configure: "Set APP_SECRETS_ENC_KEY so the LinkedIn module can mint its webhook secret (LinkedIn › Accounts).",
  });
  if (refused) return refused;
  const runId = new URL(req.url).searchParams.get("run");
  if (!runId || !/^[0-9a-f-]{36}$/i.test(runId)) {
    return NextResponse.json({ success: false, error: "run id missing" }, { status: 400 });
  }
  const records = searchProvider().parseDelivery(await req.json().catch(() => []));
  const saved = await ingestResults(runId, records, { finish: true });
  return NextResponse.json({ success: true, saved });
}
