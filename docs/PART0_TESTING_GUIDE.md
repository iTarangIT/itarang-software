# iTarang CRM — Part 0 Testing Guide (UAT)

This guide walks you through testing **every feature** of the new Part 0 lead-
management system. You do **not** need to be technical — just follow the steps,
click what it says, and check whether you see what the guide says you should.

Each test ends with a **Result** box. Tick **Pass** if it worked, **Fail** if it
didn't (and write a note about what went wrong).

---

## Before you begin

### One-time setup — *ask a developer to do this once*

1. Start the app (`npm run dev`) and keep it running.
2. Confirm all database migrations have been applied (you said these are done ✅).
3. Load the practice data — run these three commands once:
   ```
   node scripts/seed-inside-sales-test-leads.js
   node scripts/seed-asm-test-data.js
   node scripts/seed-admin-test-data.js
   ```
   This creates practice dealer leads, escalations, and sample records so every
   screen has something to show.

### The four test logins

You will log in and out as four different people. Open the app, and on the
login page enter the email + password.

| Who | Email | Password | Lands on |
|---|---|---|---|
| **Sweety** — Inside Sales Rep | `sweety.itarang@gmail.com` | `password` | My Queue |
| **ASM** — Area Sales Manager | `asm.itarang@gmail.com` | `password` | My Visits |
| **Anirudh** — Admin / Ops | *your Anirudh (sales_head) login* | *your password* | Sales Head dashboard |
| **CEO** | *your CEO login* | *your password* | CEO dashboard |

> **To switch users:** click your name/avatar at the bottom-left of the sidebar
> and choose **Log out**, then log in as the next person.

### How to read this guide

- **Log in as** — who you should be logged in as for this test.
- **Steps** — do these in order.
- **You should see** — what a correct result looks like.
- Words in **bold** are buttons or links to click.

---

# PART 1 — The Inside Sales journey (Sweety)

This is the day-to-day work of an Inside Sales rep: picking up leads, recording
calls, sharing prices, and moving the deal forward.

### Test 1.1 — See your work queue

**Log in as:** Sweety

**Steps:**
1. After login you land on **My Queue** (the Inside Sales workspace).
2. Look at the row of tabs near the top: **My Open Leads**, **Follow-ups Today**,
   **Unassigned (Claim)**, **Team (Read-only)**, **My Closed Leads**.
3. Click each tab.

**You should see:** Each tab shows a list of dealer leads (or an empty-state
message). Tab numbers/counts update. No errors.

**Result:** ☐ Pass ☐ Fail — Notes: ________________

---

### Test 1.2 — Claim a new lead

**Log in as:** Sweety

**Steps:**
1. Click the **Unassigned (Claim)** tab.
2. Click any lead row to open it.
3. At the bottom action bar, click **Claim Lead** and confirm.

**You should see:** A success message. The lead is now yours — its status
becomes **Assigned**. It now appears under **My Open Leads**.

**Result:** ☐ Pass ☐ Fail — Notes: ________________

---

### Test 1.3 — Log a touchpoint (record a call)

**Log in as:** Sweety

**Steps:**
1. Open one of **your** open leads (from **My Open Leads**).
2. Click **Log Touchpoint** in the bottom action bar.
3. Choose type **Inside Sales Call**, call status **Connected**, write a remark
   (e.g. "Spoke to dealer, interested"), tick **Engaged** if not already ticked.
4. Click **Save**.

**You should see:** The call appears instantly in the **history** list on the
left. If the lead was "Assigned", it can now move to **Under Discussion**.

**Result:** ☐ Pass ☐ Fail — Notes: ________________

---

### Test 1.4 — Update commercials (share a price)

**Log in as:** Sweety

**Steps:**
1. On the same lead, click **Update Commercials**.
2. Choose event type **Quote Issued**, enter a **Price Quoted** (e.g. 250000).
3. Click **Save**.
4. Open **Update Commercials** again, choose **Final Terms**, and enter a
   **Final Price** (e.g. 240000). Save.

