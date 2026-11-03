# ID 215 — CEO pages wording (own audit, 3 Nov)

The wording-audit sheet's "CEO pages" tab was not available, so this is a code scan of the eight CEO pages
(CEO overview, Dealer Health, Targets, Revenue & costs, Accounts Receivable, Sales invoices, Expense tracker,
Sales dashboard) for: paragraphs of 25+ words, internal codes (E-xxx, migration, cron, BRD) and button words
that differ. Shown words only: no number, stored value or NeoDove outcome name changes. Long rules moved
behind an "i" (the shared `components/ui/info-tip`), never deleted.

| Page | Was | Now |
|---|---|---|
| Accounts Receivable (header) | 65-word paragraph on what counts | "Unpaid balance of every invoice, less the customer's credit notes, as of now." + i (full rule, now naming Vyapar too) |
| Accounts Receivable (footer) | "Payments are only seen once they are recorded on the invoice (Zoho balance, or amount paid on a Drive invoice)…" (wrong since the Vyapar upload) | "Money collected shows as owed until the next Vyapar Sale Report upload." |
| Accounts Receivable / CEO card | Source line named "amounts entered on each invoice" | Names the weekly Vyapar Sale Report; red line after 8 days without one (ID 200 g) |
| Revenue & costs (net strip) | 28-word note | "Counts stock bought, not stock sold." + i |
| Revenue & costs (gross margin) | "…not set up on this database yet (migration E-322)…" | "Gross margin is not available on this server yet." |
| Sales dashboard (Response time, Speed) | "Lead clocks are not set up on this server yet (migration E-337)." | "Response times are not available on this server yet." / "…could not be loaded just now. Try again in a minute." (ID 218) |
| Sales dashboard (Hot / warm / cold) | 29-word paragraph | "Open leads by rating and days held." + i |
| Sales invoices | "Export CSV" | "Download CSV" (the CRM's fixed word) |
| Targets (correction note) | 25 words | "Targets stay in force and the 48-hour clock keeps running. Change the stretch, then push again." |
| Dealer Step 5 (ID 220) | "BRD §3.5: dispatched → sold runs daily via cron at 04:00 UTC…" | "A dispatched sale is marked delivered automatically the next morning, or press this button." |

Checked and left: CEO overview captions (one line each, numbers interpolated), Dealer Health, Expense tracker
(no paragraph over 25 words, no internal code on screen). When the audit sheet's 23 rows are shared, compare
them against this list.
