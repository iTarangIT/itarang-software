# Handover demo: Aditya's built items (27 Oct sheet, section 4)

Every step below was re-checked against the code on main on 29 Oct and corrected where the screen had changed. Run each check on the live site with the role shown; tick it in the sheet once business agrees.

## 1. Security & platform

### ID 145: AI dialer calling lists can be uploaded, started and stopped without logging in

- **Login:** Admin / CEO  ·  **Where:** /leads (AI Dialer switch) > Lists  ·  **Needs:** a running campaign

1. Log in as Business Head and open Leads: the AI Dialer switch shows, and its window has the Lists tab with New list campaign.
2. Log in as Sales Manager or partner and open Leads: there is no AI Dialer switch.
3. Open a running campaign as Sales Head: only Force stop shows. As CEO: Call next, Resume calling and Retry unreached also show.

### ID 141: AI Analyst can add its own data sources: the iTarang database, any Postgres database, uploaded files, Google Sheets / Drive

- **Login:** CEO  ·  **Where:** /ceo/analyst  ·  **Needs:** iTarang source connected

1. As CEO, open AI Analyst and ask for customer phone numbers from the customer leads table: it should say it cannot read them.
2. Ask for customer names and vehicle registration numbers: names come back only as 'Customer #XXXX' and vehicle numbers are not available (masked login, live since 26 Oct).

### ID 125: Run reminder and notification jobs on production only

- **Login:** developer  ·  **Where:** sandbox server log  ·  **Needs:** log access

1. Developer check: in the sandbox server log, each job prints '[live-site] <job>: <email / whatsapp / telegram> sends are skipped — not the live site' once. On live, the 08:00 fleet card and the digests still arrive.

## 2. ISR & ASM (daily lead work)

### ID 36: Remove stale leads (does not pick up, wrong number, shop closed etc etc), threshold non responsive threshold : called 6 times on 6 different days with in 45 days with no response "

- **Login:** Sales Head; owner ISR  ·  **Where:** /admin/number-repair, /leads, /inside-sales  ·  **Needs:** a lead flagged dead-number or non-responsive

1. Sales Head > Number Repair: each row shows the dealer, phone, owner, why it was flagged and since when.
2. Leads list: untick 'Hide dead & disqualified' and the flagged leads appear; tick it again and they disappear.
3. Log in as the owner of a flagged lead: it is not in My Open Leads or Follow-ups Today.

### ID 64: AI calls overwrite Hot / Warm / Cold on leads that have an owner

- **Login:** Sales Head / Admin  ·  **Where:** lead page (Open lead page)  ·  **Needs:** an owned Warm lead with an AI call

1. Pick an owned lead that is Warm. Correct its AI result to the top band: the lead stays Warm and only the AI score changes.

### ID 116: NeoDove stage sync sets commercials statuses and can move a lead backwards

- **Login:** Sales Head  ·  **Where:** /leads  ·  **Needs:** a NeoDove-called lead with an outcome like Commercials Finalised and no quote

1. Sales Head > Leads > click a lead the NeoDove team called with an outcome like 'Commercials Finalised' or 'Quotation Sent': the side panel shows that Disposition, but the status is Under Discussion unless a quote was made.
2. Click the lead > Open lead page > Touchpoint History: the NeoDove call is listed, with no move to a Commercials stage beside it.

### ID 123: A refused NeoDove status move is hidden in the server log, and the temperature is dropped

- **Login:** Sales Head  ·  **Where:** /leads/neodove-campaigns/activity  ·  **Needs:** a refused status move in the last 24h (rare since ID 116)

1. Open NEODOVE > Sync Activity and look for the new box 'Status moves refused (24h)'.
2. Tick 'Status move refused' to list only those calls; each row has an amber note with the old and new status.
3. Open one of those leads: the call is on the timeline and the temperature has changed.

### ID 139: AI Call History tab on the lead page shows every AI call attempt, from campaigns and one-off calls

- **Login:** ISR / ASM  ·  **Where:** lead page > AI Call History  ·  **Needs:** one AI-called lead and one never called

