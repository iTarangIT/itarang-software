# CEO dashboard — sorting, negative realization, expense department fix

**Date:** 2026-08-01
**Scope:** `/ceo` dashboard and the expense classification pipeline behind it.

Four requests, three of them UI and one a data-correctness bug.

---

## 1. Sortable columns on every CEO table

### Problem

None of the tables on `/ceo` can be reordered. The Total Expense drill-down
arrives sorted by effective date descending and stays that way, so answering
"what was our largest invoice this quarter" means reading every page.

### Design

One shared module, `src/components/shared/TableSort.tsx`:

- `useTableSort(specs)` holds `{ key, dir } | null` and returns a comparator.
  Null means "server order" — the state the table opens in, so nothing about
  the first render changes.
- Click cycles: first click sorts, second reverses, third returns to server
  order. First-click direction follows the column type — `text` opens ascending
  (A→Z), `number` and `date` open descending (largest / newest first), because
  that is the question those columns are usually being asked.
- `sortRows(rows, comparator)` applies it without mutating the input.
- `<SortableTh>` renders the header button, the ▲/▼/neutral affordance and
  `aria-sort`.

Empty values (null, undefined, `""`) always sort last, in **both** directions.
A row with no invoice date is not "the earliest" — it is unknown, and letting
it head an ascending list reads as data rather than as a gap.

Ties preserve server order: `Array.prototype.sort` is stable, so the secondary
ordering is always the effective-date ordering the API applied.

### Tables covered

| Table | Sortable columns |
|---|---|
| Drill-down · expenses | Invoice #, Vendor, Dept, Bucket, Project, Date Added, Invoice Date, Amount |
| Drill-down · sales | Invoice #, Customer, Date, Qty, Status, Total |
| Drill-down · purchases | OEM Inv #, OEM, Serial, Model, Date, Status, Amount |
| Drill-down · inventory | Serial, Model, OEM, Status, Value |
| Drill-down · outstanding | Invoice #, Customer, Date, Due, Total, Balance, Overdue |
| Expense Ledger panel | Date, Vendor, Department, Bucket, Project, Added by, Amount |

Department and Bucket sort by their **label** (Operations, RM Purchase), not
the stored key (`ops`, `rm`), because the label is what is on screen.

### Sales keeps its grouping

Sales rows are line items sharing one invoice, with `_first` deciding which
cells render. Sorting them flat would scatter an invoice's products across the
table and blank out its header cells. So sales sorts **invoice groups**, then
re-flattens and recomputes `_first`.

Qty is a line-level field, so at group level it sorts by the invoice's **total**
quantity — precomputed during grouping and stated in the header's tooltip.
Product is line-level with no meaningful group aggregate, so it is not sortable.

### Row cap honesty

Sorting is client-side, the same tier as the existing pagination, and resets to
page 1. The drill-down is server-capped at 500 rows (`ROW_CAP`). Past that cap,
sorting ascending by amount shows the smallest of the newest 500 — not the
smallest overall.

The API therefore returns `capped: boolean`, and the modal states it under the
table when it is true. A silent cap under a re-sorted list reads as "this is
everything", which is exactly the failure the Pagination module's own header
comment warns about.

---

## 2. Negative realization renders below the X-axis

### Problem

`realization = revenue − expense` is negative in any loss-making bucket, but
Recharts' default numeric Y-axis domain floors at 0. A loss is clamped and the
line flattens onto the axis, so a loss and a break-even month look identical.

### Design

In `charts-impl.tsx`, give the Y-axis:

```
domain={[(dataMin) => Math.min(0, dataMin), 'auto']}
```

`Math.min(0, …)` rather than `'auto'` deliberately: with `'auto'` on both ends,
an all-positive chart lifts its baseline off zero and bar *lengths* stop being
proportional to their values. This keeps zero as the floor until something
actually goes below it.

A `<ReferenceLine y={0}>` marks the crossing, since the axis line itself is
hidden (`axisLine={false}`).

