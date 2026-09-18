# WhatsApp dealer status updates — message texts

B14 (2026-09-18). The texts a dealer receives on WhatsApp as a financed customer
lead moves through field investigation, the loan agreement and sanction. Business
submits the *template* rows to the WhatsApp provider (question A5); the *session*
rows are free-form and need no approval.

## How a message reaches the dealer

Every one of these events is a notification (`src/lib/notifications/events.ts`).
`emit()` writes the bell rows, then — when the lead's dealer is an addressee and the
type is mapped in `src/lib/notifications/whatsapp-dealer.ts` — pushes the dealer's
WhatsApp chat via `pushToLead` (`src/lib/whatsapp/lead-push.ts`):

| Situation | What is sent | Approval needed |
|---|---|---|
| Dealer messaged us within the last 24 h (service window open) | The free-form **session body** below | No |
| Window closed | The approved **`lead_action`** template, with the body parked until the dealer replies | Yes — one template covers every stage |

The push is fire-and-forget: a WhatsApp failure is logged and never fails the
NBFC's action. Every send is written to `whatsapp_messages` (outbound) and every
stage to `lead_flow_events`, which is what the dealer's *History* card lists.

Nothing below carries the customer's Aadhaar, PAN, address or loan amount — stage,
customer name, reference id, agent / signer name and a reason only.

## The nudge template (`lead_action`)

One template, three parameters. Sent whenever the service window is closed.

| Param | Value |
|---|---|
| {{1}} | Dealer's name |
| {{2}} | Lead reference id |
| {{3}} | The stage's one-line "what is needed" from the table below |

## Stage messages

`{name}` = customer name, `{ref}` = lead reference, `{agent}` = field agent,
`{signer}` = who signed, `{reason}` = the lender's reason when given.

| Stage | Notification type | Fires from | Session body | `lead_action` {{3}} |
|---|---|---|---|---|
| FI scheduled | `fi.assigned` | NBFC assigns an agent (`POST /api/nbfc/fi/[leadId]/action`, action=assign) | 🧭 *Field visit scheduled*<br><br>Customer: {name} · {ref}<br><br>The lender has assigned a field investigation to {agent}. Please make sure your customer is available at the address on file. | a field visit is scheduled for {name} |
| FI done | `fi.submitted` | Agent submits the field form (`POST /api/nbfc/fi/field-form/[token]/submit`) | 📋 *Field visit completed*<br><br>Customer: {name} · {ref}<br><br>The field agent ({agent}) has completed the visit and submitted the report. The lender is reviewing it — you will hear the outcome here. | the field visit for {name} is done and under review |
| FI passed | `fi.reviewed` (outcome pass) | NBFC decides (action=decide) | ✅ *Field investigation passed*<br><br>Customer: {name} · {ref}<br><br>The lender has cleared the field visit. No action needed from you. | the field investigation for {name} passed |
| FI failed | `fi.reviewed` (outcome fail) | NBFC decides (action=decide) | ❌ *Field investigation failed*<br><br>Customer: {name} · {ref}<br>Reason: {reason}<br><br>The lender did not pass the field visit. iTarang will guide the next step. | the field investigation for {name} failed |
| Re-inspection | `fi.reinspection` | NBFC orders another visit (action=reinspect) | 🔁 *Re-inspection ordered*<br><br>Customer: {name} · {ref}<br>Reason: {reason}<br><br>The lender wants another field visit. Please make sure your customer is available again. | a re-inspection was ordered for {name} |
| Agreement sent | `agreement.initiated` | NBFC sends the DigiO agreement (`POST /api/nbfc/agreement/[leadId]/initiate`) | ✍️ *Loan agreement sent for signing*<br><br>Customer: {name} · {ref}<br><br>The loan agreement was sent to {signer}. Please ask your customer to sign it. | {name} needs to sign the loan agreement |
| Agreement signed | `agreement.signed` | DigiO webhook (`/api/nbfc/agreement/callback`), DigiO poll (`sync-loan-agreement-status`), or manual record (`record-manual`) | ✅ *Loan agreement signed*<br><br>Customer: {name} · {ref}<br><br>All signatures are in. | the loan agreement for {name} was signed |
| Loan sanctioned | `loan.sanctioned` | NBFC sanction route, pushed directly by `pushSanctionedToWhatsApp` (offer-flow.ts) — uses its own `sanctioned` template | 🎉 *Loan approved for {name}!*<br><br>{dealer}, application {ref} has been sanctioned. Next: send the approved order to the customer and confirm delivery. | (template `sanctioned`) |

## What B14 changed

- `fi.submitted` now reaches the dealer (it was NBFC ⇄ admin only) and has a WhatsApp body.
- `agreement.signed` now also fires from the manual-record route and the DigiO poll, not only the webhook. The hook dedupes a webhook and a poll reporting the same signature within ten minutes.
- Every stage push is also written to `lead_flow_events` (action `notify`), so the dealer's *History* card shows it.
