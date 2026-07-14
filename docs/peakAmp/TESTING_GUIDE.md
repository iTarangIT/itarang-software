# Battery Buyback — Testing Guide

**For a tester who has never seen this system before.** You do not need to know the
code. Follow the steps in order. Each step tells you what to do and what you should
see. If what you see is different, that is a bug — write it down (see
[If something goes wrong](#if-something-goes-wrong) at the end).

Set aside about **90 minutes** for a full pass.

---

## 1. What this system actually does

iTarang buys old, dead or dying electric-vehicle batteries from **dealers**, and
sells them on to **scrap vendors** who recycle them. iTarang makes its money on the
difference between the two prices.

The important thing to understand — and the thing most of this testing is about —
is that **the dealer and the vendor must never learn about each other.**

- The dealer must never find out what iTarang sold their batteries for, or that a
  vendor exists at all. If they knew, they would know iTarang's profit.
- The vendor must never find out who the dealer is. If they knew, they could buy
  from that dealer directly next time and cut iTarang out entirely.

Everything else — the prices, the paperwork, the payments — exists to support that.
So when a test below says *"check that the dealer cannot see X"*, that is not a
nice-to-have. That is the business.

### The journey a deal takes

A single battery request travels through this path. You will drive it all the way
through in Test 1.

```
Dealer creates request  →  iTarang reviews it  →  they haggle over the price
       →  dealer accepts  →  iTarang adds its margin
       →  iTarang quotes scrap vendors  →  a vendor agrees
       →  purchase orders exchanged  →  batteries collected
       →  dealer invoices iTarang  →  iTarang approves it
       →  everyone gets paid  →  deal closed
```

---

## 2. Before you start

### 2.1 Get these from a developer

| What | Why you need it |
|---|---|
| The app running (a URL, e.g. `http://localhost:3000`) | Everything |
| An **admin** login | Plays iTarang staff |
| A **dealer** login | Plays the battery dealer |
| 6 or more photos of anything on your machine | The system demands photos of each battery |

#### Creating the two logins (developer does this once)

```bash
node scripts/seed-buyback-test-users.js
```

That creates both logins and prints them:

| Login | Password | Role | Lands on |
|---|---|---|---|
| `buyback.dealer@itarang.com` | `password` | dealer | `/dealer-portal/buyback` |
| `buyback.admin@itarang.com` | `password` | admin | `/admin/buyback` |

> **⚠ Developer note — these are throwaway passwords.** Do not run this against
> production. If you already have an admin/CEO login, delete the admin entry from
> the `USERS` array in the script and use your own.

**A dealer login is three things, not one**, and this is where people lose an
afternoon:

1. a **Supabase Auth** user (what the password is checked against),
2. a **`users`** row on AWS RDS with `role = 'dealer'`, **and**
3. a **`dealer_id`** on that row pointing at an **`accounts`** company.

Get (3) wrong and the dealer logs in perfectly and then cannot create a single
request — every buyback page will refuse them, because a dealer who belongs to no
company owns nothing. The script does all three.

> **Two different logins, two different browsers.** Use a normal window for the
> admin and a **private/incognito window** for the dealer. If you use the same
> window you will keep logging each other out, and worse, you may not notice that a
> page you should not be able to see was shown to you.

### 2.2 Confirm the setup is done

Ask the developer to confirm all four of these. If any is missing, **stop** — the
system will show errors that are not real bugs and you will waste your time.

- [ ] Database migrations `E-185`, `E-186`, `E-187` and `E-188` have all been applied
- [ ] The battery catalogue has been seeded (there should be ~14 battery types)
- [ ] The app is running
- [ ] Your dealer login is linked to a dealer company (not just a user account)

### 2.3 Two things that are *not* your job to test

The developer already knows about these. **Do not raise them as bugs:**

1. **There is no screen for reviewing duplicate photos.** The system detects them
   and alerts admins, but there is no page to compare them side by side. Known gap.
2. **Tax figures are missing from documents.** Every PDF says "Tax treatment
   pending". This is deliberate — the tax rules have not been decided yet.

---

## 3. Test 1 — The happy path

This is the main test. You are going to take one deal from birth to death. **Keep
this deal open in both browsers**; every later test builds on it.

Write down the **request number** the system gives you (it looks like `BB-1025`).
You will need it constantly.

### Part A — The dealer creates a request

**As the DEALER** (incognito window):

1. Go to **`/dealer-portal/buyback`**, then click **New request** (or go straight to
   `/dealer-portal/buyback/new`).

2. Click **`+ Add Battery`**. Choose a battery type from the dropdown.
   - ✅ **Expect:** the voltage and capacity fill in *by themselves* and cannot be
     edited. An expected price per unit appears.
   - ❌ **Bug if:** you can type over the voltage or capacity.

3. Set the quantity to **3**. Leave the condition as **Working**.

4. Click **`+ Add Battery`** again. Pick a **different** battery type, quantity
   **2**, and change the condition to **Dead**.
   - ✅ **Expect:** the expected price *drops* when you switch to Dead. Dead
     batteries are worth less.

5. Upload photos. Each battery line needs **at least 5**.
   - ✅ **Expect:** while you have fewer than 5, a counter shows amber and says
     something like *"Minimum 5 required"*. At 5 it turns green.

6. Fill in the **provenance** (where the batteries came from) for both lines. Choose
   either *Owner* (then fill in the previous owner's details) or *Dealer own stock*.

7. Now **try to break it.** Delete a photo from one line so it has only 4, and press
   **Submit Request**.
   - ✅ **Expect: REFUSED.** It tells you which battery line is short of photos.
   - ❌ **Bug if:** it submits anyway. This is important — photos are the only
     evidence the batteries exist.

8. Put the photo back so you have 5 again, then press **Submit Request**.
   - ✅ **Expect:** it submits. You get a request number like `BB-1025`. **Write it
     down.**

### Part B — iTarang reviews it

**As the ADMIN** (normal window):

9. Go to **`/admin/buyback`**.
   - ✅ **Expect:** your new request is in the list, showing the dealer's name and
     its status.

10. Click into it. You should see the battery lines, the photos, and a row of action
    buttons: **Accept**, **Reject**, **Negotiate**, **Request Info**.

11. Click **Negotiate**. Enter a *lower* price for each battery type (say ₹200 less
    per unit than the dealer asked) and send it.
    - ✅ **Expect:** you must enter a price **for each battery type separately**.
    - ❌ **Bug if:** you can enter one single total for the whole lot. This must be
      impossible — every price is per battery type, always.

12. **Back as the DEALER:** open the request. You should see iTarang's counter-offer,
    itemised. Counter back — a bit higher than iTarang offered, a bit lower than you
    first asked.

13. **As the ADMIN:** click **Send final offer**. Set a final price per battery type.

14. **As the DEALER:** you should now see the final offer, with each battery listed
    and its price.
    - ✅ **Expect:** exactly two buttons — **Accept (YES)** and **Decline (NO)**.
    - ❌ **Bug if:** you can accept *some* battery types and reject others. It is all
      or nothing.

    Click **Accept (YES)**.

### Part C — iTarang sets its profit margin

**As the ADMIN:**

15. Find the **Margin & routing** section. Choose **Flat ₹** and enter something like
    **500**. You will see a table: what iTarang pays the dealer, plus the margin,
    equals what iTarang will ask a vendor.

16. Click **Lock margin & continue**.

> ### 🔒 STOP. This is the single most important check in the whole test.
>
> **As the DEALER**, open the request again and look at *everything* on the page —
> including the activity log at the bottom.
>
> ✅ **Expect: the dealer sees NOTHING about the margin.** No margin figure. No
> "margin" word. No mention of a vendor. No total that would let them work it out.
>
> ❌ **BUG — REPORT IMMEDIATELY** if the dealer can see the margin, the vendor, or
> the price iTarang will ask a vendor. This is the company's profit. If a dealer can
> see it, they will simply demand it.

### Part D — iTarang sells to a scrap vendor

**As the ADMIN:**

17. First you need a vendor to sell to. Go to **`/admin/buyback/vendors`** and click
    **Add vendor**. Fill in a name, a 15-character GSTIN, and **an email address you
    can actually check** (you will be looking for a real email in a moment).

18. Go back to your deal. You should now see a **Vendor board** section with **Route
    to scrap vendors**. Select your vendor and click **Email quotation to 1 vendor**.
    - ⏳ This takes a few seconds — it is building a PDF.

19. **Check that email inbox.** A quotation PDF should arrive within a minute or two.

    > ### 🔒 STOP. Open the PDF. This is the second most important check.
    >
    > ✅ **Expect:** it lists the batteries, the condition, the quantity, iTarang's
    > asking price per battery, and a collection *city and state* only.
    >
    > ❌ **BUG — REPORT IMMEDIATELY** if the PDF contains the **dealer's name, phone
    > number, GST number, email, street address or pincode**. A vendor who can
    > identify the dealer can go around iTarang entirely.

20. Back on the **Vendor board**, click **Record counter** on your vendor. Enter a
    price per battery type that is **clearly too low** (e.g. ₹1,000 each). Save.
    - ✅ **Expect:** a red warning that the bid is **below the floor**, and the
      **Agree** button is **greyed out and unclickable**.
    - ❌ **Bug if:** you can still agree. Agreeing below the floor means iTarang sells
      the batteries for less than it owes the dealer — it loses money on the deal.

21. Click **Record counter** again with a **sensible** price — a bit *above* what
    iTarang asked. Then click **Agree**.
    - ✅ **Expect:** the vendor is marked Agreed. The deal moves on.

### Part E — Paperwork and collection

**As the ADMIN:**

22. A **Purchase orders** section appears. Click **Generate** for the dealer PO. Then
    type any reference (e.g. `VPO-1`) for the vendor's PO and click **Record**.
    - ✅ **Expect:** once *both* exist, the deal moves to "POs exchanged".

23. A **Collection** section appears. Pick a date and click **Schedule**.

24. Click **Mark collected** — but here is the important part. **Record that you only
    collected 2 of the 3 working batteries** (one was missing).
    - ✅ **Expect:** the system flags a **variance** and warns you the dealer's
      payment is now on hold.

### Part F — Money

**As the DEALER:**

25. Open the request. A **Your invoice** section should appear, pre-filled with the
    prices you agreed.
    - ✅ **Expect:** you enter *your own* invoice number. You do **not** get to set
      any prices — they are already filled in and locked.

26. Click **Raise invoice**.

**As the ADMIN:**

27. In the **Money** section you will see the invoice, with each battery line marked
    ✓ matched.

28. Click **Approve & invoice the vendor**.
    - ⏳ Takes a few seconds — it is building the vendor's invoice PDF.
    - ✅ **Expect:** approved. Your vendor's email inbox gets an invoice from iTarang.

29. Now try to pay the dealer. Click **Record** on the *dealer payout* row.
    - ✅ **Expect: REFUSED.** It tells you the dealer has not yet acknowledged the
      short count from step 24.
    - ❌ **Bug if:** it lets you pay. iTarang would be paying for a battery it never
      received.

**As the DEALER:**

30. Open the request. An **amber banner** should be at the top saying *"Action needed
    — your payment is on hold"*, with a table showing **what you declared** against
    **what we collected**, and the short line highlighted in red.
    - ✅ **Expect:** you can see exactly which battery was short, and by how many.
    - ❌ **Bug if:** it just says "there was a variance" without the numbers. A dealer
      cannot agree to a count they have not been shown.

    Click **Confirm the collected count and release my payment**.

**As the ADMIN:**

31. Now click **Record** on the dealer payout row again. Fill in a bank reference, a
    date, and a proof file reference.
    - ✅ **Expect:** it works this time.

32. Try to record the payout **without** a proof.
    - ✅ **Expect: REFUSED.** A payment with no evidence is not allowed.

33. Record the **vendor receipt** the same way.
    - ✅ **Expect:** once both sides are paid, the deal becomes **Settled**.

34. Click **Close deal**.
    - ✅ **Expect:** the deal closes and reports the profit iTarang actually made.

**🎉 That is the full journey.** Now for the tests that try to break it.

---

## 4. Test 2 — The invoice trick (do not skip this)

This is the cleverest attempt to cheat the system, and the one most likely to slip
through. **Do this on a second deal** — run through Test 1 again quickly until the
dealer is about to raise an invoice.

Suppose the agreed prices were:

| Battery | Qty | Agreed price each | Total |
|---|---|---|---|
| Working | 3 | ₹5,200 | ₹15,600 |
| Dead | 2 | ₹3,000 | ₹6,000 |
| | | **Total** | **₹21,600** |

Now, **as the DEALER**, raise an invoice that moves money *between the lines* while
keeping the total identical:

| Battery | Qty | Invoiced price each | Total |
|---|---|---|---|
| Working | 3 | ₹5,500 ⬆ | ₹16,500 |
| Dead | 2 | ₹2,550 ⬇ | ₹5,100 |
| | | **Total** | **₹21,600** ← *exactly the same!* |

**As the ADMIN**, look at the invoice.

- ✅ **Expect:** the two totals are shown side by side and they **match**, but the
  system **still refuses to approve**, and marks the offending lines in red. There
  should be a message explaining that the total matching does not make it correct.
- ❌ **BUG — REPORT IMMEDIATELY** if it approves. A system that only checks the total
  can be robbed one line at a time.

Then click **Return**, and check the dealer sees the reason and can raise a fresh,
correct invoice.

---

## 5. Test 3 — What the dealer must never see

Go back to your closed deal from Test 1. **As the DEALER**, look at every single
screen and every section — especially the **activity log** at the bottom of the
request page.

Tick each one off. **Every one of these must be true.**

- [ ] No margin figure appears anywhere
- [ ] The word "vendor" does not appear anywhere
- [ ] No vendor's name appears
- [ ] The price iTarang sold for is nowhere to be found
- [ ] The activity log shows the dealer's own steps (submitted, accepted, invoiced,
      collected, paid) but **shows nothing at all about the margin or the vendor**
- [ ] The dealer can see: their own prices, their own invoice, their own payment

❌ **Any unticked box is a serious bug. Report it immediately.**

---

## 6. Test 4 — What the vendor must never see

Open the quotation PDF and the invoice PDF that were emailed to the vendor.

- [ ] No dealer name
- [ ] No dealer phone number
- [ ] No dealer GST number
- [ ] No dealer email
- [ ] No street address or pincode (city and state **are** allowed)
- [ ] No mention of what iTarang paid the dealer
- [ ] No margin

❌ **Any unticked box is a serious bug. Report it immediately.**

---

## 7. Test 5 — The other guards

Each of these is a deliberate attempt to do something the system must refuse. In
every case, **the correct result is a clear refusal with a readable explanation** —
not a crash, not a blank page, and not silent success.

| # | Try this | It must |
|---|---|---|
| 5.1 | On a **closed** deal, try to change the margin or reopen it | Refuse — the deal is finished |
| 5.2 | After the vendor has agreed, try to **reopen** the negotiation with the dealer | Refuse — iTarang has already sold the batteries |
| 5.3 | Before any vendor has agreed, try to raise a **purchase order** | Refuse — there is no one to buy from yet |
| 5.4 | Add a **second vendor** and try to mark *both* as Agreed | Refuse the second one — the batteries can only be sold once |
| 5.5 | As the **dealer**, try to open another dealer's request by editing the URL (change the ID) | Show **"not found"** — *not* "access denied" |
| 5.6 | As the **dealer**, use search and type another dealer's company name | Find nothing |
| 5.7 | Record a **payment with no proof file** | Refuse |
| 5.8 | Try to record the **same payment twice** | Refuse the second one |

> **Why 5.5 says "not found" and not "access denied":** if it said "access denied",
> the dealer would learn that the request *exists*. "Not found" tells them nothing.
> If you see "access denied" or "forbidden", that is a bug.

---

## 8. Test 6 — The other screens

Quick checks. Roughly 15 minutes.

### Catalogue — `/admin/buyback/catalog`

1. Note the price of a battery type that your **open** deal is using.
2. Change that price in the catalogue (halve it).
3. Go back to your **open** deal.
   - ✅ **Expect: the deal's price has NOT changed.** It still shows the old price.
   - ❌ **Bug if:** the deal's price moved. Editing today's catalogue must never
     rewrite a price someone already agreed to.

### Ledger — `/admin/buyback/ledger`

- ✅ **Expect:** your payments appear, money in and money out, with totals.
- ✅ **Expect:** a green **"Reconciled"** banner at the top.
- ❌ **BUG if the banner is red** ("does not reconcile"). That means the money that
  actually moved does not match the profit the system claims. Report immediately.
- Click **Export CSV** — it should download and open in Excel.

### Vendors — `/admin/buyback/vendors`

- Add a vendor, then check they appear in the "route to vendors" list on a deal.

### Bank reconciliation — `/admin/buyback/statements`

- Upload a CSV with a date, an amount and a reference. It should read the rows and
  suggest matches against payments iTarang is expecting.

### Search

- As **admin**, search your request number — it should find it.
- As **dealer**, search the same number — it should find it (it is theirs).
- As **dealer**, search a *vendor's* name — it must find **nothing**.

---

## 9. If something goes wrong

Write down all six of these. Without them a developer cannot fix it.

1. **Which login you were using** — admin or dealer
2. **The request number** — e.g. `BB-1025`
3. **The exact page URL**
4. **What you did** — the button you clicked
5. **What you expected**
6. **What actually happened** — copy the error message word for word, and screenshot it

### How to rank it

| Priority | What it means |
|---|---|
| 🔴 **Critical** | A dealer saw the margin or a vendor. A vendor saw the dealer. Money moved when it should not have. **Stop testing and tell someone now.** |
| 🟠 **High** | A guard did not refuse when it should have (any ❌ in Tests 2, 4 or 5) |
| 🟡 **Medium** | Something crashed, or an error message was confusing |
| ⚪ **Low** | Wording, layout, spelling |

---

## 10. Things that are already known — please do not report

The developer already knows about these. They are not bugs to find.

- **PDFs, emails and photo uploads have never been tested before.** You are the first
  person to try them. If a PDF fails to generate, an email never arrives, or a photo
  upload fails, that is a **genuine and useful find** — report it. It is just not a
  surprise.
- **There is no screen to review duplicate photos.** The system detects the same
  battery being sold twice and alerts admins, but there is no page to compare them.
- **Documents show no tax.** They say "Tax treatment pending" on purpose.
- **The vendor has no login.** Vendors are dealt with entirely by email. Correct.
- **Deals cannot be deleted.** By design — the history must survive.