Applied to the composed, bar and line variants — every chart that can carry a
derived series.

Revenue and Expense stay as positive bars: they are magnitudes, and the card
labels them as such. Only Realization crosses.

---

## 3. Tech department is over-stated by RM purchases

### Problem

Trontek battery invoices — raw material, ~₹4.6L of the visible window — are
filed under the **Tech department**. Tech reads ₹38.42L against Operations'
₹75K, which is not what either budget actually spent.

Root cause is a design decision made in E-218 and then taught to the model.
`extractInvoice.ts` and `classifyBucket.ts` both carry the example:

> "a battery order raised by the tech team is department tech but bucket rm"

The bucket half is right — a battery *is* RM Purchase. The department half is
what puts component spend on the Tech budget line.

### Design

Fixing only the prompt leaves ~200 existing rows wrong; fixing only the data
lets the next Drive scan re-create the problem. All three parts ship together.

**a. Prompts.** Both system prompts state the rule explicitly: the Tech
department is software, SaaS, cloud and IT spend only; raw material and
components belong to Operations. The misleading example is replaced.

**b. `src/lib/expenses/departmentRules.ts` + `resolveDepartment()`**, mirroring
the existing `resolveBucket` precedence — deterministic rules beat the model,
because a vendor that drifts between departments between scans makes the
month-on-month comparison lie, and because a rule fixes every past and future
invoice from that vendor at once.

The invariant: **bucket `rm` ⇒ never department `tech`** → Operations. Plus an
explicit vendor override map for the known RM suppliers, so a battery invoice
lands correctly even before its bucket is resolved.

Wired into every write path that sets a department: the Drive scanner, the bulk
AI import and the single manual AI upload.

**c. `drizzle/E-224_expense_department_rm_reclass.sql`** — idempotent backfill
of `department='tech' AND bucket='rm'` → `'ops'`, reporting the affected count.
Data-only, no DDL. Re-running it is a no-op.

### A second bug, found while verifying (a)–(c) against the data

Measuring the reclass against database-1 turned up a smaller error underneath
it. `bucketRules.ts` has a deliberately broad `electronics -> rm` catch-all —
the safety net for the next unnamed "X Electronics" component supplier — and it
was also swallowing consumer-electronics **retailers**: a ₹24,999 Samsung
"Mobile Phone" and two Dawntech televisions, all bucketed `rm`.

Left alone the new department rule would have moved those three off the Tech
budget as raw material, which is the opposite of the point. They are IT
hardware, which is what the tech bucket is for. So:

- `VENDOR_BUCKET_RULES` now lists named retailers **ahead of** the catch-all —
  the one place order in that array matters, documented there and pinned by a
  test.
- E-224 gained a step 1 that re-buckets those rows before the department move,
  guarded by `bucket_source <> 'manual'` so a human's correction still wins.

### Measured effect

Against database-1, before applying: 97 rows / ₹2,20,35,690.63 sit at
`department='tech' AND bucket='rm'`. Approved spend by department moves
`tech` ₹2,28,75,426 → ₹8,81,732 and `ops` ₹16,76,544 → ₹2,36,70,238.

Admin corrections via `PATCH /api/admin/ai-expenses/[id]` still win at any
time — the rule engine only decides what a row is *created* as.

---

## 4. Remove the "Net · this month" card

The `net-mtd` block in `BusinessSnapshotPanel`, its `netMtd` computation and the
now-unused `TrendingUp` / `TrendingDown` imports.

`tests/e2e/zoho-integration.spec.ts:81` asserts the card is visible; that
assertion goes with it, or the suite fails on a requested change.

---

## Verification

- `npm run type-check` and `npm run lint`, filtered to the touched files —
  the baseline is already red on an unrelated spec (see `verify_baseline_red`).
- `npx vitest run src/lib/expenses` for the new department-rule unit tests
  alongside the existing `bucketRules.test.ts`.
- E-224 applied via pgAdmin, then the Total Expense drill-down re-read to
  confirm Tech no longer carries the Trontek rows.
