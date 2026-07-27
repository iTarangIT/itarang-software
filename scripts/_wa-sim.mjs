// Drive the WhatsApp bot from the terminal — no tunnel, no Meta, no test-number
// recipient limit. Posts a Meta-shaped webhook payload at the local dev server,
// waits for the turn to finish, then prints what the bot replied by reading
// whatsapp_messages back out of the DB.
//
// Outbound sends still go to the Meta Graph API and will usually FAIL (the
// recipient isn't a registered test number). That's fine and expected: reply()
// logs the row with delivery_status='failed' either way, so every state
// transition still happens and you can read the exact reply text here. This is
// the fast loop for testing the operator state machine.
//
// SETUP (once): uncomment WHATSAPP_WEBHOOK_INSECURE=true in .env.local so the
// HMAC check is skipped, and restart `npm run dev`. NEVER set it in sandbox/prod.
//
// USAGE
//   node scripts/_wa-sim.mjs <phone> "hi"              # a typed message
//   node scripts/_wa-sim.mjs <phone> --tap op_new_dealer   # a button/list tap
//   node scripts/_wa-sim.mjs <phone> --log             # just re-print the last replies
//
//   <phone> is E.164 without '+', e.g. 918208677782
//
// EXAMPLE — the full "two dealers from one number" run:
//   node scripts/_wa-sim.mjs 918208677782 "hi"
//   node scripts/_wa-sim.mjs 918208677782 --tap op_new_dealer
//   node scripts/_wa-sim.mjs 918208677782 "9822001100"
//   node scripts/_wa-sim.mjs 918208677782 "Shree Auto"
//   node scripts/_wa-sim.mjs 918208677782 --tap sole_proprietorship
//   node scripts/_wa-sim.mjs 918208677782 "menu"
//   node scripts/_wa-sim.mjs 918208677782 --tap opf_close
//   node scripts/_wa-sim.mjs 918208677782 --tap op_new_dealer      # dealer #2

import { readFileSync } from "node:fs";
import postgres from "postgres";

const [, , phoneArg, ...rest] = process.argv;
if (!phoneArg) {
  console.error(
    'Usage: node scripts/_wa-sim.mjs <phone> "text" | --tap <id> | --log',
  );
  process.exit(1);
}

const waPhone = phoneArg.replace(/\D/g, "");
const logOnly = rest[0] === "--log";
const isTap = rest[0] === "--tap";
const body = isTap ? rest[1] : rest.join(" ");

if (!logOnly && !body) {
  console.error("Nothing to send. Pass a message, --tap <id>, or --log.");
  process.exit(1);
}

const BASE = process.env.WA_SIM_BASE || "http://localhost:3000";
const clean = (v) => v.trim().replace(/^["']|["']$/g, "");
const env = readFileSync(".env.local", "utf8");
const dbUrl = [...env.matchAll(/^\s*DATABASE_URL\s*=\s*(.+)$/gm)]
  .map((m) => clean(m[1]))
  .find((u) => u.startsWith("postgres"));
if (!dbUrl) {
  console.error("No uncommented DATABASE_URL in .env.local");
  process.exit(1);
}

const sql = postgres(dbUrl, {
  ssl: "require",
  prepare: false,
  max: 1,
  connect_timeout: 15,
});

try {
  const since = new Date();

  if (!logOnly) {
    // A unique id per send — whatsapp_messages.provider_message_id is UNIQUE and
    // recordInbound() drops duplicates, so a reused id would be silently ignored.
    const msgId = `wamid.SIM${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const message = isTap
      ? {
          id: msgId,
          from: waPhone,
          type: "interactive",
          interactive: {
            type: "list_reply",
            list_reply: { id: body, title: body },
          },
        }
      : { id: msgId, from: waPhone, type: "text", text: { body } };

    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ profile: { name: "Sim" }, wa_id: waPhone }],
                messages: [message],
              },
            },
          ],
        },
      ],
    };

    console.log(
      `→ ${waPhone}: ${isTap ? `[tap ${body}]` : JSON.stringify(body)}`,
    );

    const res = await fetch(`${BASE}/api/whatsapp/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status === 401) {
      console.error(
        "\n401 from the webhook — signature check is still on.\n" +
          "Uncomment WHATSAPP_WEBHOOK_INSECURE=true in .env.local and restart npm run dev.",
      );
      process.exit(1);
    }
    if (!res.ok) {
      console.error(`Webhook returned ${res.status}: ${await res.text()}`);
      process.exit(1);
    }

    // The route returns 200 immediately and runs the turn in Next's after(),
    // so give the state machine (Gemini/Decentro/Meta calls) time to land.
    const waitMs = Number(process.env.WA_SIM_WAIT || 4000);
    await new Promise((r) => setTimeout(r, waitMs));
  }

  const replies = await sql`
    SELECT m.direction, m.message_type, m.text_body, m.delivery_status,
           s.session_kind, s.current_state
    FROM whatsapp_messages m
    LEFT JOIN whatsapp_onboarding_sessions s ON s.id = m.session_id
    WHERE m.created_at >= ${logOnly ? new Date(Date.now() - 120000) : since}
      AND m.direction = 'outbound'
    ORDER BY m.created_at ASC`;

  if (replies.length === 0) {
    console.log(
      "\n(no outbound reply logged — check the dev-server console for an error)",
    );
  }
  for (const r of replies) {
    console.log(
      `\n← [${r.session_kind ?? "?"} · ${r.current_state ?? "?"} · ${r.delivery_status}]`,
    );
    console.log(r.text_body ?? `(${r.message_type})`);
  }

  // Where this number stands now: the hub plus every dealer file under it.
  const sessions = await sql`
    SELECT s.session_kind, s.current_state, a.company_name, a.wa_phone AS dealer_phone,
           a.onboarding_status
    FROM whatsapp_onboarding_sessions s
    LEFT JOIN dealer_onboarding_applications a ON a.id = s.application_id
    WHERE s.wa_phone = ${waPhone}
    ORDER BY s.session_kind, s.created_at`;
  console.log("\n─── sessions on this number ───");
  for (const s of sessions) {
    console.log(
      `  ${s.session_kind.padEnd(14)} ${String(s.current_state).padEnd(22)} ` +
        `${s.company_name ?? "—"}${s.dealer_phone ? ` (${s.dealer_phone}, ${s.onboarding_status})` : ""}`,
    );
  }
} finally {
  await sql.end();
}
