// Unipile hosted-auth notify (an account finished connecting). No session: the
// URL carries ?token=<LinkedIn webhook secret>, compared in constant time.
// `name` is our li_accounts.id, set when the connect link was created.
import { NextResponse } from "next/server";

import { webhookSecret } from "@/lib/linkedin/credentials";
import { attachProviderAccount, getAccount } from "@/lib/linkedin/services/accounts";
import { bearerProof, guardWebhook } from "@/lib/security/webhookAuth";

export const dynamic = "force-dynamic";

const ROUTE = "/api/webhooks/linkedin/unipile";

export async function POST(req: Request) {
  const secret = await webhookSecret();
  const token = new URL(req.url).searchParams.get("token");
  const refused = guardWebhook({
    route: ROUTE,
    secret,
    proof: bearerProof(secret, token ? `Bearer ${token}` : req.headers.get("authorization")),
    configure: "Set APP_SECRETS_ENC_KEY so the LinkedIn module can mint its webhook secret (LinkedIn › Accounts).",
  });
  if (refused) return refused;
  const body = (await req.json().catch(() => ({}))) as { status?: string; account_id?: string; name?: string };
  const ok = /SUCCESS|RECONNECTED/i.test(body.status ?? "");
  if (!ok || !body.account_id || !body.name || !/^[0-9a-f-]{36}$/i.test(body.name)) {
    return NextResponse.json({ success: true, ignored: true });
  }
  if (!(await getAccount(body.name))) return NextResponse.json({ success: true, ignored: true });
  await attachProviderAccount(body.name, body.account_id);
  return NextResponse.json({ success: true });
}
