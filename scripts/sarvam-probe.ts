/**
 * Sarvam probe — handoff spec, "Test plan and rollout" step 1.
 *
 * Places ONE instant outbound call through the Priya agent to a phone number
 * you name, with the call-end webhook pointed at a request catcher (e.g. a
 * webhook.site URL) instead of the CRM. Read the captured payload to settle
 * unverified points 1–4 before the first campaign:
 *   1. does final_agent_variables carry the 20 post-call variables?
 *   2. is the webhook signed (any signature header)?  does the ?query survive?
 *   3. is interaction_transcript English only (en_text), or is indic_text sent?
 *   4. (separately) is there a status lookup for an attempt_id?
 *
 * Touches no database. Needs SARVAM_API_KEY, SARVAM_ORG_ID,
 * SARVAM_WORKSPACE_ID, SARVAM_CONNECTION_ID, SARVAM_AGENT_PHONE_NUMBER
 * (SARVAM_APP_ID / SARVAM_APP_VERSION optional).
 *
 * Usage (the number must be verified in the Sarvam workspace):
 *   node --import tsx --env-file=.env.local scripts/sarvam-probe.ts \
 *     --to +9198XXXXXXXX --webhook https://webhook.site/<id> \
 *     [--shop "Test Battery"] [--owner "Test ji"] [--location Lucknow]
 */

import { DEFAULT_SARVAM_APP_ID, outboundUrl } from "../src/lib/ai/sarvam/config";
import { buildSarvamAgentVariables, sarvamErrorText } from "../src/lib/ai/sarvam/callHelpers";
import type {
  SarvamCreateOutboundRequest,
  SarvamCreateOutboundResponse,
} from "../src/lib/ai/sarvam/types";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function need(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) {
    console.error(`Missing env ${name}`);
    process.exit(2);
  }
  return v;
}

async function main() {
  const to = arg("to");
  const webhook = arg("webhook");
  if (!to || !/^\+91\d{10}$/.test(to) || !webhook || !/^https:\/\//.test(webhook)) {
    console.error("Usage: --to +91XXXXXXXXXX --webhook https://<request-catcher>");
    process.exit(2);
  }

  const orgId = need("SARVAM_ORG_ID");
  const workspaceId = need("SARVAM_WORKSPACE_ID");
  const apiKey = need("SARVAM_API_KEY");

  const body: SarvamCreateOutboundRequest = {
    app_config: {
      app_id: (process.env.SARVAM_APP_ID ?? "").trim() || DEFAULT_SARVAM_APP_ID,
      app_version: Number.parseInt(process.env.SARVAM_APP_VERSION || "1", 10),
      connection_config: {
        connection_id: need("SARVAM_CONNECTION_ID"),
        agent_phone_number: need("SARVAM_AGENT_PHONE_NUMBER"),
      },
      agent_variables: buildSarvamAgentVariables({
        shop_name: arg("shop") ?? "Test Battery",
        dealer_name: arg("owner") ?? "Test ji",
        location: arg("location") ?? "Lucknow",
      }),
    },
    user_config: { user_phone_number: to },
    webhook_config: {
      // ?probe= checks that Sarvam keeps the query string (unverified point 2).
      url: `${webhook}${webhook.includes("?") ? "&" : "?"}probe=1`,
      metadata: { lead_id: "PROBE", phone: to },
    },
  };

  console.log("POST", outboundUrl({ orgId, workspaceId }));
  console.log(JSON.stringify({ ...body, webhook_config: { ...body.webhook_config } }, null, 2));

  const res = await fetch(outboundUrl({ orgId, workspaceId }), {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as SarvamCreateOutboundResponse | null;
  console.log(`HTTP ${res.status}`, JSON.stringify(json, null, 2));
  if (!res.ok || !json?.attempt_id) {
    console.error("Call not placed:", sarvamErrorText(json, res.status));
    process.exit(1);
  }
  console.log(
    `\nattempt_id ${json.attempt_id}. Answer the call, then read the webhook at your request catcher.` +
      "\nRecord the answers to points 1–4 in docs/sarvam/SETUP.md.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
