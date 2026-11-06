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

Checked and left (3 Nov): CEO overview captions (one line each, numbers interpolated). Dealer Health and the
Expense tracker were done on 5 Nov (below). When the audit sheet's 23 rows are shared, compare
them against this list.

## Aditya's sheet rows, own pass (5 Nov)

The audit sheet's 23 rows were still not received, so this pass worked from the three layout rows the task sheet
names (Dealer Health actions menu and columns, Revenue & costs duplicate block, Expense tracker settings) and a
second scan of the eight pages. Long rules moved behind an "i"; no figure, filter or API changed.

| Page | Was | Now |
|---|---|---|
| Dealer Health (table) | Unlabelled last column; "Bucket", "Days since", "Revenue 90d", "Avg reorder (d)"; empty row spanning 10 of 11 columns | "Actions"; "Health", "Days since order" (with "since won, no order yet" when there is no order), "Revenue (90 days)", "Days between orders"; empty row spans the table |
| Dealer Health (texts) | 42-word subtitle; 31-word GSTIN line; 30-word reorder-rate line; 33-word "Order placed" line | One line each + i |
| Revenue & costs | Business snapshot repeated the net strip's three figures with its own period picker (two different numbers possible on one page); second "Review expenses" link | The net strip is the only copy, its tiles open the same drill-downs; the panel keeps the manual sales upload and the recent lists ("Recent Zoho invoices (before Vyapar)") |
| Revenue & costs | 60-word gross margin note; 29-word "Showing the most recent…" | One line + i |
| Expense tracker | Env names (GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY) on screen; raw Drive folder id under each folder; "service account"; "(N unchanged, not re-read)"; "run the E-218 backfill"; "Download"; 31-word subtitle; 74-word "Could not be imported" note | "Google Drive is not connected on this server. Ask the developer to connect it."; folder id in the hover title; "the CRM's Google account"; "(N already read)"; "Not classified yet"; "Download Excel + PDFs"; one line + i |
| Targets | 187-word introduction | "CEO sets targets → Sales Head adds a stretch and pushes → each person accepts." + i (full rule) |
| CEO overview (revenue pace) | 29+ word caption | The target line + i |
| Sales invoices | Migration file name on screen; "Zoho Invoice API"; 34-word unlinked line | "…not available on this server yet"; "From Zoho, before the move to Vyapar"; one line + i |
| Accounts Receivable (upload) | 41-word instructions | One line + i |
| Sales dashboard | Scorecard caption (60+ words), house-login steps (48), ISR note, targets note (56), Engaged/WhatsApp (33), Visits (79) | One line each + i |

The "Checked and left" note above was wrong for Dealer Health and the Expense tracker; both are covered here.
The H1 "AI Expense Tracker" stays: the menu uses the same name.
