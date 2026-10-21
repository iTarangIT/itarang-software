# 17 Oct task sheet — production steps (each needs your go-ahead)

The code is on the `Aditya` branch. Sandbox (db-1) has every migration
applied and checked. Nothing below has been run on production.

Run the steps in this order. Prod env changes go in **both** places: the box
(`shared/.env`) and the `PROD_ENV_FILE_B64` GitHub secret, because prod's env
is rewritten on every deploy.

## 0. Migrations on db-2 — DONE 2026-10-16

Applied to both DBs (renumbered from E-343..E-345, which main took). Kept here for the record.

Each one is additive and idempotent, applied twice and re-checked on a fresh
connection.

```bash
node scripts/_apply-e350.mjs database-2   # fixed "Limit passed" records, Hot / retry / quote clocks, holiday log
node scripts/_apply-e351.mjs database-2   # NeoDove endpoints stored encrypted
node scripts/_apply-e352.mjs database-2   # password change dates (90-day expiry)
```

Then tick the db-2 / prod boxes in `drizzle/MIGRATION_CHECKLIST.md`.

## 1. Deploy, then rebuild the clocks

```bash
export DATABASE_URL=<db-2 url from .env.production>
node --import tsx --env-file=.env.production scripts/refresh-lead-clocks.ts --dry-run
node --import tsx --env-file=.env.production scripts/refresh-lead-clocks.ts
node --import tsx --env-file=.env.production scripts/verify-id85-86-time-limits.ts
```

The first refresh records every miss so far under the new rules. The hourly
ticker keeps the table up to date after that.

## 2. NeoDove (A32): point the webhook back at prod, then replay

**Since 6 Oct, NeoDove has been posting every call to the SANDBOX CRM.**
Prod's last event is 6 Oct. Steps:

1. In NeoDove → Custom Integration → webhook URL:
   `https://crm.itarang.com/api/neodove/webhook`, with the prod
   `NEODOVE_WEBHOOK_SECRET` as the bearer.
2. Make one test call and check it appears on prod.
3. Replay what prod missed. Dry run first, then commit:
   ```bash
   node --import tsx --env-file=.env.local scripts/replay-neodove-events.ts --since=2026-10-06 --to=https://crm.itarang.com/api/neodove/webhook
   NEODOVE_TARGET_SECRET=<prod NEODOVE_WEBHOOK_SECRET> node --import tsx --env-file=.env.local scripts/replay-neodove-events.ts --since=2026-10-06 --to=https://crm.itarang.com/api/neodove/webhook --commit
   ```
   It is idempotent on NeoDove's event id, so re-running is safe.
4. Optional, to let Admin wire campaigns from the screen: set
   `APP_SECRETS_ENC_KEY` (base64 of 32 random bytes) in the prod env, unless
   `NBFC_CREDENTIALS_ENC_KEY` is already set there.

## 3. ID 130: switch the protections on

Follow `docs/security/ID130_SWITCH_ON.md` steps 1–3. In short:

1. Set `BOLNA_WEBHOOK_SECRET`, `DIGIO_WEBHOOK_SECRET` and `BOLNA_TOOL_SECRET`.
2. Read the `[api-gate] would refuse` log lines.
3. Set `API_AUTH_GATE=enforce` and `WEBHOOK_AUTH_STRICT=1`.

To undo: set `API_AUTH_GATE=report` and empty `WEBHOOK_AUTH_STRICT`.

## 4. ID 70: Zoho copy (one time)

```bash
node --import tsx --env-file=.env.production scripts/backfill-zoho-gstin-lines.ts            # dry run
node --import tsx --env-file=.env.production scripts/backfill-zoho-gstin-lines.ts --commit
node --import tsx --env-file=.env.production scripts/verify-id70-zoho-copy.ts
```

## 5. ID 71: credit-note fill-in (when credit notes exist)

Neither database has a credit note yet. Once Finance marks a folder as Credit
notes (Invoice Ledger › Drive folders) and a scan reads them:

```bash
node --import tsx --env-file=.env.production scripts/backfill-drive-line-items.ts --credit-notes            # dry run
node --import tsx --env-file=.env.production scripts/backfill-drive-line-items.ts --credit-notes --commit   # records the run
```

## 6. ID 167: Analyst read-only login on prod

The `analyst_ro` role does **not exist** on db-2. Follow
`docs/analyst/ANALYST_RO_RUNS.md` → "Prod: to do". It needs a password you
choose.

## 7. A39: force every user to set a new password

Tell the team first: everyone is stopped at their next click until they set
a new password.

```bash
node --import tsx --env-file=.env.production scripts/force-password-change-all.ts --except=it@itarang.com           # dry run
node --import tsx --env-file=.env.production scripts/force-password-change-all.ts --except=it@itarang.com --commit
```

Then deactivate the people who have left in Admin › Settings › Logins.

## 8. Data the code cannot fix

- **Per-person revenue and batteries are 0 on prod.** No dealer account has
  an owner, so no invoice is credited to a rep. This is why Jiten's
  ₹5,62,500 (A14 / A26) cannot be reproduced. Assign owners on Admin ›
  Accounts.
- **Prod has read no October invoices** (Drive scan). Check the sales
  folders and the scan log.
- **65 prod invoices match an account that links to no lead.** Cohort
  reorders and turnaround billing stages stay sparse until accounts carry
  their source lead.
- **WhatsApp assistant (A34):** counts match the CRM on prod. Voice notes
  and reply language still need one live test call with Sonu or Nidhi.

## 9. 17 Oct second sheet (Aditya_Task_List.xlsx): prod steps

Code is on `Aditya` (commits 50272828..52adcdcd). Nothing below has been run on prod.

1. **E-353 (ID 194 My day)**: DONE 2026-10-17 on db-1 and db-2 (`node scripts/_apply-e353.mjs database-2`). Without it,
   My day sends nothing (logged as skipped); nothing else changes.
2. **My day switch-on**: Admin › Settings › My Day Emails. Send one test with "Test as"
   an ISR and one with a manager. It goes to your own address. Then tick the roles and
   enable it. Check first: `node --import tsx --env-file=.env.production scripts/verify-sales-daily.ts <day> --my-day <email>`.
3. **ID 167 Analyst**: §6 (create `analyst_ro` on db-2) now also creates the masked views
   `analyst_loan_files` / `analyst_loan_applications`. Then delete the saved outside sources:
   `node --import tsx --env-file=.env.production scripts/_delete-analyst-outside-connections.ts`
   (dry run), then add `--apply`. The CRM already hides and refuses them, so this is cleanup.
4. **Checks after deploy (read-only)**: `verify-id190-field-visit.ts`, `verify-id184-ready-no-owner.ts`,
   `verify-id192-idle.ts`.
5. Rows 70 / 130 / 5: §4 and §3 above, unchanged. Row 188 waits on Anirudh's format.
