# iTARANG ADMIN KYC VERIFICATION WORKFLOW

> **Section:** Add after Coupon Management

---

## Table of Contents

1. [Overview](#1-overview)
2. [Case Handoff from Dealer to iTarang](#2-case-handoff-from-dealer-to-itarang)
3. [iTarang Admin Verification Queue](#3-itarang-admin-verification-queue)
4. [Admin Case Review Screen](#4-admin-case-review-screen)
5. [Verification Card System](#5-verification-card-system)
6. [Detailed Verification Cards](#6-detailed-verification-cards)
   - [Card 1: Aadhaar Verification](#card-1-aadhaar-verification)
   - [Card 2: PAN Verification](#card-2-pan-verification)
   - [Card 3: Bank Account Verification](#card-3-bank-account-verification)
   - [Card 4: CIBIL Credit Score](#card-4-cibil-credit-score)
   - [Card 5: RC to Chassis Check](#card-5-rc-to-chassis-check)
7. [Final Decision Panel](#7-final-decision-panel)
8. [Audit Log Structure](#8-audit-log-structure)

---

## 1. Overview

### Objective

After the dealer completes document upload, consent verification, and coupon validation, the lead is handed off to iTarang Admin for comprehensive KYC verification using third-party APIs and manual review.

### Core Principles

| Principle          | Description                                               |
| ------------------ | --------------------------------------------------------- |
| Admin Control      | Admin has full control over verification execution        |
| Manual API Trigger | APIs are triggered manually — not auto-run on upload      |
| Coupon Consumption | Coupon consumed when first verification API executes      |
| Supplemental KYC   | Admin can request additional documents or co-borrower KYC |
| Cost Control       | Limited API retry attempts                                |
| Final Decision     | Approve, Reject, or Request More Info                     |

### Verification Scope

| Type                  | Items                                                         |
| --------------------- | ------------------------------------------------------------- |
| **API Verifications** | Aadhaar (OTP), PAN, Bank Account, Face Match, CIBIL           |
| **OCR Extraction**    | Aadhaar, PAN, Bank Statement, Cheques, RC                     |
| **Manual Reviews**    | Document authenticity, data consistency, cross-field matching |
| **Risk Assessment**   | CIBIL score interpretation, fraud checks                      |

---

## 2. Case Handoff from Dealer to iTarang

### Trigger Conditions

The lead automatically moves to iTarang verification queue when **ALL** of the following are met:

- [ ] Customer consent completed and admin-verified
- [ ] All required documents uploaded (11/11 for loan, 3/3 for cash)
- [ ] Verification coupon validated and reserved
- [ ] Dealer clicked **"Submit for Verification"**

---

### System Actions on Handoff

**Backend API:** `POST /api/kyc/:leadId/submit-for-verification`

#### 1. Lock Dealer Editing

- Documents become read-only for dealer
- Dealer cannot upload new versions
- Only admin can request changes

#### 2. Update Lead Status

```json
{
  "kyc_status": "pending_itarang_verification",
  "submitted_for_verification_at": "NOW",
  "submitted_by": "dealerUserId",
  "dealer_edits_locked": true
}
```

#### 3. Add to Admin Queue

```json
{
  "queue_type": "kyc_verification",
  "lead_id": "leadId",
  "priority": "calculatePriority(lead)",
  "assigned_to": null,
  "created_at": "NOW",
  "status": "pending_itarang_verification"
}
```

#### 4. Store Metadata

```json
{
  "lead_id": "leadId",
  "submission_timestamp": "NOW",
  "coupon_code": "reservedCoupon.coupon_code",
  "coupon_status": "reserved",
  "documents_count": "uploadedDocs.length",
  "consent_verified": true
}
```

#### 5. Notify Admin

```json
{
  "type": "new_kyc_case",
  "leadId": "leadId",
  "customerName": "lead.fullName",
  "dealerName": "lead.dealer.name",
  "priority": "normal"
}
```

#### 6. Notify Dealer

```json
{
  "type": "kyc_submitted",
  "message": "KYC submitted. Awaiting iTarang verification.",
  "estimatedTime": "10-12 hours"
}
```

#### API Response

```json
{
  "success": true,
  "leadStatus": "pending_itarang_verification",
  "queuePosition": 8,
  "estimatedReviewTime": "10-12 hours",
  "message": "Case submitted to iTarang verification team"
}
```

---

## 3. iTarang Admin Verification Queue

**Navigation:** Admin Dashboard → KYC Verification Queue

### Queue Summary Bar

| Pending | In Progress | Requested Correction | Rejected | Approved |
| ------- | ----------- | -------------------- | -------- | -------- |
| 18      | 5           | 2                    | 1        | 24       |

### Queue Filters

`[Status ▼]` `[Dealer ▼]` `[City ▼]` `[Priority ▼]` `[Date Range]`

### Queue Table

| Lead ID          | Customer     | Contact        | Dealer               | Submitted       | Consent  | Coupon      | Status      | SLA     | Action |
| ---------------- | ------------ | -------------- | -------------------- | --------------- | -------- | ----------- | ----------- | ------- | ------ |
| ABC-2026-0000001 | Vijay Sharma | +91 9876543210 | ABC Motors, Varanasi | 26-Jul 10:30 AM | Verified | ABCVAR-0001 | Pending     | 2h 15m  | Review |
| XYZ-2026-0000002 | Rakesh Kumar | +91 9988776655 | XYZ Auto Delhi       | 25-Jul 04:00 PM | Verified | XYZDEL-0001 | In Progress | 22h 30m | Review |
| BIH-2026-0000002 | Anjali Singh | +91 9898989898 | Bihar Dealer, Patna  | 25-Jul 04:01 PM | Verified | BIHPAT-001  | Approved    | 5h 20m  | View   |

### Priority Indicators

| Indicator        | Condition             |
| ---------------- | --------------------- |
| 🔴 High Priority | Status age > 12 hours |
| 🟡 Medium        | Status age > 10 hours |
| 🟢 Normal        | Status age < 10 hours |

---

## 4. Admin Case Review Screen

**Trigger:** Admin clicks **"Review"** button on a queue entry.

### Layout

```
[← Back to Queue]                    Lead #ABC-2026-0000001 - Vijay Sharma

┌─ LEAD INFO ──────────────────────────────────┐ ┌─ DOCUMENT VIEWER ─┐
│ Name: Vijay Sharma  | DOB: XXXXXX            │ │                   │
│ Phone: +91 9876543210 | Gender: Male          │ │                   │
│ Husband/Father: XXXX                          │ └───────────────────┘
│ Permanent Address: Connaught Place, Delhi     │
│ Current Address: Connaught Place, Delhi       │
│ Product: 3W IOT 51.2V-105AH                  │
│ Vehicle: DL-3C-A-7889                         │
│ Vehicle Ownership: XXXX                       │
│ Owner Name: XXXX | Owner Contact: XXXX        │
└───────────────────────────────────────────────┘

DOCUMENTS (Quick Access – Click to View)
[Aadhaar F] [Aadhaar B] [PAN] [Photo] [Address] [RC] [Bank] [Cheques]

VERIFICATION CARDS (scroll horizontally)
[Card 1: Aadhaar] [Card 2: PAN] [Card 3: Face] [Card 4: Bank]
[Card 5: Address] [Card 6: RC] [Card 7: CIBIL] [Card 8: Phone] ...

COUPON: ABCDEL-0001 (Reserved)

FINAL DECISION
  ○ Approve   ○ Reject
  [Submit Decision]  [Save]  [Back]
```

### Key Design Rules

- All elements visible without scrolling (except verification cards)
- Document thumbnails are clickable (opens lightbox viewer)
- Coupon status visible at all times
- Decision panel always visible at bottom

---

## 5. Verification Card System

### Design Rationale

| Benefit         | Description                            |
| --------------- | -------------------------------------- |
| Cost Control    | Admin sees API cost BEFORE clicking    |
| Flexibility     | Each verification is independent       |
| Scalability     | Easy to add new verification types     |
| Better UX       | Results shown within same card         |
| Manual Override | Each card allows admin input if needed |

### Standard Card Template

```
┌─ [VERIFICATION NAME] ─────────────── Status: XXXXXXXXXXX ─┐
│                                                             │
│ 📥 INPUT DATA (Auto-filled from OCR/Lead)  [Autofill OCR] │
│ ├─ Field 1: [Value]  [✏️ Edit if needed]                   │
│ ├─ Field 2: [Value]  [✏️ Edit if needed]                   │
│ └─ Field 3: [Value]  [✏️ Edit if needed]                   │
│                                                             │
│ AVAILABLE VERIFICATIONS                       [Run API]    │
│ ┌────┬────────────┬────────────────┬──────────────────┐    │
│ │ #  │ Field Name │ Input Data     │ Document Data    │ Match │
│ ├────┼────────────┼────────────────┼──────────────────┤    │
│ │ 1  │ Field 1    │ Value from lead│ Value from API   │ ✅  │
│ │ 2  │ Field 2    │ Value from lead│ Value from API   │ ❌  │
│ └────┴────────────┴────────────────┴──────────────────┘    │
│                                                             │
│ 💬 ADMIN NOTES                                              │
│ [Text area for remarks]                                     │
│                                                             │
│ ⚡ ACTIONS                                                  │
│ [✓ Accept]  [✗ Reject]  [⚠️ Request More Docs]             │
└─────────────────────────────────────────────────────────────┘
```

### Card Status Values

| Status                      | Description                                   |
| --------------------------- | --------------------------------------------- |
| `Pending`                   | Not yet initiated                             |
| `Initiating`                | API call being prepared                       |
| `Awaiting Consent`          | Aadhaar: waiting for customer DigiLocker auth |
| `Consent Failed`            | Aadhaar: customer did not complete consent    |
| `Awaiting Response`         | API call sent, waiting for result             |
| `Response Received (200)`   | Success                                       |
| `Response Failed (400/5xx)` | API or server error                           |

### Phase 1 – Verification Cards List

1. Aadhaar Verification
2. PAN Verification
3. Bank Account
4. CIBIL Score
5. RC Verification
6. Phone Intelligence

---

## 6. Detailed Verification Cards

---

### Card 1: Aadhaar Verification

**Method:** DigiLocker (Decentro API)

#### Input Data Fields

| Field               | Source              | Editable |
| ------------------- | ------------------- | -------- |
| Aadhaar Number      | OCR from Aadhaar ID | ✏️ Yes   |
| Name                | Lead                | —        |
| DOB                 | Lead                | —        |
| Father/Husband Name | Lead                | —        |
| Address             | Lead                | —        |
| Gender              | Lead                | —        |
| Mobile              | Lead                | —        |
| Email               | Lead (optional)     | —        |

> **Manual Entry Policy:** Audit log must store `data_source = "manual" | "ocr"`

---

#### Step 1: Send DigiLocker Consent Link

```
Customer Mobile: +91 9876543210    [Send DigiLocker Link via SMS]

Link Valid For: ○ 24 hours  ○ 48 hours  ○ 72 hours
```

**What happens next:**

1. Customer receives SMS with secure DigiLocker link
2. Customer clicks link → Redirected to DigiLocker login
3. Customer logs in with Aadhaar/Mobile OTP
4. Customer authorizes iTarang to fetch Aadhaar XML
5. Document auto-fetched and displayed in admin panel

---

#### Backend: Initiate DigiLocker Flow

**Endpoint:** `POST /api/admin/kyc/:leadId/aadhaar/digilocker/initiate`

**Request Body:**

```json
{
  "leadId": "IT-2026-0000123",
  "customerName": "Vijay Sharma",
  "customerMobile": "+919876543210",
  "customerEmail": "vijay.sharma@example.com",
  "notificationChannel": "sms",
  "documentsRequested": ["aadhaar"],
  "linkValidityHours": 24,
  "adminUserId": "ADMIN-001"
}
```

**Backend Processing Steps:**

1. **Generate transaction ID**

   ```js
   const txnId = `DIGI-${leadId}-${Date.now()}`;
   ```

2. **Call Decentro DigiLocker SSO Init API**

   ```
   POST https://in.decentro.tech/kyc/digilocker/sso/init
   ```

   ```json
   {
     "reference_id": "DIGI-IT-2026-123-1722012345678",
     "redirect_url": "https://itarang.com/kyc/digilocker/callback/{txnId}",
     "purpose_message": "Aadhaar verification for battery loan application",
     "requested_documents": ["aadhaar"],
     "consent_text": "I authorize iTarang to fetch my Aadhaar from Digilocker",
     "expiry_hours": 24
   }
   ```

3. **Extract DigiLocker URL & Session ID** from Decentro response

4. **Generate short URL** (optional, for SMS)

5. **Store transaction in DB**

   ```json
   {
     "transaction_id": "txnId",
     "lead_id": "leadId",
     "session_id": "sessionId",
     "digilocker_url": "...",
     "short_url": "...",
     "requested_documents": ["aadhaar"],
     "status": "link_sent",
     "link_expires_at": "NOW + 24h",
     "notification_channel": "sms"
   }
   ```

6. **Send SMS to customer**

   ```
   Hi {customerName},
   iTarang needs your Aadhaar for loan verification.
   Please click the link below to share from Digilocker: {shortUrl}
   Link expires in 24 hours. - iTarang Team
   ```

7. **Optionally send email** (if `notificationChannel === "email" | "both"`)

8. **Update lead status:** `aadhaar_digilocker_status: "link_sent"`

**Success Response:**

```json
{
  "success": true,
  "transactionId": "DIGI-IT-2026-123-...",
  "sessionId": "SESSION-ABC123XYZ",
  "linkSent": true,
  "sentTo": { "mobile": "+919876543210", "email": "..." },
  "linkExpiresAt": "2026-07-27T11:30:00Z",
  "message": "Digilocker link sent to customer. Awaiting authorization."
}
```

---

#### Decentro API Reference

**API:** DigiLocker SSO Init  
**Endpoint:** `POST /kyc/digilocker/sso/init`

**Success Response:**

```json
{
  "status": "SUCCESS",
  "message": "Digilocker consent link generated successfully",
  "data": {
    "session_id": "SESSION-ABC123XYZ",
    "digilocker_url": "https://digilocker.gov.in/authorize?...",
    "expires_at": "2026-07-27T11:30:00Z",
    "requested_documents": ["aadhaar"]
  },
  "decentroTxnId": "DCTR1234567890"
}
```

---

#### Awaiting State UI

```
AADHAAR VERIFICATION (via DigiLocker)         Status: 🟡 Awaiting Consent

STEP 1 COMPLETED: Link Sent to Customer
WAITING FOR CUSTOMER ACTION

Transaction ID: DIGI-IT-2026-123-1722012345678
Session ID: SESSION-ABC123XYZ
Link Sent To: Mobile +91 98765XXXXX (Delivered at 11:30 AM)
Link Status: ⏳ Not Opened Yet   |   Expires: 26-Jul-2026 11:30 PM (12 hrs remaining)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CUSTOMER PROGRESS TRACKER
  ✅ Link Sent (11:30 AM)
  ○ Link Opened: Waiting
  ○ DigiLocker Login: Waiting
  ○ Consent Given: Waiting
  ○ Document Fetched: Waiting

🔄 Auto-refreshing every 10 seconds...

IF NO RESPONSE WITHIN 20 HOURS:
  [Resend Link]  [Call Customer]  [Extend Validity]

ACTIONS: [Resend Link]  [Extend Validity]  [Cancel]
```

**Auto-Refresh Logic (Frontend Polling):**

```js
useEffect(() => {
  const interval = setInterval(async () => {
    const status = await checkDigilockerStatus(transactionId);
    if (status.linkOpened) setProgress("link_opened");
    if (status.digilockerLoginComplete) setProgress("digilocker_login");
    if (status.consentGiven) setProgress("consent_given");
    if (status.documentFetched) {
      setProgress("document_fetched");
      clearInterval(interval);
    }
  }, 10000);
  return () => clearInterval(interval);
}, [transactionId]);
```

**Status Check API:**

```
GET /api/admin/kyc/:leadId/aadhaar/digilocker/status/:transactionId
```

```json
{
  "transactionId": "DIGI-IT-2026-123-...",
  "status": "awaiting_customer",
  "linkOpened": false,
  "linkOpenedAt": null,
  "digilockerLoginComplete": false,
  "consentGiven": false,
  "documentFetched": false,
  "linkExpiresAt": "2026-07-26T23:30:00Z",
  "timeRemaining": "12 hours 15 minutes"
}
```

---

#### Backend: Callback Handler (After Customer Authorizes)

**Endpoint:** `POST /api/kyc/digilocker/callback/:transactionId`

**Processing Steps:**

1. **Receive callback from Decentro**

   ```json
   {
     "reference_id": "DIGI-IT-2026-123-...",
     "session_id": "SESSION-ABC123XYZ",
     "status": "success",
     "documents": [{ "type": "aadhaar", "format": "xml", "data": "<base64>" }],
     "consent_given_at": "2026-07-26T11:45:00Z",
     "decentroTxnId": "DCTR1234567890"
   }
   ```

2. **Update transaction status** to `document_fetched`

3. **Parse Aadhaar XML** → extract:

   ```json
   {
     "uid": "123456789012",
     "name": "Vijay Sharma",
     "gender": "M",
     "dob": "15-01-1985",
     "careof": "S/O Ramesh Sharma",
     "house": "123",
     "street": "Main Street",
     "landmark": "Near Delhi Metro",
     "locality": "Connaught Place",
     "vtc": "New Delhi",
     "dist": "New Delhi",
     "state": "Delhi",
     "pincode": "110001",
     "photo_base64": "<base64-image>",
     "mobile": "+919876543210"
   }
   ```

4. **Store extracted data** in `aadhaar_verification_digilocker` table

5. **Cross-match with lead data:**
   - Name match (fuzzy, threshold > 80%)
   - DOB exact match
   - Phone match (if available in XML)

6. **Update verification status:** `success` or `failed`

7. **Notify admin** (WebSocket / push notification)

8. **Store Aadhaar photo** in `kyc_documents` for face match

**Response Status Codes:**

| Code | Meaning                                                  |
| ---- | -------------------------------------------------------- |
| 200  | Success                                                  |
| 400  | Invalid DCTL ID / Invalid Reference ID / Consent Failure |

---

#### Admin View – After Document Received

```
AADHAAR VERIFICATION (via DigiLocker)         Status: Response Received

STEP 2 COMPLETED: Document Received from DigiLocker
Transaction ID: DIGI-IT-2026-123-...
Fetched At: 26-Jul-2026 11:45 AM   |   Source: DigiLocker
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Verification Match Table:**

| #   | Field               | Input Data (Lead)     | Document Data (API)  | Match Threshold                                | Match Result |
| --- | ------------------- | --------------------- | -------------------- | ---------------------------------------------- | ------------ |
| 1   | Name                | Name from Lead        | `name`               | ≥80% Strong                                    | —            |
| 2   | Gender              | Gender (Lead)         | `gender`             | ≥80% Strong                                    | —            |
| 3   | DOB                 | DOB from Lead         | `dob`                | ≥80% Strong                                    | —            |
| 4   | Father/Husband Name | From Lead             | `S/O RAMESH SHARMA`  | ≥80% Strong                                    | —            |
| 5   | Address             | From Lead             | `proofOfAddress`     | ≥80% Strong                                    | —            |
| 6   | Mobile              | From Lead             | `hashedMobileNumber` | ≥80% Strong                                    | —            |
| 7   | Photograph          | Passport photo (lead) | Aadhaar photo (XML)  | ≥90%: Strong; 75–89%: Moderate; <75%: Mismatch | —            |

**Match Score Thresholds (Text Fields):**

- **≥ 80%:** Strong Match ✅
- **< 80%:** Weak Match ⚠️

**Match Score Thresholds (Face/Photo):**

- **≥ 90%:** Strong Match ✅
- **75–89%:** Moderate Match 🟡
- **< 75%:** Mismatch ❌

**Admin Actions:**

```
[✓ Accept Verification]   [✗ Reject Verification]   [⚠️ Request More Docs]
```

---

### Card 2: PAN Verification

#### Input Data Fields

| Field          | Source            | Editable |
| -------------- | ----------------- | -------- |
| PAN Number     | OCR from PAN card | ✏️ Yes   |
| PAN Status     | Default: Active   | —        |
| PAN Type       | Default: Personal | —        |
| Name           | Lead              | —        |
| DOB            | Lead              | —        |
| Aadhaar Number | Lead              | —        |
| Address        | Lead              | —        |
| Gender         | Lead              | —        |
| Mobile         | Lead              | —        |
| Email          | Lead (optional)   | —        |

#### Verification Match Table (After API)

| #   | Field          | Input Data             | Document Data (API)      | Match Threshold | Action       |
| --- | -------------- | ---------------------- | ------------------------ | --------------- | ------------ |
| 1   | PAN Status     | Default: Active        | `idStatus` / `panStatus` | ≥80%            | Run / Manual |
| 2   | PAN Type       | Default: Personal      | `category`               | ≥80%            | Run / Manual |
| 3   | Name           | From Lead              | `name`                   | ≥80%            | Run / Manual |
| 4   | Gender         | First letter from Lead | `gender`                 | ≥80%            | Run / Manual |
| 5   | DOB            | From Lead              | `dateOfBirth`            | ≥80%            | Run / Manual |
| 6   | Aadhaar Number | From Lead              | `maskedAadhaar`          | ≥80%            | Run / Manual |
| 7   | Address        | From Lead              | `full`                   | ≥80%            | Run / Manual |
| 8   | Mobile         | From Lead              | `mobile`                 | ≥80%            | Run / Manual |

> **Manual Entry Policy:** Audit log must store `data_source = "manual" | "ocr"`

**Admin Actions:**

```
[✓ Accept]   [✗ Reject]   [⚠️ Request More Docs]
```

---

### Card 3: Bank Account Verification

#### Input Data Fields

| Field               | Source     | Editable |
| ------------------- | ---------- | -------- |
| Account Holder Name | Lead / OCR | ✏️ Yes   |
| Account Number      | Lead / OCR | ✏️ Yes   |
| IFSC Code           | Lead / OCR | ✏️ Yes   |
| Bank Name           | Lead / OCR | ✏️ Yes   |
| Branch              | Lead / OCR | ✏️ Yes   |

#### Verification Options

| Method                 | Cost                     | Action    |
| ---------------------- | ------------------------ | --------- |
| Pennydrop              | ₹1.50 + Pennydrop Amount | [Run API] |
| Penniless              | ₹1.50                    | [Run API] |
| Pennydrop (Name Match) | ₹1.50 + Pennydrop Amount | [Run API] |

#### Verification Results (After API)

| Field                      | Value                                                        |
| -------------------------- | ------------------------------------------------------------ |
| Account Status             | Valid / Invalid / Inconclusive / NRE / Blocked / Blacklisted |
| Account Holder Name (Bank) | VIJAY SHARMA                                                 |
| Name Match                 | 95% (if applicable)                                          |
| Bank Reference Number      | 417110293521                                                 |
| Validation Message         | The account has been successfully verified.                  |

#### Business Rules

- Name match threshold: **100%**
- Cross-match with Aadhaar name
- Retry limit: **3 attempts**

**Admin Actions:**

```
[✓ Accept]   [✗ Reject]   [⚠️ Request More Docs]
```

---

### Card 4: CIBIL Credit Score

#### Input Data Fields

| Field   | Source |
| ------- | ------ |
| Name    | Lead   |
| PAN     | Lead   |
| DOB     | Lead   |
| Mobile  | Lead   |
| Address | Lead   |

#### Verification Options

| Report Type           | Cost   | Action       |
| --------------------- | ------ | ------------ |
| Credit Score Only     | ₹4.00  | [Get Score]  |
| Credit Report Summary | ₹20.00 | [Get Report] |

#### Score Results

```
CIBIL SCORE: 780

Risk Category: LOW
Credit Report ID: CIBIL-20260726-ABC123
Generated: 26-Jul-2026 11:30 AM
```

**Score Interpretation:**

| Score Range | Risk Level                              |
| ----------- | --------------------------------------- |
| 750+        | Excellent – Low Risk                    |
| 700–749     | Good – Low Risk                         |
| 650–699     | Moderate – Medium Risk                  |
| < 650       | Poor – High Risk → Co-borrower required |

#### Summary Data (Full Report Only)

| Metric                     | Value                      |
| -------------------------- | -------------------------- |
| Active Loans               | 2                          |
| Total Outstanding          | ₹1,50,000                  |
| Credit Utilization         | 35%                        |
| Payment Defaults           | 0                          |
| Recent Enquiries (30 days) | 1                          |
| Oldest Account Age         | 8 years                    |
| Credit Mix                 | 70% Secured, 30% Unsecured |

**Admin Actions:**

```
[✓ Accept]   [✗ Reject]   [⚠️ Need Co-Borrower KYC]
```

---

### Card 5: RC to Chassis Check

#### Input Data Fields

| Field     | Source               | Editable |
| --------- | -------------------- | -------- |
| RC Number | OCR from RC document | ✏️ Yes   |

**Action:** `[Initiate Verification]`

#### Verification Match Table

| #         | Input Field         | Document Data (API) |
| --------- | ------------------- | ------------------- |
| RC Number | RC Number from Lead | `chassisNumber`     |

**Admin Actions:**

```
[✓ Accept]   [✗ Reject]   [⚠️ Request More Docs]
```

---

## 7. Final Decision Panel

> **Design Rule:** Always visible at the bottom of the Case Review Screen.

```
FINAL DECISION
  ○ Approve
  ○ Reject

  [Submit Decision]   [Save]   [Back]
```

---

## 8. Audit Log Structure

```sql
CREATE TABLE kyc_data_audit (
  id           INT           PRIMARY KEY,
  lead_id      INT,
  field_name   VARCHAR(50),
  field_value  VARCHAR(200),
  data_source  ENUM('ocr', 'api', 'manual'),
  entered_by   INT,          -- Admin user ID
  entered_at   TIMESTAMP,
  reason       TEXT          -- Why manual entry was needed
);
```

---

_End of iTarang Admin KYC Verification Workflow BRD_