**You should see:** The right-hand **Commercials** section shows the latest
quote and the final price. The status can now reach **Commercials Finalised**.

**Result:** ☐ Pass ☐ Fail — Notes: ________________

---

### Test 1.5 — Mark a lead Lost (with a high-impact reason)

**Log in as:** Sweety

**Steps:**
1. Open a *different* open lead (one you don't mind closing).
2. Click **Mark Lost**.
3. Pick the reason **Business Closed**.
4. A confirmation pop-up explains the consequence — read it, then confirm.

**You should see:** The confirmation pop-up appears for the high-impact reason.
After confirming, the lead becomes **Lost** and moves to **My Closed Leads**.

**Result:** ☐ Pass ☐ Fail — Notes: ________________

---

# PART 2 — Handing off to the field (Sweety → ASM)

### Test 2.1 — Transfer a lead to an ASM

**Log in as:** Sweety

**Steps:**
1. Open a lead that has a **Final Price** set (from Test 1.4).
2. Click **Transfer to ASM**.
3. Pick an ASM from the dropdown (if the list is empty, tick **Show all ASMs**).
4. Choose a reason and visit type, write handoff notes, click **Submit**.

**You should see:** A success message. The lead's status becomes **Transferred
to ASM** and it leaves your queue.

**Result:** ☐ Pass ☐ Fail — Notes: ________________

---

### Test 2.2 — The ASM sees the handed-off lead

**Log in as:** ASM

**Steps:**
1. After login you land on **My Visits**.
2. Click the **My Active Visits** tab.

**You should see:** The lead Sweety just transferred (plus the seeded practice
leads) appears in the list.

**Result:** ☐ Pass ☐ Fail — Notes: ________________

---

### Test 2.3 — Log a field visit

**Log in as:** ASM

**Steps:**
1. Open a lead from **My Active Visits**.
2. Click **Log Visit** (the main green button).
3. Set visit status **Visited**, outcome **Productive**, write remarks.
4. For **Next Action** choose **Schedule next visit**, pick a next date.
5. Click **Save**.

**You should see:** The visit is saved and appears in the lead's history.

**Result:** ☐ Pass ☐ Fail — Notes: ________________

---

### Test 2.4 — Visit that leads straight to closing the deal

**Log in as:** ASM

**Steps:**
1. Open another **My Active Visits** lead that has a final price.
2. Click **Log Visit**. Set status **Visited**, outcome **Productive**.
3. For **Next Action** choose **Convert**. Click **Save**.

**You should see:** The visit saves, then the **Mark Converted** form opens
automatically. Confirm it. The lead becomes **Converted**.

**Result:** ☐ Pass ☐ Fail — Notes: ________________

---

# PART 3 — Closing the deal & onboarding

### Test 3.1 — Mark Converted hands the deal to onboarding

**Log in as:** Sweety **or** ASM (whoever owns a finalised lead)

**Steps:**
1. Open a lead in **Commercials Finalised** or **Transferred to ASM** that has a
   **Final Price**.
2. Click **Mark Converted** and confirm.

**You should see:** A success message; the lead's status becomes **Converted**
(green). Behind the scenes a draft onboarding application is created for the
onboarding team.

> **Developer check (optional):** in the database, a row now exists in
> `dealer_onboarding_applications` with `originating_dealer_lead_id` = this
> lead's id, and `proposed_deal_value` equal to the final price.

**Result:** ☐ Pass ☐ Fail — Notes: ________________

---

# PART 4 — When something needs attention: Escalations

This flow involves **three people**: the rep raises a concern, the CEO advises,
the admin resolves.

### Test 4.1 — Raise an escalation

**Log in as:** Sweety (or ASM)

**Steps:**
1. Open any **open** lead you own.
2. Click **Escalate** in the action bar.
3. Pick a reason, set urgency to **Urgent**, write at least a sentence or two of
   notes, click **Submit**.

**You should see:** A success message. The lead now shows an **escalation
banner**.

**Result:** ☐ Pass ☐ Fail — Notes: ________________

---

### Test 4.2 — CEO gives advice on the escalation

**Log in as:** CEO

**Steps:**
1. In the left sidebar, under **PART 0 OVERSIGHT**, click **Escalations**.
2. Open a **Pending** escalation.
3. Click **Add CEO Advisory**.
4. Write a comment, choose a recommendation (e.g. *Recommend Reassign*), write a
   line of guidance, click **Save Advisory**.

**You should see:** A purple **CEO Advisory** panel now appears on the
escalation showing your comment and recommendation.

**Result:** ☐ Pass ☐ Fail — Notes: ________________

---

### Test 4.3 — Admin resolves the escalation

**Log in as:** Anirudh (Admin)

**Steps:**
1. In the left sidebar, under **LEAD MANAGEMENT**, click **Escalations**.
2. Open the **same** escalation the CEO advised on.
3. Confirm you can see the CEO's recommendation near the top.
4. Click **Resolve Escalation**, choose **Return to Owner with Guidance**, write
   resolution notes, click **Resolve**.

**You should see:** The escalation moves to **Resolved**. The CEO advisory and
your resolution notes are recorded.

**Result:** ☐ Pass ☐ Fail — Notes: ________________

---

# PART 5 — The Admin command centre (Anirudh)

Log in as **Anirudh**. In the sidebar you'll see a **LEAD MANAGEMENT** section —
this is the Part 0 admin area. Click **Ops Dashboard** to begin.

### Test 5.1 — The dashboard

**Steps:**
1. Open **Ops Dashboard**.
2. Look at the top row of **metric tiles** (Unassigned Queue, Conversion Rate,
   Pending Escalations, etc.).
3. Look at the **Team Performance** table and click a column heading to sort.
4. On the right, click any **Alert Panel** to expand it.

**You should see:** Tiles show numbers; the team table sorts; alert panels
expand to show lead lists. Concerning numbers are tinted amber/red.

**Result:** ☐ Pass ☐ Fail — Notes: ________________

---

### Test 5.2 — Filter the dashboard

**Steps:**
1. In the **Filters** bar, pick a **Status** (e.g. *Under_Discussion*).
2. Click **Apply**.
3. Click **Clear** to remove the filter.

**You should see:** The dashboard numbers change to reflect the filter, then
return to normal after Clear.

**Result:** ☐ Pass ☐ Fail — Notes: ________________

---

### Test 5.3 — Bulk actions

**Steps:**
1. On the dashboard, expand an alert panel like **No Touch > 5 working days**.
2. Tick the checkbox next to two or three leads.
3. A blue bar appears — click **Export CSV**.

**You should see:** Selecting leads shows the bulk action bar. **Export CSV**
downloads a spreadsheet of the selected leads. (You can also try **Reassign**
or **Mark Lost** here.)

**Result:** ☐ Pass ☐ Fail — Notes: ________________

---

### Test 5.4 — Settings: add an ASM territory

**Steps:**
1. Sidebar → **Settings**.
2. Open the **ASM Territories** tab.
3. Pick an ASM, type a **State** (e.g. *Maharashtra*), click **Add Territory**.
4. Open the **Holiday Calendar** tab — add a holiday (pick a date + name).
5. Open the **Assignment Config** tab — change the threshold and click **Save**.

**You should see:** The territory and holiday appear in their lists; the config
saves with a success message.

**Result:** ☐ Pass ☐ Fail — Notes: ________________

---

### Test 5.5 — Bulk upload leads from a CSV

**Steps:**
1. Create a file called `test-leads.csv` with this content:
   ```
   phone,dealer_name,city,state,segment,language
   9812345670,Test Dealer One,Pune,Maharashtra,3W,Hindi
   9812345671,Test Dealer Two,Nagpur,Maharashtra,2W,Marathi
   9812345672,Test Dealer Three,Surat,Gujarat,Battery,Gujarati
   ```
2. Sidebar → **Bulk Upload**.
3. Choose the file, click **Validate**.
4. Review the preview (3 new rows), then click **Confirm & Import**.
5. Look at the **Recent Batches** list below.

**You should see:** Validation shows 3 valid rows; after import a batch appears
in Recent Batches with a **Rollback** button. Click **Rollback** then
**Restore** to confirm both work.

**Result:** ☐ Pass ☐ Fail — Notes: ________________

---

### Test 5.6 — Reports

**Steps:**
1. Sidebar → **Reports**.
2. Click through each of the 6 report buttons (Daily Activity, Lead Funnel,
   Lost Analysis, AI Score Accuracy, Source Performance, ASM Handoff).
3. On any report, click **Export CSV**.

**You should see:** Each report draws a **chart** and a **table**. Export CSV
downloads a spreadsheet.

**Result:** ☐ Pass ☐ Fail — Notes: ________________

---

### Test 5.7 — Merge requests & onboarding dropouts

**Steps:**
1. Sidebar → **Merge Requests** — open the seeded request, click **Resolve**,
   pick an action, write notes, submit.
2. Sidebar → **Onboarding Dropouts** — this list may be empty (that's fine — it
   fills only when an onboarding application stalls or is rejected).

**You should see:** The merge request resolves and moves to the **Resolved**
tab. The dropouts page loads without error.

**Result:** ☐ Pass ☐ Fail — Notes: ________________

---

# PART 6 — The AI dialer guardrail (Module 5)

The AI dialer must **never call a dealer that the sales team is already
working**. This is mostly verified by a developer, but here is one check you
can do yourself.

### Test 6.1 — A pushed-back Lost lead becomes callable again

**Log in as:** Anirudh (Admin)

**Steps:**
1. Open **Ops Dashboard**. Find a **Lost** lead (use the filters: Status = Lost).
   *(If none exist, use a lead you marked Lost in Test 1.5.)*
2. Select it and use the bulk bar's **Push to AI Dialer** action (give a reason).
3. Open the AI Dialer screen and run a **Preview** of that lead's region.

**You should see:** After "Push to AI Dialer", that Lost lead becomes eligible
and shows up again in the dialer preview. A lead the team is actively working
(an "open" lead) does **not** appear in the preview.

> **Developer check:** with a lead set to an active status (e.g.
> `Under_Discussion`), the dialer preview count excludes it; setting it back to
> blank re-includes it. Reactivation-after-recall is confirmed during a real
> AI call run.

**Result:** ☐ Pass ☐ Fail — Notes: ________________

---

# Developer-only checks (quick database confirmations)

These need a developer with database access. They confirm the "behind the
scenes" wiring.

| Check | How |
|---|---|
| Conversion created an onboarding application | `SELECT originating_dealer_lead_id, onboarding_status, proposed_deal_value FROM dealer_onboarding_applications WHERE originating_dealer_lead_id IS NOT NULL;` |
| Urgent escalation notified the CEO | `SELECT user_id, type, title FROM notifications WHERE type='escalation_raised' ORDER BY created_at DESC;` |
| AI dialer excludes active leads | Set a test lead's `lead_status` to `Under_Discussion`, run the dialer preview — the count drops by one. |

> **Note:** the urgent-escalation alert is *recorded* for the CEO, but the app
> does not yet have a notification "bell" to display it on screen — that is a
> known small follow-up item.

---

# If a test fails

For any **Fail**, please write down:

1. **Which test** (e.g. "Test 4.3").
2. **Who you were logged in as.**
3. **What you clicked** and **what happened** instead of the expected result.
4. If you see a red error message, copy its text.
5. A screenshot if possible.

Send these notes to the development team.

---

## Coverage summary

| Area | Tests |
|---|---|
| Inside Sales rep (Module 1) | 1.1 – 1.5, 2.1 |
| ASM field work (Module 2) | 2.2 – 2.4 |
| Conversion → Onboarding | 3.1 |
| Escalations & CEO advisory (Modules 1, 3, 4) | 4.1 – 4.3 |
| Admin command centre (Module 3) | 5.1 – 5.7 |
| AI dialer guardrail (Module 5) | 6.1 |

When every box above is ticked **Pass**, Part 0 is verified end to end.
