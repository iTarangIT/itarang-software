// E-396 — create the WhatsApp Assistant's camera-only "Shop photo" Flow on Meta.
//
//   node --env-file=<env> scripts/wa-assist/create-visit-flow.mjs            # DRAFT: created, not published
//   node --env-file=<env> scripts/wa-assist/create-visit-flow.mjs --publish  # created AND published
//
// Needs WA_ASSIST_WABA_ID (the WhatsApp Business Account that owns the
// Assistant's number) and WA_ASSIST_ACCESS_TOKEN (whatsapp_business_management).
// Prints the Flow id: put it in shared/.env as WA_ASSIST_VISIT_FLOW_ID and
// restart with --update-env. Until then a done visit keeps the CRM capture link.
// A DRAFT flow can be tested from Meta's Flow Builder before publishing;
// the Assistant only sends published flows.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const publish = process.argv.includes("--publish");
const waba = process.env.WA_ASSIST_WABA_ID?.trim();
const token = process.env.WA_ASSIST_ACCESS_TOKEN?.trim();
const version = process.env.WA_ASSIST_GRAPH_VERSION?.trim() || "v21.0";
if (!waba || !/^\d{5,30}$/.test(waba)) throw new Error("Set WA_ASSIST_WABA_ID (numeric WhatsApp Business Account id).");
if (!token) throw new Error("Set WA_ASSIST_ACCESS_TOKEN.");

const here = dirname(fileURLToPath(import.meta.url));
const flowJson = readFileSync(join(here, "visit-photo-flow.json"), "utf8");
JSON.parse(flowJson); // fail early on a broken file

const res = await fetch(`https://graph.facebook.com/${version}/${waba}/flows`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
        name: `iTarang visit shop photo ${new Date().toISOString().slice(0, 10)}`,
        categories: ["OTHER"],
        flow_json: flowJson,
        publish,
    }),
});
const body = await res.json().catch(() => null);
if (!res.ok || !body?.id) {
    console.error("Meta refused the flow:", JSON.stringify(body?.error ?? body, null, 2));
    process.exit(1);
}
if (Array.isArray(body.validation_errors) && body.validation_errors.length) {
    console.error("Validation errors:", JSON.stringify(body.validation_errors, null, 2));
    process.exit(1);
}
console.log(`Flow id: ${body.id} (${publish ? "PUBLISHED" : "draft — re-run with --publish, or publish it in WhatsApp Manager"})`);
console.log(`Next: add WA_ASSIST_VISIT_FLOW_ID=${body.id} to the server env and restart with --update-env.`);