1. Open a lead the AI dialer has called > tab 'AI Call History': each try is listed with its date, campaign (or one-off), result and recording.
2. Under a try, check 'Intent: Qualified / Warm / Cold', 'Why this intent', the summary, and click 'Show transcript · N turns'.
3. Open a lead the AI never called: it says 'No AI calls yet'.

### ID 150: Campaigns pages removed from the ISR and ASM menus

- **Login:** ISR, ASM  ·  **Where:** /inside-sales, /asm  ·  **Needs:** none

1. Log in as an ISR or ASM: the menu has no 'Campaigns'.
2. Open an old campaign link from a message: it lands on My Queue (ISR) or My Visits (ASM).

### ID 112: WhatsApp Sales Assistant for ASM and ISR: queue and lead reads, log call / visit, follow-ups, claim, mark lost, transfer, reassign, escalate, convert, create lead, quotes, voice notes, photos / PDFs / location pins

- **Login:** ASM / ISR on WhatsApp  ·  **Where:** WhatsApp  ·  **Needs:** the rep's number bound in assistant_wa_bindings

1. On WhatsApp from an ASM's or ISR's linked number, ask 'my hot leads': the count matches the Hot card in their CRM queue.
2. Log a call by text: it shows a preview and saves only after you confirm; the lead's timeline shows it.

### ID 137: WhatsApp Assistant records a Re-inquiry and alerts the owner and Sales Head before the rep confirms

- **Login:** ASM / ISR on WhatsApp  ·  **Where:** WhatsApp, then the lead page  ·  **Needs:** a bound number and a dealer phone already in the CRM

1. On WhatsApp, ask the Assistant to add a dealer with a phone number already in the CRM. The reply asks 'Did the dealer contact us again?' with Yes / No.
2. Tap No, then open that lead in the CRM: there is no new Re-inquiry line and the owner got no alert.
3. Repeat and tap Yes: a 'Re-inquiry via whatsapp assistant' line appears on the lead, and the owner and Sales Head get an alert.

## 3. Sales Head & Admin (team control)

### ID 63: NeoDove push and dial assign an owner before anyone calls

- **Login:** Sales Head  ·  **Where:** /leads  ·  **Needs:** an unassigned lead no linked agent has called

1. Sales Head > Leads > tick an unassigned lead > 'Send to NeoDove': the box says 'Owner is set by the first call of a linked NeoDove agent.' and has no 'assign to' choice.
2. After the push, click the lead row: Owner still shows 'Unassigned' until a NeoDove agent calls.

### ID 109: AI dialer call outcomes: 'Completed' only when the dealer spoke, per-status campaign analytics, Voicemail, Silent Call / Hung Up Early, intent score from the lithium-dealer question

- **Login:** Admin / CEO  ·  **Where:** Leads > Campaigns  ·  **Needs:** a recent AI campaign

1. Open a recent AI campaign: lead statuses read Completed, Voicemail, Switchboard, Silent Call or Hung Up Early; 'Completed' rows all have the dealer speaking in the transcript.
2. A Switchboard lead is not redialled.

### ID 138: AI dialer campaigns redial unreached leads automatically (up to 3 retries) and don't spend a retry when our line refuses the call

- **Login:** Admin / CEO  ·  **Where:** Leads > Campaigns > a campaign  ·  **Needs:** a campaign with retries pending

