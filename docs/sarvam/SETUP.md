# Sarvam "Priya" — AI Dialer setup

Sarvam is the third AI Dialer provider, next to Bolna and ElevenLabs. The
dialer keeps its own queue, retries and dispositions. Sarvam only places the
call and reports how it ended.

Source: *Sarvam Priya → iTarang CRM Developer Handoff Spec* (20 Nov 2026).

## What is in the code

| Piece | Where |
| --- | --- |
| Provider list (single source of truth) | `src/lib/ai/providers.ts` — `DIALER_PROVIDERS`, `toDialerProvider`, labels, call endpoints |
| One trigger switch for all providers | `src/lib/ai/triggerProviderCall.ts` (used by `advanceCampaign`, `/api/ai-dialer/status`, AI callbacks) |
| Place a call | `src/lib/ai/sarvam/triggerCall.ts` → `POST /outbounds`, returns `attempt_id` (stored in `bolna_call_id`) |
| Call-end webhook | `POST /api/sarvam/webhook?token=…` → `src/lib/ai/sarvam/webhookHandler.ts` |
| Payload mapping (pure, tested) | `src/lib/ai/sarvam/normalizeWebhook.ts` |
| Recording | `src/lib/ai/sarvam/fetchRecording.ts` — WAV pulled from the analytics API and re-hosted |
| Cost | `src/lib/ai/sarvam/fetchCallCost.ts` — `duration × SARVAM_COST_PER_MIN_INR` |
| Single-call route | `POST /api/sarvam/call` (CallButton, /leads dialer loop) |
| Probe | `scripts/sarvam-probe.ts` |

The webhook flow works like this:
- A connected call runs the existing ElevenLabs finalize pipeline with
  `provider: "sarvam"`. That covers transcript analysis, `ai_call_logs`, the
  timeline, the disposition and advancing the campaign.
- `no_answer`, `busy` and `failed` take the same path as an ElevenLabs
  initiation failure.

No database migration is needed, because `provider` columns are free text.

## Environment (every box that runs the dialer)

See the Sarvam block in `.env.example`. The dialer refuses Sarvam calls until
everything except `SARVAM_COST_PER_MIN_INR` is set.

| Variable | Value |
| --- | --- |
| `SARVAM_API_KEY` | Workspace API key (Settings in the Sarvam dashboard) |
| `SARVAM_ORG_ID` / `SARVAM_WORKSPACE_ID` | Same page |
| `SARVAM_APP_ID` | `Priya---iTa-44bf0300-67c5` |
| `SARVAM_APP_VERSION` | `1`. Must be a **committed** version. Bump it on each new commit |
| `SARVAM_CONNECTION_ID` | Telephony connection ID, once one exists |
| `SARVAM_AGENT_PHONE_NUMBER` | Caller ID, E.164 |
| `SARVAM_WEBHOOK_TOKEN` | `openssl rand -hex 32`, different per environment |
| `SARVAM_WEBHOOK_BASE_URL` | Public base URL of this CRM, e.g. `https://crm.itarang.com` |
| `SARVAM_COST_PER_MIN_INR` | Contracted INR per talk-minute (optional; cost stays empty without it) |

Where to set them:
- **Sandbox:** edit `shared/.env` on the box, then `pm2 reload`.
- **Production:** update the `PROD_ENV_FILE_B64` secret. It rewrites `shared/.env` on every deploy.

## Sarvam-side setup, in order

1. **Connect telephony.** Either buy a managed number, or bring a carrier
   account (Exotel, Twilio, Tata Tele, Smartflo or SIP). Note the connection
   ID and the caller ID.
2. **Create the workspace API key.** Note the org ID and the workspace ID.
3. **Verify one team phone number** in the workspace, for test calls.
4. **`shop_name` is never blank.** The CRM already handles this: it falls back
   to the owner name, then to "aapki dukaan" (`callHelpers.ts`). The opening
   line is "Am I speaking with {{shop_name}}?".
5. **Clear the agent's test defaults** on the three input variables (Sharma
   Battery, Sharma ji, Lucknow), so a missing value fails loudly.

## Unverified points: settle with the probe before the first campaign

```
node --import tsx --env-file=.env.local scripts/sarvam-probe.ts \
  --to +91XXXXXXXXXX --webhook https://webhook.site/<id>
```

| # | Question | Current handling in code | Answer |
| --- | --- | --- | --- |
| 1 | Does `final_agent_variables` carry the 20 post-call variables when the webhook fires? | Read if present. If they are missing, dispositions fall back to transcript analysis. The webhook log records `agentVariables: <count>` | |
| 2 | Is the instant-outbound webhook signed? | URL token (`?token=`), checked in constant time | |
| 3 | Is the transcript English only? | `en_text` is used. `indic_text` is read only when `en_text` is empty | |
| 4 | Is there a status lookup for an `attempt_id`, and are failed webhook deliveries retried? | The poller skips Sarvam rows. A lost webhook leaves the row to the `calling` watchdog | |
| 5 | Cost per call | `SARVAM_COST_PER_MIN_INR` × duration | |
| 6 | Rate and concurrency limits | One call per campaign at a time. There is no provider-level limiter yet | |

## Known limits

- **Hindi only.** Leads whose earlier calls learned another language should
  stay on ElevenLabs.
- **The agent speaks first** on connect. The ElevenLabs agent waits for hello.
- **Five ElevenLabs quality checks** have no Sarvam equivalent. These include
  no price quoted and no WhatsApp promise. For Sarvam they are prompt rules
  only.
- **No follow-up scheduler.** Sarvam leads are excluded from the Bolna
  follow-up crons, so they are never redialled through Bolna, and there is no
  separate Sarvam follow-up cron. Campaigns and E-315 retries cover redials.

## Rollout

1. **Probe.** Run the probe and fill in the Answer column above.
2. **Sandbox, single call.** Use the Sarvam provider from the dialer, then check:
   - the `ai_call_logs` row;
   - the timeline entry;
   - the disposition;
   - that the recording plays.
3. **Sandbox, campaign of five.** Include one busy number and one number that
   doesn't answer. The campaign must advance after each one, and a retry must
   stay on Sarvam.
4. **Regression.** Place one ElevenLabs call and one Bolna call. Run
   `npm run type-check` and `npm test`.
5. **Production pilot.** Use 50 leads, from Hindi-belt active cities only.
   Compare against the ElevenLabs agent on a matched list:
   - connect rate;
   - qualified rate;
   - cost per qualified lead.
