### The full card list

| # | Card | Status |
|---|------|--------|
| 1 | Revenue (MTD) | ✅ Live |
| 2 | Conversion Rate | ✅ Live |
| 3 | Purchases from OEM (Business Snapshot) | ✅ Live |
| 4 | Sales to Dealer (Business Snapshot) | ✅ Live |
| 5 | Other Expenses (Business Snapshot) | ✅ Live |
| 6 | Net (MTD) (Business Snapshot) | ✅ Live |
| 7 | Recent Zoho Invoices (Business Snapshot) | ✅ Live |
| 8 | Recent Approved Expenses (Business Snapshot) | ✅ Live |
| 9 | NBFC Agreements in Signing | ✅ Live |
| 10 | Inventory Value | ⚠️ Not implemented yet |
| 11 | Outstanding Credits | ⚠️ Not implemented yet |
| 12 | Revenue Performance Trend (chart) | ⚠️ Not implemented yet |
| 13 | Procurement Overview | ⚠️ Not implemented yet |
| 14 | Top Performing Sales Managers | ⚠️ Not implemented yet |
| 15 | HR Management | 🔗 Navigation only |

> **Flow diagrams:** Each card below has a hand-drawn Excalidraw flow diagram saved in `docs/ceo-dashboard-cards/diagrams/`. A simple text version is included inline so you can understand the flow without opening anything.

---

## 1. Revenue (MTD) ✅

**What it shows:** Total sales billed this month, taken from invoices that were synced from Zoho (the accounting tool).

**Where the code is:**
- Card on screen: `src/app/(dashboard)/ceo/page.tsx:84-90`
- Calculation: `src/app/api/dashboard/[role]/route.ts:45-55`

**How it's calculated (in simple terms):**
The system looks at all Zoho invoices dated on or after the 1st of this month, ignores any that are *void* or *draft* (cancelled or unfinished), and adds up their totals.

```ts
// route.ts:45-55
const [zohoRevenue] = await db
  .select({ revenue_mtd: sql`COALESCE(SUM(${zohoInvoices.total}), 0)` })
  .from(zohoInvoices)
  .where(and(
    gte(zohoInvoices.invoice_date, startOfMonthDateStr),          // dated this month
    sql`${zohoInvoices.status} IS NULL OR ${zohoInvoices.status} NOT IN ('void', 'draft')`,
  ));
```

The screen then divides by 1,00,000 and shows one decimal:
```tsx
// page.tsx:87
value={`₹${(Number(m.revenue_mtd ?? 0) / 100000).toFixed(1)}L`}
```