1. Open a recent campaign: while retries are waiting, the header shows 'Auto-retry · N leads to redial · next … IST'.
2. In its lead list, a lead waiting for a retry shows 'Retry <day, time>' under its status, and the attempts column shows 2×, 3× …
3. Check that no retry time is before 10:00 or after 19:00 IST (the dialler's hours since 27 Oct), and no number gets more than 2 dials in one day.

### ID 144: AI dialer: show when dealers answer and talk, by hour and weekday, so calling hours can be set from data

- **Login:** Admin / Sales Head  ·  **Where:** /leads > Call timing  ·  **Needs:** 20+ dials per hour for a suggestion

1. Open Leads > Call timing, pick a date range and a campaign; the grid fills by weekday and hour.
2. Click CSV: the file has Weekday, Hour (IST), Dials, Answered, Talked and the two rates.
3. As Admin or Sales Head, click 'Use as default calling hours', then start a new AI campaign: its calling window is filled in with those hours (calls still go out only between 10:00 and 19:00 IST).

### ID 8: Same dashboard data at each employee level

- **Login:** ISR; Sales Head  ·  **Where:** /inside-sales/performance, /sales-head  ·  **Needs:** an ISR who called yesterday

1. Log in as an ISR, open Performance, set yesterday and note the calls.
2. Log in as Sales Head, open Dashboard, pick that ISR under Person and the same day: calls must match.
3. Compare with that ISR's row in Block C of the Sales Daily email.

### ID 9: Daily email report - Sales (yesterday, MTD, last 7 days, scheduled today) per SPOC

- **Login:** Admin / CEO / Sales Head  ·  **Where:** /reports?section=emails  ·  **Needs:** none

1. Open Reports > Scheduled email reports and press Preview on Sales Daily.
2. Check Block C ('C · Inside sales (ISR / CC)') has one row per ISR who called, team subtotals and a Total row, and that Block A 'Engaged calls' MTD equals Block C's Engaged total.
3. Check the Sales Daily row is green (on and sent); amber means on but not sent yet; grey means switched off.

### ID 10: Daily email report - Buyback (kg sourced, dealers called, images shared, quotes shared) per SPOC

- **Login:** Admin  ·  **Where:** /admin/settings/buyback-daily  ·  **Needs:** a rep given a buyback lead today

1. As Admin, open the Buyback Daily settings: check that it is switched on and see who is always included.
2. Give a rep who has never done buyback a buyback lead today; they should receive the email at 19:00 that same evening.

### ID 11: Report filters: City, SPOC, Type of business (Buyback / Battery Sale / Finance)

- **Login:** Admin / CEO  ·  **Where:** /admin/reports/dealer-health  ·  **Needs:** converted dealers

1. Open Dealer Health and group the summary by business type. The groups read 'Battery Sale', 'Buyback', 'Scrap', 'Other' or 'Not set', never 'battery_sale'.
2. There is no 'Finance' group.

### ID 59: Wrong metric definitions in the sales dashboard, targets and daily email

- **Login:** Admin  ·  **Where:** /reports?section=emails, /admin/settings/sales-daily  ·  **Needs:** a test lead with a short connected call

1. Log a connected call of a few seconds on a test lead; the next morning's email must count it in Engaged calls.
2. Check Block A Engaged calls MTD equals the Engaged MTD total in Block C.
3. Check Admin > Settings > Sales Daily no longer has an engaged-call duration setting.

### ID 86: Lead clock, owner clock and 'Limit passed' events

- **Login:** ISR; Sales Head  ·  **Where:** /inside-sales, lead page, /sales-head  ·  **Needs:** leads past a limit

1. In an ISR queue, press the 'Past a limit' button. Each row's chip names the limit passed, for example 'Past: First attempt (…)'.
2. Open one of those leads: the timeline shows 'Limit passed' with the limit and who it was charged to.
3. On the Sales dashboard, the Response time card lists every owner with median, slowest 1 in 10, % within limit and limits passed.

### ID 91: Lead sources analysis (Reports › Analyses)

- **Login:** Admin / CEO  ·  **Where:** Analyses > Lead sources; /ceo  ·  **Needs:** none

1. As Admin, open Reports > Analyses > Lead sources; it should open (it did not before).
2. As CEO, press 'Lead sources' on the overview's Sales funnel card; the same analysis should open.
3. On Acquisition campaigns, press 'Results by campaign'; the analysis should open grouped by campaign.

### ID 100: Digest emails and notification controls: Dealer Validation (twice daily), KYC Review, Email Notification tab, NBFC file tracker

- **Login:** Admin  ·  **Where:** /admin/settings, /admin/kyc-review  ·  **Needs:** none

1. Admin > Settings > Email Notification: the Dealer Validation (twice daily) and KYC Review digests are listed with their switches.
2. Admin > KYC review shows the NBFC file tracker.

### ID 117: Conversions credited to the lead's current owner, not the closing owner

- **Login:** Admin  ·  **Where:** lead page > Attribution; Data downloads > Leads  ·  **Needs:** a converted lead later reassigned

1. Open a Converted lead > 'Attribution': 'Closing Owner' names who held it when it was won; compare with the current Owner.
2. Sales Head > Dashboard > 'Where open leads are sitting': the conversion is in the Closing Owner's 'Converted' column, not the current owner's.
3. Reports > Data downloads > Leads: the 'Closed by' column shows the same person.

### ID 153: 'Leads in' counts every new lead, whatever the source (bulk imports included)

- **Login:** CEO  ·  **Where:** /ceo; Analyses > Lead sources; Data downloads  ·  **Needs:** none

1. Set From / To to last week on the CEO overview and note 'All leads created' in the Sales funnel card. Open Reports > Analyses > Lead sources for the same dates: 'All sources' shows the same number and there is no 'Imported in bulk' row.
2. Download Data downloads > Leads for the same dates: the number of rows matches.

### ID 185: Visits = Fresh + Repeat on the rep's basis, plus 'of which new to iTarang'; definitions on the card; click to see the dealers

- **Login:** Admin / Sales Head  ·  **Where:** Sales Daily preview; /reports?analysis=meetings  ·  **Needs:** visits logged

1. In this morning's Sales email Block B, Visits = Fresh + Repeat for every ASM.
2. Reports > Analyses > Meetings by manager x city: there is a 'New to iTarang' column, and it is never more than Fresh.
3. Data downloads > Visits: the file has 'Fresh for this rep' next to 'First visit'.

### ID 190: 'Waiting for a field visit': follow the date filter and compare periods (pending at start, new, visited, closed without visit, still waiting, % visited)

- **Login:** Sales Head  ·  **Where:** /sales-head > card > /admin/reports/needs-action/visit_overdue  ·  **Needs:** leads waiting for a visit

1. On the Sales dashboard the card reads 'x past the limit · down / up from y last period'. Change the date filter and the number changes.
2. Click the card. In 'This period against the previous one', every ASM row shows 'this | previous', and the previous period is filled in by itself. For each ASM: waiting at start + new = visited + closed, no visit + still waiting.
3. Check this morning's Sales email Block D: it has 'Awaiting field visit, past the limit' and a Total row.

### ID 192: Idle leads (Needs Attention and every idle count) ignore the follow-up date, and a reassigned lead inherits the old owner's idle days

- **Login:** Sales Head  ·  **Where:** /admin/reports/needs-attention, /leads  ·  **Needs:** idle leads

1. On Needs Attention, read the 'Counted from' column (follow-up, handed over, last worked or created) for a few rows. Set a follow-up for next week on one of them: it drops off the list and out of the Sales dashboard Idle tile.
2. Reassign a lead today. In the Leads list its Idle column shows 0d, and it is not under 'Idle past limit'.
3. Download Data downloads › Leads: 'Idle working days' for a lead matches the Leads list, and 'Idle past limit' is Yes for the leads on Needs Attention.

### ID 171: Invoice data date: show 'Invoices read up to <date>' under battery and revenue numbers; alert Admin when no new invoice arrives for 3 working days

- **Login:** CEO; Admin  ·  **Where:** CEO tiles; /admin/settings/time-limits  ·  **Needs:** none

1. CEO home: read the 'Invoices read up to' date under Revenue and compare it with the newest invoice in Invoice Ledger > Invoices.
2. If it is amber, Admins should have a 'No new invoice read' bell today.

## 4. CEO (overview, quotes, analyst)

### ID 12: Dashboard counts: dealers onboarded, KYC files shared, files disbursed, files rejected with reason - by city/state/time/dealer/financier

- **Login:** Admin / CEO  ·  **Where:** /admin/reports > Funnel; /ceo  ·  **Needs:** last month's KYC files

1. Open Reports > Report catalogue, press 'Funnel', pick last month and set Group by to 'Financier (NBFC)'; check 'Loan rejection reasons' add up to 'Files rejected' (onboarding rejections are shown separately).
2. Compare the totals with the CEO overview set to Last month.

### ID 41: Need to add a report to CEO and Admin to check account status, reorder rate, etc by account,city, sales rep

- **Login:** CEO  ·  **Where:** /admin/accounts, /admin/reports/dealer-health, /ceo  ·  **Needs:** none

1. Open Dealer Health, switch the summary to By city and read the reorder rate.
2. Open Accounts, filter No owner and assign one account to a person.
3. On the CEO overview click 'Dealers ordering': Dealer Health opens already filtered.

### ID 32: AI based summarization to summarize, daily work , lead statuses, revenue, SM performance etc

- **Login:** CEO  ·  **Where:** /ceo/analyst  ·  **Needs:** iTarang source connected

1. Ask the AI Analyst 'What was revenue last month?' and compare with the CEO revenue figure for the same month.
2. Ask 'How many batteries did we sell in September?' and compare with CEO > Batteries for September.
3. Paste a question longer than 1,200 characters: a red 'Too long' counter shows and Send stays off.

## 5. Finance & orders (invoices, margin)

### ID 5: Converted leads: move to 'Transaction Done'; nudge sales every 10 days; dealer ageing from last order (0-20 Cold, 20-30 Warm, >30 Hot)

- **Login:** CEO / Admin / Sales Head  ·  **Where:** /admin/reports/dealer-health  ·  **Needs:** a live dealer account

1. Press 'Order placed' on a dealer: it shows as Active for 15 days.
2. Dealer Health: press 'Close dealer' and type a reason: it moves to Closed, leaves Dormant and the CEO 'Dealers ordering … % of live' figure.

### ID 39: CRM read SKUs and number billed SKU, Amount by SKU excl GST (from the invoices fetched from the drive)

- **Login:** Admin / Finance  ·  **Where:** /admin/reports/invoice-ledger  ·  **Needs:** a Vyapar register export file

1. Open Invoice Ledger > By SKU for last month and compare one product's units with the invoices you know.
2. Open Item mapping: every item name marked as not mapped should be linked to a product.
3. Choose 'Vyapar sales register (weekly)', pick the file and press Preview only: check the update / new / already in Zoho (skipped) / cancelled counts; do not press Import.

### ID 62: GSTIN check-digit validation wherever a GSTIN enters the CRM

- **Login:** Admin / Finance; CEO  ·  **Where:** Invoice Ledger; Sales invoices; onboarding form  ·  **Needs:** a file with a bad GSTIN

1. Invoice Ledger > Import: preview a Vyapar file that has a wrong GSTIN; that row shows 'Fails check' and the message counts it.
2. CEO > Sales Invoices: link by hand an invoice that carries iTarang's own GSTIN to a dealer; the dealer does not get iTarang's GSTIN added.
3. Submit a dealer onboarding form with a GSTIN whose last character is wrong: it is refused.

### ID 65: Dealer account model: account owner, 'onboarded by', ownership history and Account management tab

- **Login:** Admin / CEO / Sales Head  ·  **Where:** /admin/accounts  ·  **Needs:** no-owner dealers; one with a wrong GSTIN

1. Open Accounts > No owner, tick 2 dealers and assign them to an ASM with a reason.
2. Open one of them and check Owner history shows the new owner and your reason (a first owner is dated from onboarding unless you set Effective from to today).
3. Use Correct GSTIN on a dealer with a wrong GSTIN and check the old GSTIN is still listed.

### ID 67: Onboardings not linked to their lead, so the dealer's invoices go unmatched

- **Login:** Admin  ·  **Where:** /admin/accounts  ·  **Needs:** none

1. Open Accounts and filter Came through = Direct onboarding: check a few are truly dealers with no lead.
2. Open a dealer you know came from a lead and check it shows 'Lead'.

### ID 68: Invoice credit moves with the dealer's current owner; match invoices to the account GSTIN

- **Login:** Admin  ·  **Where:** /admin/accounts; /admin/reports/sales-dashboard  ·  **Needs:** an owned dealer with last month's invoices

1. Note one dealer's revenue last month in the Sales dashboard under its owner.
2. Reassign that dealer to another person in Accounts, effective today.
3. Re-open the Sales dashboard for last month: the revenue should still sit with the old owner.

### ID 69: Unmatched invoices work list

- **Login:** CEO / Admin  ·  **Where:** /ceo/invoices > Unmatched  ·  **Needs:** an unmatched invoice

1. Open Sales invoices > Unmatched and pick an 'Unknown customer' row.
2. Click Link to account, choose the dealer, and check the row leaves the list.
3. Check the next daily sales email shows the amount not matched to a dealer.

### ID 71: Cancelled invoices keep counting; credit notes not handled

- **Login:** CEO  ·  **Where:** /ceo; Data downloads  ·  **Needs:** a credit note (none seen on real data yet)

1. CEO overview > Revenue tile: when every invoice is linked, the line under it reads 'Non-void invoices dated in the period, less credit notes'; the pace chart note says the same.
2. Data downloads > Invoices: the Source list has 'Credit notes' and the Status list has 'credit note'.
3. Leads > Export all leads: 'Business till date' for a known dealer should match Dealer Health; the 'Billing match' column says hand link, account or gstin.

### ID 72: Gross margin by month and business type

- **Login:** CEO  ·  **Where:** /ceo/finance  ·  **Needs:** an unmapped item

1. Open Revenue & costs and read last month's margin and its 'not costed' amount.
2. Follow 'Link them in Invoice Ledger › Item mapping', link one unmapped item to a product, come back and check the not-costed amount drops.

### ID 97: CEO revenue read from Vyapar invoice PDFs in Google Drive after the move off Zoho

- **Login:** CEO  ·  **Where:** /ceo/invoices > Scan Drive  ·  **Needs:** a new PDF in the Drive folder

1. CEO > Invoices: press 'Scan Drive'; new Vyapar PDFs from the Drive folder appear in the list (it also scans by itself every 6 hours).

### ID 103: Expense Drive scanner buried failed invoices for ever

- **Login:** Admin / Finance  ·  **Where:** Expenses  ·  **Needs:** a failed bill in the Drive folder

_No business check written._

### ID 147: Invoice lines are kept in two places with two product mappings, so gross margin and SKU sales disagree

- **Login:** Finance / CEO  ·  **Where:** Invoice Ledger; /ceo/batteries  ·  **Needs:** September invoices

1. Invoice Ledger > Invoices: choose September and look for invoices marked 'No item lines read'. September battery counts are complete only if none are.
2. Compare September battery units in Invoice Ledger > By SKU with CEO > Batteries to dealers for September (dealer-matched invoices: compare with By SKU's '… on dealer-matched invoices' figure); they should match.

### ID 148: Accounts screen, Dealer Health and the dealer download count dealers, 'GSTIN missing' and suggested owner by different rules

- **Login:** Admin  ·  **Where:** Data downloads > Dealers; Data health  ·  **Needs:** one dealer closed by hand

1. Data downloads > Dealer accounts: a dealer closed by hand shows Health 'Closed', with Closed reason, Closed on and Closed by filled in.
2. Pick 'No owner only' and download. The number of rows equals the Accounts 'No owner' tab, and no closed dealer is in the file.
3. CEO overview > Data health: 'Converted dealers with no GSTIN' equals the Accounts 'GSTIN missing' count.

## 3b. Managers (team view) — no session set in the sheet

### ID 156: Team performance for managers: a manager sees each team member's numbers and the team total

- **Login:** a manager  ·  **Where:** My Performance  ·  **Needs:** reporting lines set

1. Log in as a manager with reporting lines set: My Performance has a 'Showing' choice with 'Me', each team member and 'Team total'.
2. Each member's numbers equal their own My Performance page.
