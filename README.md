Hola!
This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).
 hello  world!!
## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.



NBFC Portal → Lead Intelligence (left sidebar) → click a row to open the lead detail drawer → scroll to the "Risk Actions" section → red "Flag for Recovery" button.

 - File: src/app/(dashboard)/nbfc/leads/_components/LeadsTable.tsx:251
 - It opens a confirmation dialog: src/components/nbfc-portal/FlagForRecoveryDialog.tsx
 - The dialog POSTs to /api/nbfc/actions/flag-for-recovery → which creates the needs_inspection pipeline row (the start of everything we walked through).

 The cast of our example

  - Borrower: Ramesh, who took a loan from "iTarang Finance" to buy an e-rickshaw battery.
  - Battery: serial BAT-7788, originally worth ₹1,00,000.
  - Ramesh stopped paying EMIs for months. The NBFC has now physically taken the battery back.

  The whole journey is just a battery moving through 5 boxes (stages):

  Needs Inspection → Refurbishable → Ready for Auction → Resold
                   ↘ Scrap (dead end)

  Example - Think of it like a returned phone at a shop: first we inspect it, then decide "fix & resell" or "throw away", then put it on the shelf for buyers, then
  someone buys it.
 ----
  STAGE 1 — The battery enters the pipeline ("Flag for Recovery")

  Nothing happens automatically. A human at the NBFC clicks "Flag for Recovery" on Ramesh's loan.
  The system then:
  - Stamps Ramesh's loan as "flagged for recovery" (this can never be undone — it's permanent).
  - Creates a new row in the recovery pipeline for battery BAT-7788 at stage needs_inspection.

  👉 This is the moment your dashboard counter moves. Right now your screen says "Recovery in Motion: ₹0 · 0 batteries" because no one has flagged anything — the
  pipeline is empty. The instant Ramesh's battery is flagged, it becomes "1 battery".

  ▎ Simple analogy: a customer returns a product. You put it in the "to be checked" tray. The tray now has 1 item.
 ---
 STAGE 2 — Battery Evaluation (the 3-step form)

 A technician opens battery BAT-7788 (sitting in Needs Inspection) and fills a 3-step form:
 Step 1 – Technical health:
  - State of Health (SOH) = 80% (this is the key number — how much life is left)
  - Physical condition = Fair, BMS = Healthy, IoT = Online

  Step 2 – What do we do with it?
  - Decision = "minor repair" (not scrap)
  - Estimated repair cost = ₹3,000

  Step 3 – Pricing:
  - Original value = ₹1,00,000
  - Reject? = No

   Now the system automatically calculates a starting auction price using a fixed rule based on SOH:

  ┌──────────────────────┬────────────────────────────────┐
  │ Battery health (SOH) │     Price = % of original      │
  ├──────────────────────┼────────────────────────────────┤
  │ Above 85%            │ 67.5%                          │
  ├──────────────────────┼────────────────────────────────┤
  │ 70%–85%              │ 57.5% ← Ramesh's battery (80%) │
  ├──────────────────────┼────────────────────────────────┤
  │ Below 70%            │ 40%                            │
  ├──────────────────────┼────────────────────────────────┤
  │ Rejected / scrap     │ ₹0                             │
  └──────────────────────┴────────────────────────────────┘

   So BAT-7788 → 57.5% × ₹1,00,000 = ₹57,500 base auction price.

   And the battery automatically moves to the next box:

  - Decision was "minor repair" → moves to Refurbishable
  - (If the technician had said "scrap" or SOH was terrible, it would move to Scrap — a dead end, price ₹0, journey over.)

    ▎ Analogy: you checked the returned phone. Screen's a bit scratched but works fine (80% health). You decide "polish it and resell   for     ₹57, 500" instead of throwing it away.

 ---
  STAGE 3 — Put it up for auction ("Ready for Auction")
   After the small repair is done, an operator drags the battery card from Refurbishable → Ready for Auction.

  The moment that happens, the system automatically creates an auction listing (a "lot") in one single safe step:
  - Lot code: LOT-7A3F9C21 (auto-generated)
  - Starting price: ₹57,500 (from the evaluation)
  - Minimum bid increase: ₹1,200 (2% of base, so bids go up in sensible steps)
  - Auction runs for 7 days, then closes.

  Analogy: the polished phone goes onto the auction shelf with a ₹57,500 price tag and a "bidding ends in 7 days" sticker.

  STAGE 4 — Bidding

  Now other Dealer / buyers see LOT-7A3F9C21 on the Auction Marketplace and place bids. Live countdown timer ticks down.
  

-------------------------
WhatsApp-specific tables (new in E-167)

  1. whatsapp_onboarding_sessions — the state machine, one row per dealer phone number
  - wa_phone (unique), application_id (FK), current_state (GREETING → ASK_COMPANY_TYPE → COLLECTING_DOC → … → SUBMITTED), detected_company_type,
  expected_document_type, context (jsonb: collected answers + checklist progress), session_status, inbound/outbound timestamps. Lets a dropped chat resume.

  2. whatsapp_messages — append-only inbound/outbound message log
  - provider_message_id (UNIQUE — Meta webhook idempotency/dedupe), direction, message_type, text_body, media_provider_id/storage_path, delivery_status,
  raw_payload (jsonb). Used for audit + delivery tracking.

  Shared tables (web wizard + WhatsApp, with E-167 extensions)

  3. dealer_onboarding_applications — the main application record. WhatsApp writes here too, tagged source='whatsapp', plus new columns: wa_phone, wa_session_id
  (FK), verification_warnings, extraction_summary, dealer_confirmed_at. Holds all the actual dealer data (company, GST, PAN, owner, bank details).

  4. dealer_onboarding_documents — uploaded doc metadata + extraction. WhatsApp rows get source='whatsapp', extraction_engine='gemini', extraction_confidence,
  verification_provider. extracted_data (jsonb) holds the Gemini-parsed fields.

  Correction-flow tables (admin requests fixes, dealer replies on WhatsApp)

  5. dealer_correction_rounds — one per correction round (requested fields/docs, remarks, magic-link token).

  6. dealer_correction_items — one row per requested field/document, with before/after values for diffing.

  Flow at a glance

  First inbound message creates a whatsapp_onboarding_sessions row + a draft dealer_onboarding_applications → docs go into dealer_onboarding_documents (Gemini
  extraction) and fields fill the application → every message logged in whatsapp_messages → dealer confirms (dealer_confirmed_at set, status submitted) → any
  admin corrections use the two dealer_correction_* tables.

  Key code: src/lib/whatsapp/orchestrator.ts (state machine + writes), src/app/api/whatsapp/webhook/route.ts (ingress), src/lib/whatsapp/notifications.ts,
  src/lib/whatsapp/storage.ts.