**Flow diagram:** `diagrams/revenue-mtd.excalidraw` · [Open interactive »](https://excalidraw.com/#json=DCo3rfxMrRCkivxV60oVH,aHjHs0O45j9DyHyjzdX-6A)

```
Zoho invoices ──filter: this month & not void/draft──▶ SUM(total) ──▶ revenue_mtd ──▶ ÷100000, 1 dp ──▶ "₹12.5L"
```

**Sample case:** This month there are 3 valid invoices: ₹6,00,000 + ₹4,50,000 + ₹2,00,000 = ₹12,50,000. A 4th invoice for ₹1,00,000 is marked *void*, so it is skipped. 12,50,000 ÷ 1,00,000 = 12.5 → the card shows **₹12.5L**.

---

## 2. Conversion Rate ✅

**What it shows:** Out of the leads created this month, what percentage have become *qualified*.

**Where the code is:**
- Card on screen: `src/app/(dashboard)/ceo/page.tsx:91-96`
- Calculation: `src/app/api/dashboard/[role]/route.ts:108-114` and `193-197`

**How it's calculated (in simple terms):**
Count all dealer leads created this month. Among them, count how many have a status of *qualified*. Divide the qualified count by the total and turn it into a percentage.

```ts
// route.ts:108-114
const [conversionResult] = await db
  .select({
    total_leads: sql`COUNT(*)`,
    conversions: sql`COUNT(*) FILTER (WHERE current_status = 'qualified')`,
  })
  .from(dealerLeads)
  .where(gte(dealerLeads.created_at, startOfMonthDate));   // created this month

// route.ts:193-197 — turn into a percentage (avoid divide-by-zero)
conversionRate: conversionResult?.total_leads
  ? (Number(conversionResult.conversions) / Number(conversionResult.total_leads)) * 100
  : 0,
```

> **Note:** The small green "+2.1% vs last month" under this card is a **fixed placeholder** in the UI (`page.tsx:94`), not a real comparison.

**Flow diagram:** `diagrams/conversion-rate.excalidraw` · [Open interactive »](https://excalidraw.com/#json=6T83nAUr8mb57ddmWClwC,yV-3OIyxXUETJUkOK0okEQ)

```
Dealer leads ──created this month──▶ total = COUNT(all)
                                  └─ qualified = COUNT(status='qualified')
                                       ▼
                          (qualified ÷ total) × 100 ──▶ "20.0%"
```

**Sample case:** 40 leads were created this month and 8 of them are *qualified*. 8 ÷ 40 = 0.20 → ×100 = 20.0 → the card shows **20.0%**.

---

## 3. Purchases from OEM ✅ *(Business Snapshot tile)*

**What it shows:** How much stock the company bought from the manufacturer (OEM) this month.

**Where the code is:**
- Tile on screen: `src/components/dashboard/ceo/BusinessSnapshotPanel.tsx:67-74` (fed from `page.tsx:126`)
- Calculation: `src/app/api/dashboard/[role]/route.ts:61-66`

**How it's calculated (in simple terms):**
Add up the final amount of every inventory record whose OEM invoice date is on or after the 1st of this month.

```ts
// route.ts:61-66
const [purchasesAgg] = await db
  .select({ purchases_mtd: sql`COALESCE(SUM(${inventory.final_amount}), 0)` })
  .from(inventory)
  .where(gte(inventory.oem_invoice_date, startOfMonthDate));
```

> **Note:** If the inventory table isn't being filled in, this tile naturally shows ₹0. Business Snapshot tiles use 2 decimals (`formatINR`, `BusinessSnapshotPanel.tsx:38-41`).

**Flow diagram:** `diagrams/purchases-from-oem.excalidraw` · [Open interactive »](https://excalidraw.com/#json=eLNxNobAkDmix5hKJC6iK,Zs4jyHPiOJ8TMbaBYFHiyg)

```
Inventory records ──OEM invoice date this month──▶ SUM(final_amount) ──▶ purchases_mtd ──▶ "₹18.50L"
```

**Sample case:** Two stock purchases this month: ₹10,00,000 and ₹8,50,000 = ₹18,50,000. 18,50,000 ÷ 1,00,000 = 18.50 → the tile shows **₹18.50L**.

---

## 4. Sales to Dealer ✅ *(Business Snapshot tile)*

**What it shows:** Sales billed to dealers this month. This is the **same number as Revenue (MTD)** — it simply reuses `revenue_mtd`.

**Where the code is:**
- Tile on screen: `src/components/dashboard/ceo/BusinessSnapshotPanel.tsx:75-82`
- Wired up: `page.tsx:127` passes `salesMtd={Number(m.revenue_mtd ?? 0)}`
- Calculation: same as Card 1 — `route.ts:45-55`

**How it's calculated (in simple terms):**
There is no separate calculation. The Revenue (MTD) figure (sum of valid Zoho invoices this month) is passed into the snapshot as "Sales to Dealer."

```tsx
// page.tsx:125-128
<BusinessSnapshotPanel
  purchasesMtd={Number(m.purchases_mtd ?? 0)}
  salesMtd={Number(m.revenue_mtd ?? 0)}        // ← same value as the Revenue card
  otherExpensesMtd={Number(m.other_expenses_mtd ?? 0)}
```

**Flow diagram:** `diagrams/sales-to-dealer.excalidraw` · [Open interactive »](https://excalidraw.com/#json=BfNA4Q17JH845_exikRnG,nUDn6F1tDj1xZ9h1Up0qEw)

```
revenue_mtd (from Card 1) ──▶ passed in as salesMtd ──▶ "₹12.50L"
```

**Sample case:** Revenue (MTD) is ₹12,50,000, so Sales to Dealer shows the same money — but in 2-decimal snapshot format: **₹12.50L**.

---

## 5. Other Expenses ✅ *(Business Snapshot tile)*

**What it shows:** Day-to-day business expenses **approved** for this month (travel, office, vendor invoices, etc.).

**Where the code is:**
- Snapshot tile: `src/components/dashboard/ceo/BusinessSnapshotPanel.tsx`
- Standalone card with its own month/year picker (E-172): `src/components/dashboard/ceo/ExpensesMtdCard.tsx` → `src/app/api/dashboard/ceo/expenses-summary/route.ts`
- Seed value for the snapshot tile: `src/app/api/dashboard/[role]/route.ts` (CEO branch, `other_expenses_mtd`)
- Shared window predicate: `approvedExpenseInWindow()` in `src/lib/dashboard/salesWindow.ts`

**How it's calculated (in simple terms):**
Add up the amounts of expense submissions that are **approved** and whose invoice date falls in the window. Pending or rejected expenses do not count.

```ts
// src/lib/dashboard/salesWindow.ts — one predicate, shared by all four readers
export function approvedExpenseInWindow(startStr: string, endStr: string | null) {
    const conds = [
        eq(expenseSubmissions.status, "approved"),
        sql`${expenseEffectiveDate()} >= ${startStr}::date`,   // COALESCE(expense_date, approved_at::date)
    ];
    if (endStr) conds.push(sql`${expenseEffectiveDate()} < ${endStr}::date`);
    return and(...conds);
}
```

> **E-216 changed the date basis.** This used to window on `approved_at` — for
> an AI-extracted row, the moment somebody imported it. Once invoices are
> scanned in bulk from a Google Drive folder that stops working: a year of
> historic bills would all land in the month the scan ran. Expenses now count
> under the date **on the bill**, falling back to the approval date for older
> rows that never captured one. See `docs/drive-expense-ingestion.md`.

**Where the rows come from:** three sources, all in `expense_submissions`:
- Staff submissions via `/expenses/submit` (`source='manual'`, needs approval)
- Invoices uploaded at `/admin/expense-tracker` (`source='ai'`, auto-approved)
- Invoices scanned from Google Drive (`source='ai'` with `drive_file_id` set, auto-approved — E-216)

**Flow diagram:** `diagrams/other-expenses.excalidraw` · [Open interactive »](https://excalidraw.com/#json=EQ7YkTmIs7s3txzgduRpL,hTvxG_IQADPETm6X3DMFLQ)

```
Expense submissions ──status = approved AND invoice date in month──▶ SUM(amount) ──▶ other_expenses_mtd ──▶ "₹1.20L"
```

**Sample case:** Two approved invoices dated this month, ₹70,000 and ₹50,000 = ₹1,20,000. A ₹30,000 expense is still *pending*, so it is skipped. A ₹90,000 invoice **dated last month** but scanned today counts under *last* month, not this one. 1,20,000 ÷ 1,00,000 = 1.20 → the tile shows **₹1.20L**.

**Related:** the department/project breakdown (`ExpenseBreakdownPanel`), the full AI ledger (`ExpenseLedgerPanel`) and the click-through drill-down all read the same table and the same window predicate.

---

## 6. Net (MTD) ✅ *(Business Snapshot tile)*

**What it shows:** Roughly how the month is going financially: sales minus what was spent on stock and other expenses. Green with an up-arrow if positive, red with a down-arrow if negative.

**Where the code is:**
- Tile + calculation are **in the screen component**: `src/components/dashboard/ceo/BusinessSnapshotPanel.tsx:50` and `93-110`

**How it's calculated (in simple terms):**
This number is worked out **on the screen, not in the database**. It takes the three snapshot tiles and does simple subtraction:

```tsx
// BusinessSnapshotPanel.tsx:50
const netMtd = salesMtd - purchasesMtd - otherExpensesMtd;
```

It then shows the size of the number with an up/down arrow depending on whether it is positive or negative.

**Flow diagram:** `diagrams/net-mtd.excalidraw` · [Open interactive »](https://excalidraw.com/#json=-YSrbLIaSFDiMR9WvZ7p_,27jVhprzNAyC7gy4ftEMYg)

```
Sales to Dealer ┐
Purchases       ├─▶ Sales − Purchases − Other Expenses ──▶ Net ──▶ green↑ if ≥0, red↓ if <0
Other Expenses  ┘
```

**Sample case:** Sales ₹12,50,000 − Purchases ₹18,50,000 − Other Expenses ₹1,20,000 = **−₹7,20,000**. Because it's negative, the tile shows a red down-arrow with **₹7.20L** (the size of the loss).

---

## 7. Recent Zoho Invoices ✅ *(Business Snapshot list)*

**What it shows:** The latest 5 invoices, with customer name, invoice number, date and amount.

**Where the code is:**
- List on screen: `src/components/dashboard/ceo/BusinessSnapshotPanel.tsx:112-141`
- Calculation: `src/app/api/dashboard/[role]/route.ts:81-92`

**How it's calculated (in simple terms):**
There's no maths here — it just fetches the 5 most recent invoices, newest invoice date first.

```ts
// route.ts:81-92
const recentInvoices = await db
  .select({ id, invoice_number, customer_name, invoice_date, total, status })
  .from(zohoInvoices)
  .orderBy(desc(zohoInvoices.invoice_date))   // newest first
  .limit(5);                                  // only 5
```

**Flow diagram:** `diagrams/recent-zoho-invoices.excalidraw` · [Open interactive »](https://excalidraw.com/#json=EDBBQCJ-9mvSZnW0yRxWm,LHQknFZ-g8G6Lx-g-d6ytw)

```
Zoho invoices ──order by date (newest first)──▶ take top 5 ──▶ list (customer · number · ₹amount)
```

**Sample case:** The newest invoices are *Sharma Motors ₹6.00L (18 Jun)*, *Verma Auto ₹4.50L (17 Jun)*, … The list shows these 5 rows; if no invoices are synced yet it shows "No invoices synced yet."

---

## 8. Recent Approved Expenses ✅ *(Business Snapshot list)*

**What it shows:** The latest 5 approved expenses, with category, who submitted it, and amount.

**Where the code is:**
- List on screen: `src/components/dashboard/ceo/BusinessSnapshotPanel.tsx:143-172`
- Calculation: `src/app/api/dashboard/[role]/route.ts:94-106`

**How it's calculated (in simple terms):**
Fetch the 5 most recently *approved* expenses, newest first, and look up the submitter's name from the users table.

```ts
// route.ts:94-106
const recentExpenses = await db
  .select({ id, category, amount, approved_at, submitter_name: users.name })
  .from(expenseSubmissions)
  .leftJoin(users, eq(expenseSubmissions.submitted_by, users.id))   // get submitter name
  .where(eq(expenseSubmissions.status, "approved"))                 // only approved
  .orderBy(desc(expenseSubmissions.approved_at))                    // newest first
  .limit(5);
```

**Flow diagram:** `diagrams/recent-approved-expenses.excalidraw` · [Open interactive »](https://excalidraw.com/#json=P2jbeHX3MmmUlqmcuBEWz,kPb_z0VvwB_5zcqPbEMBHg)

```
Expense submissions (approved) ──join users for name──▶ order by approval date ──▶ top 5 ──▶ list (category · person · ₹)
```

**Sample case:** Latest approvals are *Travel — Rohan ₹70,000* and *Office Supplies — Priya ₹50,000*. These two rows appear; if nothing is approved yet it shows "No approved expenses yet."

---

## 9. NBFC Agreements in Signing ✅

**What it shows:** Which lender (NBFC) partnership agreements are currently out for digital signature, and how many of the required signers have signed (e.g. "Signed 2/3").

**Where the code is:**
- Card on screen: `src/app/(dashboard)/ceo/page.tsx:172` and `213-260` (`NbfcSigningCard`)
- Calculation: `src/app/api/dashboard/[role]/route.ts:120-184`
- "In flight" status list: `src/components/admin/nbfc/lspStatusTone.ts:25-33`

**How it's calculated (in simple terms):**
Two steps. **First**, find up to 10 agreements whose status is "in flight" (somewhere between *sent for signature* and *fully signed* — e.g. `SENT_FOR_SIGNATURE`, `PARTIALLY_SIGNED`, `IN_PROGRESS`). **Second**, for each of those, count how many signers there are and how many have signed.

```ts
// route.ts:120-142 — step 1: agreements still being signed
const inFlightAgreements = await db
  .select({ nbfcId, nbfcShortId, legalName, agreementId, agreementStatus, ... })
  .from(nbfcLspAgreements)
  .innerJoin(nbfc, eq(nbfc.id, nbfcLspAgreements.nbfc_id))
  .where(inArray(nbfcLspAgreements.agreement_status, LSP_IN_FLIGHT_STATUSES))
  .limit(10);

// route.ts:145-160 — step 2: signed vs total signers, per agreement
.select({
  total:  sql`COUNT(*)`,
  signed: sql`COUNT(*) FILTER (WHERE ${nbfcLspAgreementSigners.signing_status} = 'signed')`,
})
```

**Flow diagram:** `diagrams/nbfc-agreements-signing.excalidraw` · [Open interactive »](https://excalidraw.com/#json=x2wf-N5TeaVZBP_geY_om,Em0UBBHBxXr-AlbKBwglZQ)

```
NBFC agreements ──status is "in flight"──▶ top 10 ──┐
NBFC signers ──count signed vs total per agreement──┘──▶ list: "Acme Finance · Signed 2/3"
```

**Sample case:** *Acme Finance* has an agreement with status `PARTIALLY_SIGNED` and 3 signers, of whom 2 have signed. The card shows a row for Acme Finance with the status badge and **"Signed 2/3."** If no agreements are out for signing, it shows the empty message.

---

## 10. Inventory Value ⚠️ *Not implemented yet*

**What it shows (intended):** The total value of stock currently held.

**Where the code is:**
- Card on screen: `src/app/(dashboard)/ceo/page.tsx:97-102`

**Current behaviour:**
The screen tries to read a field called `inventoryValue` from the API, but the CEO API **never sends this field**. So it falls back to 0, and the "−4.2% vs last month" beside it is a **hardcoded placeholder**.

```tsx
// page.tsx:97-102
<KPICard
  title="Inventory Value"
  value={`₹${(Number(m.inventoryValue ?? 0) / 100000).toFixed(1)}L`}  // m.inventoryValue is undefined → 0
  change={{ value: 4.2, period: 'vs last month', isPositive: false }} // fixed placeholder
  icon={Package}
/>
```

**Flow diagram:** `diagrams/inventory-value.excalidraw` · [Open interactive »](https://excalidraw.com/#json=jsZ-TwXy1H55pd58VtVbN,06Lj4Yma-aiSrpBhrG33Lg)

```
UI reads m.inventoryValue ──▶ API does NOT provide it ──▶ defaults to 0 ──▶ "₹0.0L" (and a fake −4.2%)
```

**Sample case:** No matter what's in stock, the card currently shows **₹0.0L** with a red "−4.2%". To make it real, the CEO API would need to add up inventory value and return an `inventoryValue` field.

---

## 11. Outstanding Credits ⚠️ *Not implemented yet*

**What it shows (intended):** Money owed to the company that hasn't been collected yet (unpaid invoice balances).

**Where the code is:**
- Card on screen: `src/app/(dashboard)/ceo/page.tsx:103-108`

**Current behaviour:**
Same situation as Inventory Value. The screen reads `outstandingCredits`, the API never sends it, so it shows 0. The "+8.4%" is a fixed placeholder.

```tsx
// page.tsx:103-108
value={`₹${(Number(m.outstandingCredits ?? 0) / 100000).toFixed(1)}L`}  // undefined → 0
change={{ value: 8.4, period: 'vs last month', isPositive: true }}      // fixed placeholder
```

**Flow diagram:** `diagrams/outstanding-credits.excalidraw` · [Open interactive »](https://excalidraw.com/#json=jZj8SBAq7Zw5Vj3KfmNh6,GMOmd9FoYy8RO7f3jAmsIg)

```
UI reads m.outstandingCredits ──▶ API does NOT provide it ──▶ defaults to 0 ──▶ "₹0.0L" (and a fake +8.4%)
```

**Sample case:** The card currently always shows **₹0.0L**. To make it real, the API could sum the unpaid `balance` on Zoho invoices and return an `outstandingCredits` field.

---

## 12. Revenue Performance Trend (chart) ⚠️ *Not implemented yet*

**What it shows (intended):** A line/area chart of revenue over time.

**Where the code is:**
- Chart on screen: `src/app/(dashboard)/ceo/page.tsx:114-121` (uses `MetricsChart` from `src/components/shared/charts.tsx`)

**Current behaviour:**
The chart reads `revenueTrend` from the API. The API never sends it, so the chart receives an empty list and draws nothing.

```tsx
// page.tsx:114-121
<MetricsChart
  title="Revenue Performance Trend"
  data={m.revenueTrend || []}   // undefined → [] → empty chart
  dataKeys={['revenue']}
  categoryKey="name"
  type="area"
/>
```

**Flow diagram:** `diagrams/revenue-performance-trend.excalidraw` · [Open interactive »](https://excalidraw.com/#json=pBAEszm0ly2uBVHrsVqDK,8KFEhYkt3KSfVS8tlRz7gg)

```
Chart reads m.revenueTrend ──▶ API does NOT provide it ──▶ [] ──▶ empty chart
```

**Sample case:** The chart area is currently blank. To make it real, the API would return a list like `[{ name: 'Jan', revenue: 1200000 }, …]` (revenue grouped by month).

---

## 13. Procurement Overview ⚠️ *Not implemented yet*

**What it shows (intended):** A quick look at purchasing — how many items are waiting for approval and the value of active procurement.

**Where the code is:**
- Card on screen: `src/app/(dashboard)/ceo/page.tsx:134-154`

**Current behaviour:**
The card reads `procurementStats.pendingApprovals` and `procurementStats.activeValue`. The API never sends `procurementStats`, so both show 0.

```tsx
// page.tsx:142 and 146
<span>{m.procurementStats?.pendingApprovals || 0} Items</span>
<span>₹{(Number(m.procurementStats?.activeValue ?? 0) / 100000).toFixed(1)}L</span>
```

**Flow diagram:** `diagrams/procurement-overview.excalidraw` · [Open interactive »](https://excalidraw.com/#json=hLu0Qb79cLl55tVdbLVY7,btT5mmTwfUHe51B5jh9dig)

```
UI reads m.procurementStats ──▶ API does NOT provide it ──▶ defaults ──▶ "0 Items" and "₹0.0L"
```

**Sample case:** The card currently shows **0 Items** pending and **₹0.0L** active. To make it real, the API would count items awaiting approval and sum the value of active procurement, returning a `procurementStats` object.

---

## 14. Top Performing Sales Managers ⚠️ *Not implemented yet*

**What it shows (intended):** A row of the best sales managers with their region and conversion rate.

**Where the code is:**
- Section on screen: `src/app/(dashboard)/ceo/page.tsx:182-208`

**Current behaviour:**
The section maps over `topSalesManagers`. The API never sends this list, so it's empty and no manager cards appear.

```tsx
// page.tsx:190
{(m.topSalesManagers || []).map((manager) => ( ... ))}   // undefined → [] → nothing rendered
```

**Flow diagram:** `diagrams/top-sales-managers.excalidraw` · [Open interactive »](https://excalidraw.com/#json=z-yjx7yaSjuC-XEVdGDiZ,iJUY4GQ4IcgbhqZHARPjMQ)

```
UI reads m.topSalesManagers ──▶ API does NOT provide it ──▶ [] ──▶ no manager cards shown
```

**Sample case:** The area under "Top Performing Sales Managers" is currently empty. To make it real, the API would rank managers (e.g. by conversion) and return a list like `[{ id, name, region, conversion }]`.

---

## 15. HR Management 🔗 *Navigation only*

**What it shows:** A promotional panel inviting the CEO to open the HR console. It is **not a metric** and fetches no data.

**Where the code is:**
- Panel on screen: `src/app/(dashboard)/ceo/page.tsx:156-170`

**How it works (in simple terms):**
It's just text and a button. The "Open Console" button links to the `/hr` page.

```tsx
// page.tsx:163-167
<Link href="/hr">
  <button>Open Console</button>
</Link>
```

**Flow diagram:** `diagrams/hr-management.excalidraw` · [Open interactive »](https://excalidraw.com/#json=nbhlnNT63I6F4sdmGc3IA,8DhpeCx5HoFBvQID62uAzg)

```
"Open Console" button ──click──▶ navigates to /hr page  (no data, no calculation)
```

**Sample case:** The CEO clicks **Open Console** and lands on the HR page. Nothing is calculated.

---

## Summary of where everything lives

| Card | UI file | Calculation (API) |
|------|---------|-------------------|
| Revenue (MTD) | `page.tsx:84` | `route.ts:45-55` |
| Conversion Rate | `page.tsx:91` | `route.ts:108-114, 193-197` |
| Purchases from OEM | `BusinessSnapshotPanel.tsx:67` | `route.ts:61-66` |
| Sales to Dealer | `BusinessSnapshotPanel.tsx:75` | reuses `route.ts:45-55` |
| Other Expenses | `BusinessSnapshotPanel.tsx:83` | `route.ts:69-79` |
| Net (MTD) | `BusinessSnapshotPanel.tsx:50` | computed on screen |
| Recent Zoho Invoices | `BusinessSnapshotPanel.tsx:112` | `route.ts:81-92` |
| Recent Approved Expenses | `BusinessSnapshotPanel.tsx:143` | `route.ts:94-106` |
| NBFC Agreements in Signing | `page.tsx:213` | `route.ts:120-184` |
| Inventory Value | `page.tsx:97` | ⚠️ none |
| Outstanding Credits | `page.tsx:103` | ⚠️ none |
| Revenue Performance Trend | `page.tsx:114` | ⚠️ none |
| Procurement Overview | `page.tsx:134` | ⚠️ none |
| Top Performing Sales Managers | `page.tsx:182` | ⚠️ none |
| HR Management | `page.tsx:156` | 🔗 navigation |
