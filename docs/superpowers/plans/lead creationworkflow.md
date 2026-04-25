# iTarang CRM — Business Requirements Document (Internal V2)

> **Source:** `CRM_BRD__internal__-_V2__24th_Feb__7_.docx` — converted to Markdown for use as Claude project context.

> **Status:** Living document. Edit in `docs/specs/CRM_BRD_V2.md`.

---

## Quick navigation

- [Part A — Dashboard & Global UI](#part-a--dashboard--global-ui)
- [Part B — Step 1: Lead Creation](#part-b--step-1-lead-creation)
- [Part C — Step 2: Customer KYC + Consent](#part-c--step-2-customer-kyc--consent)
- [Part D — Step 3: Conditional Re-verification (Supporting Docs / Co-Borrower)](#part-d--step-3-conditional-re-verification-supporting-docs--co-borrower)
- [Part E — Step 4: Product Selection (Cash & Finance split)](#part-e--step-4-product-selection-cash--finance-split)
- [Part F — Step 5: Final Approval & Sale (Finance only)](#part-f--step-5-final-approval--sale-finance-only)
- [Part G — Cash Flow streamlined path](#part-g--cash-flow-streamlined-path)

---

## Part A — Dashboard & Global UI

### Dashboard — Button Schema

## Button Functions & User Interactions

### **Top Menu Action Buttons**

- **SEARCH BAR**

Purpose: Global search across dealer's ecosystem.

Workflow:

- Click → Open global search overlay

- Real-time search (debounced API)

- Show categorized results:

- Leads

- Loans

- Assets

- Inventory

- Campaigns

- Customers

- Each result clickable → redirect to respective module page

- Search parameters supported:

- Customer Name

- Mobile Number

- Lead ID

- Loan ID

- Asset ID

- Campaign ID

- Inventory ID

- Service ticket ID

- Add:

- Recent searches

- Fuzzy search

## **2. Dealer Profile Dropdown**

## **Flow**

Click → dropdown:

- View Profile

- Change Password

- Active subscription status

- Logout

### **Main Action Buttons**

### **NEW LEAD

### **Keep Modal Flow (**Click → Create New Lead Form)

- **PROCESS LOAN (LOAN FACILITATION)**

Logic

'Payment_Method = Finance/Loan

AND

documents_uploaded = true

AND

facilitation_fee_status != PAID'

Probable screen:

Open Loan Facilitation Queue screen

- Table View:

Columns:

- Customer Name

- Mobile

- Document Status

- Company Validation Status

- Facilitation Fee Status

- Action

- Filters:

- Document Uploaded

- Under Validation

- Validation Passed

- Fee Pending

- Click "Process"

Open detailed pseudo screen:

- Uploaded Documents viewer

- Validation notes

- Fee amount payable

- Pay Facilitation Fee button

- On Fee Payment:

- Update status → FEE_PAID

- Move file to Loan Management module

- **Add Assets**

### **(**Click → Pseudo Screen)

- **VIEW (Recent Leads)**

- Displays modal with customer information, lead status, timeline, associated loans, edit options, and action buttons

- Display time since last contact with alert if >7 days

- View Lead **(**Click → Lead Page)

- **START CAMPAIGN (**Click → Pseudo Screen)

Probable Logic: Opens campaign wizard with audience selection, message composition, channel selection, and confirmation

- Pre-built segments: All Customers, Hot Leads, Pending Loans, Overdue Payments, Inactive Customers

- Custom segment builder with AND/OR logic

- Filter criteria: Lead status, Loan status, Purchase history, Last contact date, Location, Product interest

- Show estimated audience size as filters are applied

- Save custom segments for future use

### **Navigation Menu Functions**

- **LEAD MANAGEMENT (**Click → All Lead list with filters(Pseudo screen))

table view, sorting, bulk actions, Create New Lead button

- **Loan MANAGEMENT (**Click → All Loan file list with payment processed filters, post disbursal payment and actionable(Pseudo screen))

- **Deploy Asset MANAGEMENT (**Click →Deployed Asset table, filters by type payment type, product type and status, QR code generation, deployment history, maintenance tracking, battery health tracking, telemetry support (Pseudo screen))

- **Service  MANAGEMENT**

### **(**Click → Pseudo Screen)

- **ORDERS FROM OEM**

### **(**Click → Pseudo Screen)

- **INVENTORY**

### **(**Click → Pseudo Screen)

### Create New Lead_Button Schema

## Button Functions & User Interactions

## **Screen Overview**

This is the first step in a 5-step workflow for creating a new lead in the iTarang CRM system. The screen collects personal information, product details, vehicle details, and lead classification data.

---

## Part B — Step 1: Lead Creation

### Workflow Position: Step 1 of 5

Reference ID Format: #IT-2026-0000001 (Auto-generated)

Generate reference: #IT-[YEAR]-[SEQUENCE]

### **Top Menu Action Buttons**

Workflow Type: Multi-step transactional form

State: LEAD_DRAFT until final submission

- **HEADER BUTTONS **&** ELEMENTS Frontend**:

Workflow Progress Bar

**Type**: Display-only component

**Function**

- Shows: Step 1 of 5

- Highlights current step

- Non-clickable

### **Backend:**

- No API.

- Progress state derived from route /leads/create?step=1

- **Info (ℹ️) Button Frontend:**

- On click → Open help modal

- Modal shows:

- Required fields explanation

- Loan compliance guidelines

- Example formats

**Backend**: **Static content or fetched: GET /api/help/lead-step-1

- **Auto-fill from ID **[**[**Document Link**](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-document-forensics-document-extraction)**] Frontend**

- Click → Open 'Auto fill customer details pop up' modal

- User click:

- Aadhaar Front: To upload image in png, jpeg and PDF

- Aadhaar Back: To upload image in png,jpeg and PDF

- Start scanning: CALL API initiate OCR API, Both the uploaded images run through OCR and extract Name, Husband/Father Name, Date of Birth, Current Address

- Validation:

- Add File Size & Format Validation

- Max file size: 5MB per image

- Allowed formats: PNG, JPEG, PDF

- Image quality check (min 300 DPI recommended)

- Show upload progress bar

- OCR Error Handling

- What if OCR fails to extract data?:

- Show error message: 'Could not read document. Please ensure image is clear'

- Allow manual entry fallback

- Retry option

- Support for poor quality scans

	**Backend:**

- POST /api/leads/autofillRequest: { idType: 'aadhaar|pan|customer|lead', idValue: 'string' }Response: { success: boolean, data: { fullName, fatherName, dob, address, phone, etc. }, message: string }

### **State Update**:

- Overwrites matching fields

- Marks form as "Auto-filled"

- Logs audit event

### PERSONAL INFORMATION - FIELD WORKFLOW

All fields update **local form state** until save.

## **Full Name (Required) Validation:**

- 2-100 chars

- Letters + spaces + . -

- Auto-capitalize first letter of each word

- Validation: At least 2 characters

- Error message: 'Please enter a valid full name', 'No special characters except'

**Frontend:**

- Validate on blur

- Red border if invalid

**Backend:**

- Revalidated during submission

- Value syncs to form state

## **Father/Husband Name (Required for loan eligibility)**

- Same validation as Full Name.

- If the product selected later requires a loan: → This becomes mandatory.

## **Date of Birth (Required) Frontend:**

- Calendar picker

- Age >= 18

- Show calculated age

**Backend:**

- Store ISO format

- **Phone Number (Critical Field) Frontend:**

- Format: +91 XXXXX XXXXX

- Real-time validation

- AJAX duplicate check: GET /api/leads/check-duplicate?phone=9876543210

### If duplicate

- Show warning

- Provide "View Existing Lead" button

**Backend:**

- Store with +91

- Soft duplicate allowed (with warning log)

## **Current Address (Optional)**

- Min 20 characters

- **Permanent Address (Optional)**

- Min 20 characters

- ☑ Same as Current: if checked 'Auto copy'

**Backend:**

- Store boolean is_current_same

### PRODUCT DETAILS - CONDITIONAL LOGIC

- **Product Category (Required)**

Fetch: GET /api/inventory/categories

### Selection triggers

- Load Product Types

- Determine if vehicle section visible

- **Product Type (Required)**

Fetch: GET /api/inventory/products?category=3-Wheeler

### Must store

- Product_Type ids

- Multiselect as per Product category

- Add 'Add Another Product' button to create multiple entries

- Consider: Primary product (required) + Secondary products (optional)

- If not in stock → show: "Order from OEM" suggestion

- **VEHICLE DETAILS (Conditional Block)**

- Visible only if:Product category = 3W/2W/4W

- **Vehicle Registration Number (Mandatory)**

- Auto uppercase'

- **Vehicle Ownership**

- vehicle_registration_number IS NOT NULL

- if the user fills Vehicle Reg. Number

- Show validation: 'You've entered vehicle details

- Automatically make dependent fields required:   •

- Vehicle Ownership (Required)

- Owner Name (Required)

- Owner Phone (Required)

- Show asterisk (*) dynamically on these fields.

- Add section heading: 'Existing Vehicle Information' (for context)

**Dropdown:**

- Self

- Financed

- Company

- Leased

- Family

Conditional fields appear based on selection.

- **Owner Name **

- Name format same as 'Full Name'.

- vehicle_registration_number IS NOT NULL

- if user fills Vehicle Reg. Number:

- Show validation: 'You've entered vehicle details'

- Automatically make dependent fields required:

- Vehicle Ownership (Required)

- Owner Name (Required)

- Owner Phone (Required)

- Show asterisk (*) dynamically on these fields

- Add section heading: 'Existing Vehicle Information' (for context)

- **Owner Phone**

- The phone format is the same as 'Phone Number'.

- vehicle_registration_number IS NOT NULL

- if the user fills Vehicle Reg. Number:

- Show validation:

- 'You've entered vehicle details'

- Automatically make dependent fields required:

- Vehicle Ownership (Required)

- Owner Name (Required)

- Owner Phone (Required)

- Show asterisk (*) dynamically on these fields

- Add section heading: 'Existing Vehicle Information' (for context)

### LEAD CLASSIFICATION Hot / Warm / Cold (Required) Frontend

- Toggle group

- Must select one

**Backend:**
	Stores:

- interest_level: hot | warm | cold

- lead_score: computed_value

Suggested scoring:

- Hot → 90

- Warm → 60

- Cold → 30

**Triggers:**

- Hot leads: 'Create Lead' saves Step 1 and auto-navigates to Step 2

- Warm/Cold: 'Create Lead' saves and exits workflow

### PAYMENT METHOD

- **Payment Method Dropdown (Required) Options:**

- Cash

- Other Finance (default)

- Dealer Finance

### Frontend Logic

On change:

- If Cash:

- Next page: Inventory Selection and Pricing

- Skip intermediary steps

- If Other Finance/Dealer Finance:

- Show full Loan Documents section

- Required Docs = 11

**Backend:**

- PATCH /api/kyc/:leadId/payment-method

**Store**:

- payment_method = 'Cash' | 'Other finance' | 'Dealer finance"

- loan_required = true/false

**Return**:

- Next Page Logic

### BOTTOM BUTTONS - CORE LOGIC

- **Create Lead**

Purpose: Immediate save & exit workflow

### **Frontend:**

- Validate all required fields

- If errors → highlight

- If valid → confirm modal:Create lead

- On confirm:

- Disable button

- Show spinner

- Call API

**Backend:**

- POST /api/leads/create

**Actions:**

- Server-side validation

- Generate reference:
#IT-[YEAR]-[SEQUENCE]

- Set:
status = INCOMPLETE
workflow_step = 1

- Save to leads table

- Create activity log

- Trigger notifications if HOT

**Response**

{success: true,

  	leadId,

  	referenceId}

- After Success

- Toast: Lead created

- Redirect to:
/leads/:id

- **Cancel**

### **Frontend:**

### If form untouched: → Go back

### If modified:→ Show confirmation modal

### On confirm:

- Clear local state

- Delete draft if exists:

- DELETE /api/leads/draft/:sessionId

- Redirect to dashboard

### STATE MANAGEMENT LOGIC During Step 1

- form_state = LOCAL

- lead_state = DRAFT (optional)

### After Create Lead

- lead_status = INCOMPLETE

- workflow_step = 1

| **Button** | **Frontend Action** | **Backend Action** | **State Change** |
| --- | --- | --- | --- |
| info | Open modal | None | None |
| Auto-fill | Call autofill API | Return data | Populate form |
| Create Lead | Validate → POST | Insert Lead | incomplete |
| Cancel | Confirm → Navigate | Delete draft (optional) | Discard |

### **Error Handling For every API call and user action, specify:**

- Network errors: 'Connection lost. Please try again'

- Validation errors: Field-specific error messages

- Server errors (500): 'Something went wrong. Contact support'

- Permission errors (403): 'You don't have permission'

- Timeout errors: Retry mechanism with exponential backoff

---

## Part C — Step 2: Customer KYC + Consent

**Customer KYC - Step 2 of 5 (Hot Lead Only)_Button Schema SCREEN ACCESS LOGIC Access Condition**

- User can access Step 2 only if:

lead_created = true

AND interest_level = 'hot'

AND Payment_Method <> 'Cash'

### Backend Gatekeeper

- GET /api/kyc/:leadId/access-check

- If not allowed → redirect to the 'Create Lead Page'

### CUSTOMER CONSENT DIGITAL CONSENT WORKFLOW (AADHAAR ESIGN) Send SMS/WhatsApp Consent Frontend

Click button: Send SMS/WhatsApp Consent

Disable Generate Consent PDF button (mutually exclusive)

Show phone number confirmation modal

- On confirm:

- Disable button, show spinner

- Call API

- On success:

- Show toast: 'Consent form sent to customer'

- Update Consent Status: 'Link_sent (SMS/WhatsApp delivered)'

**Backend:**

POST /api/kyc/:leadId/consent/digital/send-link

Request Body:

{

  leadId: "IT-2026-0000123",

  customerPhone: "+919876543210",

  channel: "whatsapp" | "sms"

}

Response:

{

  success: true,

  consentLinkId: "CL-20260726-001",

  linkUrl: "https://itarang.com/consent/CL-20260726-001",

  expiresAt: "2026-07-27T10:30:00Z",

  deliveryStatus: "sent"

}

Database Updates:

- consent_status = 'link_sent'

- consent_link_sent_at = CURRENT_TIMESTAMP

- consent_link_expires_at = CURRENT_TIMESTAMP + INTERVAL 24 HOUR

- consent_link_url = generated_url

- consent_delivery_channel = 'whatsapp' | 'sms'

```

### SMS/WhatsApp Template

```

Hi {CustomerName},

iTarang requires your consent to process your loan application.

Click here to review and sign digitally:

{ConsentLink}

This link expires in 24 hours.

Uses Aadhaar-based eSign (100% secure)

Questions? Call 1800-XXX-XXXX

- Team iTarang

### Link Expiry Handler

Cron job runs every hour

If consent_link_expires_at < NOW AND consent_status = 'link_sent':

- Set consent_status = 'expired'

- Send notification to dealer: "Consent link expired for Lead #{leadId}"

- Show "Resend Consent" button in UI

### Customer Completes Aadhaar eSign Customer-Side Flow (External Page)

- Customer clicks consent link

- System records: consent_status = 'link_opened'

- Customer reviews consent text [Consent format](https://www.dpdpa.com/templates/consentformfordataprocessingtemplate.html)

- Clicks "Sign with Aadhaar"

- eSign provider (DigiLocker/NSDL/eMudhra) opens Aadhaar OTP screen

- System records: consent_status = 'esign_in_progress'

- Customer enters Aadhaar OTP

- eSign provider validates OTP with UIDAI

- eSign provider generates digitally signed PDF with:

- Digital signature certificate

- Timestamp

- Aadhaar number (masked)

- eSign transaction ID

### eSign Provider Callback (Webhook)

POST /api/kyc/consent/esign/callback (called by eSign provider)

Request Body (from provider): { transactionId:"ESIGN-20260726-ABC123", status: "success" | "failed", signedPdfUrl: "https://esign-provider.com/signed/ABC123.pdf", signedAt: "2026-07-26T10:45:30Z", signerAadhaar: "XXXX-XXXX-3456",certificateId: "CERT-2026-XYZ", errorCode: null, errorMessage: null }

Backend Processing:

1. Validate webhook signature (security check)

2. Download signed PDF from provider URL

3. Store in iTarang permanent storage: -S3/Azure: /kyc/{leadId}/consent/signed_esign_{timestamp}.pdf

4. Extract and store metadata: - esign_transaction_id -esign_certificate_id - signed_pdf_url (iTarang storage) - signed_at - signer_aadhaar_masked - sign_method ='aadhaar_esign'

5. Update database: - consent_status = 'admin_review_pending' 🔶 - esign_completed_at =CURRENT_TIMESTAMP

6. Create admin task: - task_type = 'consent_review' - task_title = "Review Digital Consent - Lead #{leadId}" - assigned_to = 'consent_review_queue' - priority = 'high'

7. Send notifications: - Email to admin@itarang.com: "New consent pending review" - Dashboard alert for Admin users - SMS to dealer: "Customer signed consent, under review" Response to Provider: { success: true, received: true }

### Failure Handling

If eSign status = "failed"

consent_status = 'esign_failed'

- Store failure reason:

- esign_error_code

- esign_error_message (e.g., "Invalid OTP", "Aadhaar suspended")

- Send SMS to customer: "Consent signing failed. Reason: {error}. Click to retry: {link}"

- Allow 3 retry attempts

- After 3 failures:

-  consent_status = 'esign_blocked'

- Notify dealer: "Customer eSign blocked, switch to manual consent"

**Admin Reviews Digital Consent

**Admin Console - Consent Review Queue: Navigation:** ``` Admin Dashboard → Consent ReviewQueue ```

### Queue View (Table)

| Lead ID | Customer | Signed Via | Signed At | Status | Action |
| --- | --- | --- | --- | --- | --- |
| IT-2026-123 | Vijay Sharma | adhaar | 26-Jul 10:45 | Admin Review Pend. | Review |
| IT-2026-124 | Rakesh Kumar | Manual | 26-Jul 09:30 | Admin Review Pend. | Review |

Filters:

- Status: All / Pending / Verified / Rejected

- Signed Method: All / Aadhaar eSign / Manual

- Date Range

- Dealer

### Review Screen (Click "Review" button): Panel - Signed PDF Viewer

| 📄 Signed Consent PDF |
| --- |
| [PDF Preview with zoom controls] Digital Signature Verified Certificate ID: CERT-2026-XYZ Signed: 26-Jul-2026 10:45:30 AM Signer Aadhaar: XXXX-XXXX-3456 [Download PDF] [Print] [Admin Notes - Optional] [❌ Reject]  [✅ Approve & Verify] |

### Backend - Approve Action

POST /api/kyc/:leadId/consent/admin/verify

Request Body: { leadId: "IT-2026-0000123", decision: "approved",reviewerNotes: "All details verified, signature valid", reviewerId: "ADMIN-001" }

Database Updates:

- consent_status ='admin_verified'

- consent_verified_by = 'ADMIN-001'

- consent_verified_at = CURRENT_TIMESTAMP

- consent_verification_notes = reviewer_notes

- consent_final = true

Audit Log: { action: "consent_verified", entity:"Lead", entity_id: "IT-2026-0000123", performed_by: "ADMIN-001", timestamp: "2026-07-26T11:00:00Z", details: {previous_status: "admin_review_pending", new_status: "admin_verified" } }

Notifications:

- Email to dealer: "Consent verified for Lead #{leadId}, ready for next step"

- SMS to customer: "Your consent has been verified. Next: Product selection"

- Update lead workflow_step gating

### Backend - Reject Action

POST /api/kyc/:leadId/consent/admin/reject

Request Body:

{

  leadId: "IT-2026-0000123",

  decision: "rejected",

  rejectionReason: "mandatory" dropdown:

- "Signature mismatch"

- "Name mismatch with Aadhaar"

- "Incomplete consent text"

- "Expired certificate"

- "Fraudulent document suspected"

- "Other (specify in notes)",

  reviewerNotes: "Customer name in PDF does not match lead record",

  reviewerId: "ADMIN-001"

}

Database Updates:

- consent_status = 'admin_rejected'

- consent_rejected_by = 'ADMIN-001'

- consent_rejected_at = CURRENT_TIMESTAMP

- consent_rejection_reason = rejection_reason

- consent_rejection_notes = reviewer_notes

Trigger Re-Consent Flow:

- Send email to dealer: "Consent rejected for Lead #{leadId}. Reason: {reason}"

- SMS to customer: "Your consent could not be verified. Please re-sign: {new_link}"

- Generate new consent link with extended expiry (48 hours)

- Reset consent_status = 'link_sent'

- Increment consent_attempt_count

- If consent_attempt_count > 3:

- Escalate to senior admin for manual handling

### MANUAL CONSENT WORKFLOW (OFFLINE SIGNED PDF)

This is the fallback when digital consent fails or is unavailable.

Generate Consent PDF (Preview Only)

**Frontend:**

- Click button: Generate Consent PDF

- Disable Send SMS/WhatsApp Consent button (mutually exclusive)

- Show loading spinner

- Call API

**Backend:**

POST /api/kyc/:leadId/consent/manual/generate-pdf

Processing:

- Fetch lead data:

- Customer name, father name, DOB,address

- Product details

- Generate PDF using template engine (pdfkit/Puppeteer):

- Header: iTarang logo,"Customer Consent Form"

- Body: [CUSTOMER LOAN CONSENT FORM](https://www.dpdpa.com/templates/consentformfordataprocessingtemplate.html) (Link)

- Footer: "This is a digitally generated document"

- Store PDF temporarily:

- /tmp/consent_preview_{leadId}_{timestamp}.pdf

- Auto-delete after 24 hour

-  Set consent_status = 'manual_pdf_generated'

Response: { success: true, pdfUrl: "https://itarang.com/tmp/consent_preview_123.pdf", expiresIn: 24*3600, // 24 hour

downloadLink: "Download opens automatically" }

### Frontend After Success

- Download PDF automatically to the user's device

- Show toast: `Consent PDF downloaded.Please print, sign, and upload scanned copy.`

- Enable `Upload Signed Consent PDF` button

Show instructions:

Next Steps:

- Print the downloaded PDF

- Customer must sign in designated box

- Customer thumb impression required

- Witness signature required

- Scan or photo (clear, legible)

- Upload

### Upload Signed Consent PDF Frontend

- Click button: Upload Signed Consent PDF

- Enabled only after Generate Consent PDF is clicked

- Open file picker

- Validation:

- Format: PDF only

- Max size: 10MB

- Min resolution: 300 DPI (if image-based PDF)

- Show upload progress bar

- On success:

- Show PDF thumbnail preview

- Display upload timestamp

- Update status indicator

**Backend:**

POST /api/kyc/:leadId/consent/manual/upload

Request:

FormData

{ file: File (PDF), uploadedBy: "dealer_user_id" }

Processing:

- Validate file:

- Check magic bytes (PDF signature)

- Virus scan (ClamAV or similar)

- Extract PDFmetadata

- OCR scan (optional):

- Detect signature presence

- Verify checkboxes marked

- Flag for quality review

- Store permanently: - S3/Azure: /kyc/{leadId}/consent/manual_signed_{timestamp}.pdf

- Update database:

- consent_status = 'manual_review_pending' 🔶

- pdf_consent_uploaded_at = CURRENT_TIMESTAMP

- pdf_consent_uploaded_by = Sales Manager_id - signed_pdf_url = storage_url

- sign_method = 'manual'

- Create admin task:

- Same as digital consent review queue

- Send notifications:

- Admin: "Manual consent uploaded for Lead #{leadId}"

- Dealer: "Consent uploaded, awaiting admin verification"

Response: { success: true, fileUrl:"https://cdn.itarang.com/kyc/123/manual_signed.pdf", uploadedAt: "2026-07-26T12:00:00Z", status:"manual_review_pending" } ``` --- #####

**Admin Reviews Manual Consent Same Review Queue as Digital Consent Additional Manual Checks:**

Admin Verification Checklist (Manual Consent):

☑ PDF is legible and clear

☑ All signature boxes filled

☑ Thumb impression present

☑ Witness signature present

☑ Customer name matches lead record

☑ Date signed is recent (within 7 days)

☐ Any tampering/alteration detected?

**Approval:**

POST /api/kyc/:leadId/consent/manual/admin/verify

Updates:

- consent_status = 'manual_verified'

- (same fields as digital approval)

**Rejection:**

POST /api/kyc/:leadId/consent/manual/admin/reject

Rejection Reasons (Manual Specific):

- "Signature missing" -"Thumb impression missing"

- "Witness signature missing"

- "PDF not legible"

- "Date missing or invalid"

- "Suspected forgery"

Updates:

- consent_status = 'manual_rejected'

- Dealer notified to re-upload

### **Consent Status Display Overview:** iTarang requires explicit customer consent for KYC data processing, credit checks, and loan facilitation. Consent can be obtained via:

- **Digital Consent** (Aadhaar eSign) - Preferred

- **Manual Consent** (Signed PDF upload) - Fallback

### Critical Compliance Rule

- All consents (digital or manual) MUST be reviewed and approved by iTarang Admin before lead can proceed to next step

- This ensures regulatory compliance and fraud prevention

#### **CONSENT STATUS STATE MACHINE**

Replace the simple status field with this comprehensive state machine:

- **Digital consent Path**

- Awaiting_signature (default)

- link_sent (SMS/WhatsApp delivered)

- Link_opened (customer clicked link)

- E-sign_in_progress (OTP stage active)

- E-sign_completed (Aadhaar OTP verified)

- Admin_review_pending  (awaiting approval)

- Admin_verified (FINAL - can proceed)

- Admin_rejected (must re-consent)

- Expired (link timeout - 24hrs)

- **Manual consent Path**

- Consent_generated (preview downloaded)

- Consent_uploaded (scanned copy received)

- Admin_review_pending

- Admin_verified (FINAL - can proceed)

- Admin_rejected  (reupload required)

### Consent Gating Rule

Save & Next button enabled ONLY IF: consent_status IN ('admin_verified', 'manual_verified')

### DOCUMENT UPLOAD CARDS

- (Only visible if payment_method <> 'Cash')

- Sales Manager

## **WORKFLOW: Two-Stage Process**

## **Stage 1 - Dealer Upload (Dealer-facing)**

## Dealer uploads required documents

## System stores files

## No API verification at this stage

## Status: uploaded → pending_admin_review

## **Stage 2 - Admin Verification (iTarang internal)**

## Admin reviews uploaded documents

## System runs OCR + API verification

## Admin approves/rejects with reasons

## Status: admin_review_pending → verified | rejected

## Critical Rule: Dealer cannot proceed to Step 3 until Admin marks verification as complete.

## **STAGE 1: DEALER DOCUMENT UPLOAD (Dealer-Facing)**

This section covers what the **dealer sees and does Logic: If** payment_method **=== 'Other finance' or 'Dealer finance'**: Required** documents **= 11 (**full list below**)**

## **Document Upload Cards (Simple Upload Only)**

## Available Document Types:

Always Required:

- Aadhaar Front

- Aadhaar Back

- PAN Card

- Passport Size Photo

- Address Proof (Electricity Bill / Rent Agreement)

- Bank Statement (last 3 months)

- 4 Undated Cheques

- 🔶 RC Copy (conditional: only if Asset Category = 2W/3W/4W)

Common Upload Flow (All Documents)

### Frontend (Dealer View)

| **📄 **Aadhaar Front [**📤**]** |
| --- |
| **Status**: Not Uploaded Max size**:** 5MB  Format**: PNG**, JPEG**, PDF** |

Upload Steps:

- Click card → Open file picker

- Select file

- **Frontend validations:** - File size < 5MB

- File type: PNG, JPEG, PDF

- Image resolution > 300 DPI (recommended)

- Show upload progress bar

- On success: - Show green checkmark

- Display thumbnail preview

- Show uploaded timestamp

- Update document counter

- Status changes to: Uploaded - Pending Review

Upload Card After Success:

| **📄 **Aadhaar Front [**✅**]** |
| --- |
| **✅ Uploaded **-** Pending Review Uploaded**: 26**-**Jul **10**:**45 AM [**View**] [**Replace**]** |

Actions Available:

- **View**: Opens document in lightbox/modal

- **Replace**: Upload new version (replaces old file)

Backend API - Upload Endpoint

POST /api/kyc/:leadId/upload-document

Request: FormData { leadId: "IT-2026-0000123", documentType:"aadhaar_front" | "aadhaar_back" | "pan_card" | "passport_photo" | "address_proof" | "bank_statement" | "cheque_1" |"cheque_2" | "cheque_3" | "cheque_4" | "rc_copy", file: File, uploadedBy: "dealer_user_id" }

Processing:

- Validate file:

- Check file size < 5MB

- Verify file type (magic bytes check)

- Virus scan (optional but recommended)

- Generateunique filename:

- {leadId}_{documentType}_{timestamp}.{ext}

- Upload to cloud storage:

- S3/Azure:/kyc/{leadId}/{documentType}/

-  Store metadata in database:

- File_url

- File_size

- File_type

- Uploaded_at

- Uploaded_by

- Doc_status = 'uploaded'

- verification_status = 'pending' (internal field, not shown to dealer)

- Do NOTrun OCR or API verification here

Response: { success: true, documentId: "DOC-123456", fileUrl:"https://cdn.itarang.com/kyc/123/aadhaar_front.jpg", uploadedAt: "2026-07-26T10:45:00Z", status: "uploaded", message:"Document uploaded successfully. Awaiting admin verification." }

Database Schema Update:

Kyc_documents:

- id (PK)

- lead_id (FK)

- document_type (ENUM)

- file_url (VARCHAR)

- file_size (INT)

- file_type (VARCHAR)

- uploaded_at (TIMESTAMP)

- uploaded_by (FK: users)

- doc_status (ENUM: 'not_uploaded', 'uploaded','verified', 'rejected', 'reupload_requested')

- verification_status (ENUM: 'pending', 'in_progress', 'success', 'failed') -- Admin-only

- verified_at (TIMESTAMP)

- verified_by (FK: admin_users)

- rejection_reason (TEXT)

- extracted_data (JSON) -- OCR results stored here

- api_verification_results (JSON) -- API responses stored here

Document Status Counter (Dealer View)

​​Display Component (Top of Document Section)

| 📊 Document Upload Progress |
| --- |
| ✅ Uploaded: 9/11 ⏳ Pending Upload: 2 📝 Missing: PAN Card, Passport Photo Auto-updates as user uploads documents |

Backend API:

GET /api/kyc/:leadId/document-status

Response: { totalRequired: 11, uploaded: 9, pending: 2, missingDocuments:['pan_card', 'passport_photo'], allUploaded: false, adminVerificationStatus: 'pending' | 'in_progress' | 'completed' | 'failed',canProceedToNextStep: false // Controlled by admin verification, not upload count }

Dealer-Side Status States (Simplified)

Dealer sees only these statuses:

| Status | Display | Meaning |
| --- | --- | --- |
| not_uploaded | Not Uploaded | Dealer hasn't uploaded yet |
| uploaded | Uploaded - Pending Review | File stored, awaiting admin |
| reupload_request | Reupload Required | Admin rejected, reason shown |
| verified | Verified | Admin approved |

Important: Dealer does NOT see:

- `in_progress` (that's admin-side only)

- `failed` (converted to `reupload_requested` for dealer)

- API error codes (those are internal)

Reupload APIs:

POST /api/kyc/:leadId/reupload

document Same as upload, but:

- Replaces previous file

- Clears rejection reason

- Resets verification_status to 'pending'

- Notifies admin queue: "Document reuploaded for Lead #{leadId}"

STAGE 2: ADMIN VERIFICATION (iTarang Internal)

This section covers what **iTarang admin does** (not visible to the dealer).

### VERIFICATION ACTION Coupon Engine

Purpose: Coupons act as verification tokens that control access to KYC verification services. Each coupon represents one verification credit.

Core Principles:

- 1 Coupon = 1 KYC Verification

- Coupons are dealer-specific (cannot be shared across dealers)

- Coupons are single-use (cannot be reused)

- Coupons can have different face values (₹0, ₹50, ₹100)

- Settlement/billing is outside system scope (Phase 1)

Lifecycle:

Admin Creates Batch

    ↓

Distributed to Dealer (Manual - Email/Excel)

    ↓

Dealer Enters Coupon Code

    ↓

System Validates & Reserves Coupon

    ↓

Coupon Locked to Lead

    ↓

Admin Kyc  Verification

    ↓

Coupon Consumed (Status: Used)

Key Rules:

- **One-to-One Binding**: One coupon can only be used for exactly one lead (prevents duplicate usage)

- **Reservation Lock**: Once a coupon is entered and validated, it's reserved for that lead and cannot be used elsewhere

- **Consumption Trigger**: Coupon is consumed only when admin successfully runs verification (not on upload)

- **Failure Handling**: If verification fails or is cancelled before completion, coupon can be released back to available pool (admin decision)

COUPON LIFECYCLE STATES:

| COUPON STATUS FLOW |
| --- |
| [Created] (Admin generates batch)         ↓                                                  [Available] (Allocated to dealer, ready to use)         ↓  [Reserved] (Dealer entered code, locked to lead)         ↓                                                   [Used] (Verification completed) ✅ FINAL Alternative Paths:   [Available] → [Expired] (Past expiry date) ❌ FINAL [Available] → [Revoked] (Admin cancelled) ❌ FINAL [Reserved] → [Released] (Verification cancelled)                   → [Available] (Back to pool) |

Status Definitions:

| Status | Description | Can Be Used? | Actions Allowed |
| --- | --- | --- | --- |
| created | Just generated, not yet allocated | ❌ | Allocate to dealer |
| available | Allocated to dealer, ready to use | ✅ | Enter code, expire, revoke |
| reserved | Entered by dealer, locked to lead | ⏳ | Wait for verification, release |
| used | Verification completed | ❌ | View history only |
| expired | Past expiry date | ❌ | None (permanent) |
| revoked | Admin cancelled | ❌ | None (permanent) |
| released | Released from reservation | → available | Enter code again |

### ADMIN - COUPON BATCH CREATION

Navigation:

Admin Dashboard → Coupon Management → Create Batch

Create Batch Form:

| Create Coupon Batch |
| --- |
| Batch Name* │ ABC Motors - January 2026 │ Select Dealer* │ [Dropdown: ABC Motors - Delhi] ▼ │ Coupon Value* ◉ ₹0 (Free) ○ ₹50 ○ ₹100 ○ Custom: [____] Quantity* │ 500 │ Coupon Prefix (Optional) │ABCDEL │ (💡 If blank, auto-generates from dealer code) Expiry Date (Optional) [📅 31-Dec-2026] (⚠️ Leave blank for no expiry) [Cancel] [Generate Batch] |

### Field Validation

| Field | Required | Format | Validation |
| --- | --- | --- | --- |
| Batch Name | ✅ | Text (3-100 chars) | Unique per dealer |
| Dealer | ✅ | Dropdown | Must be active dealer |
| Coupon Value | ✅ | Number (0-10000) | Positive integer or zero |
| Quantity | ✅ | Number (1-10000) | Min: 1, Max: 10,000 per batch |
| Prefix | ❌ | Alphanumeric (2-10 chars) | No special chars except hyphen |
| Expiry Date | ❌ | Date | Must be future date |

### Coupon Code Generation Logic Format

{PREFIX}-{SEQUENCE}

Examples:

ABCDEL-0001

ABCDEL-0002

ABCDEL-0003

...

ABCDEL-0500

### Prefix Rules

- If admin provides custom prefix → Use custom prefix

- If blank → Auto-generate from dealer code

Dealer: "ABC Motors Delhi" (Code: DLR-001)

Auto-prefix: "DLR001"

### Sequence Rules

- Always 4 digits with leading zeros

- Starts from 0001 for each batch

- Increments sequentially

- No gaps in sequence

### Uniqueness Guarantee

// Backend validation

const existingCoupon = await db.coupons.findOne({

  coupon_code: generatedCode

});

if (existingCoupon) {

  // Add random suffix

  generatedCode = `${prefix}-${sequence}-${randomString(3)}`;

}

### Backend API - Create Batch

POST /api/admin/coupons/create-batch

Request Body:

{

  batchName: "ABC Motors - January 2026",

  dealerId: "DLR-001",

  couponValue: 50,

  quantity: 500,

  prefix: "ABCDEL", // Optional

  expiryDate: "2026-12-31" // Optional

}

Processing:

1. Validate inputs:

   - Dealer exists and is active

   - Quantity within limits (1-10,000)

   - Batch name unique for this dealer

   - Expiry date is future (if provided)

2. Generate prefix if not provided:

   const prefix = requestPrefix || generatePrefix(dealer.code);

3. Generate coupon codes:

   const codes = [];

   for (let i = 1; i <= quantity; i++) {

     const sequence = i.toString().padStart(4, '0');

     codes.push(`${prefix}-${sequence}`);

   }

4. Check for duplicate codes:

   const existingCodes = await db.coupons.findAll({

     where: { coupon_code: codes }

   });

   if (existingCodes.length > 0) {

     return { error: "Duplicate codes detected, regenerating..." };

   }

5. Insert batch record:

   const batch = await db.coupon_batches.create({

     batch_name: batchName,

     dealer_id: dealerId,

     coupon_value: couponValue,

     total_quantity: quantity,

     prefix: prefix,

     expiry_date: expiryDate,

     created_by: adminUserId,

     created_at: NOW,

     status: 'active'

   });

6. Bulk insert coupons:

   const coupons = codes.map(code => ({

     coupon_code: code,

     batch_id: batch.id,

     dealer_id: dealerId,

     value: couponValue,

     status: 'available',

     expiry_date: expiryDate,

     created_at: NOW

   }));

   await db.coupons.bulkCreate(coupons);

7. Create audit log:

   await db.audit_logs.create({

     action: 'coupon_batch_created',

     entity: 'coupon_batch',

     entity_id: batch.id,

     performed_by: adminUserId,

     details: { batchName, quantity, dealerId }

   });

Response:

{

  success: true,

  batchId: "BATCH-20260726-001",

  totalCoupons: 500,

  prefix: "ABCDEL",

  expiryDate: "2026-12-31",

  downloadUrl: "/api/admin/coupons/download/BATCH-20260726-001",

  message: "Batch created successfully. Click download to export coupon codes."

}

### Database Schema - Coupons

Table: coupon_batches

  id INT PRIMARY KEY AUTO_INCREMENT,

  batch_id VARCHAR(50) UNIQUE NOT NULL, -- BATCH-20260726-001

  batch_name VARCHAR(200) NOT NULL,

  dealer_id INT NOT NULL,

  coupon_value DECIMAL(10,2) NOT NULL, -- 0.00, 50.00, 100.00

  total_quantity INT NOT NULL,

  prefix VARCHAR(20) NOT NULL,

  expiry_date DATE NULL,

  status ENUM('active', 'expired', 'revoked') DEFAULT 'active',

  created_by INT NOT NULL, -- FK: admin_users

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (dealer_id) REFERENCES dealers(id),

  FOREIGN KEY (created_by) REFERENCES admin_users(id),

  INDEX idx_dealer_batch (dealer_id, created_at),

  INDEX idx_batch_status (status)

Table: coupons

id INT PRIMARY KEY AUTO_INCREMENT,

coupon_code VARCHAR(50) UNIQUENOT NULL, -- ABCDEL-0001

batch_id INT NOT NULL, -- FK: coupon_batches

dealer_id INT NOT NULL, -- FK: dealers

value DECIMAL(10,2) NOT NULL,

status ENUM( 'created', 'available', 'reserved', 'used', 'expired', 'revoked','released' ) DEFAULT 'available',

 -- Reservation tracking

reserved_at TIMESTAMP NULL,

reserved_by INT NULL, -- FK: users (dealer user who entered code) reserved_for_lead_id INT NULL, -- FK: leads (which lead this is reserved for)

-- Usage tracking

used_at TIMESTAMP NULL,

used_by INT NULL, -- FK: admin_users (who ran verification)

used_for_lead_id INT NULL, -- FK: leads (final lead verified)

verification_job_id VARCHAR(50) NULL,

 -- Lifecycle

expiry_date DATE NULL,

revoked_at TIMESTAMP NULL,

revoked_by INT NULL, -- FK: admin_users

revoked_reason TEXT NULL,

created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

FOREIGN KEY(batch_id) REFERENCES coupon_batches(id),

FOREIGN KEY (dealer_id) REFERENCES dealers(id),

FOREIGN KEY(reserved_for_lead_id) REFERENCES leads(id),

FOREIGN KEY (used_for_lead_id) REFERENCES leads(id),

INDEXidx_coupon_code (coupon_code),

INDEX idx_dealer_status (dealer_id, status),

INDEX idx_lead_coupon (reserved_for_lead_id),

INDEX idx_expiry (expiry_date, status)

Table: coupon_audit_log

id INT PRIMARY KEY AUTO_INCREMENT,

coupon_id INT NOT NULL,

action ENUM( 'created', 'allocated', 'reserved', 'released', 'used', 'expired', 'revoked' ), old_status VARCHAR(20),

new_status VARCHAR(20),

lead_id INT NULL,

performed_by INT, -- User/Admin who triggered action

ip_address VARCHAR(45), timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

notes TEXT NULL,

FOREIGN KEY(coupon_id) REFERENCES coupons(id),

INDEX idx_coupon_audit (coupon_id, timestamp) );

### Admin Coupon Batch Management

Navigation:

Admin Dashboard → Coupon Management → View Batches

Batch List View:

| Coupon Batches                                                                  [+ Create New Batch] Filters: [Dealer ▼] [Status ▼] [Date Range] |
| --- |
| Batch ID | Dealer | Value | Total | Available | Used | Action | Created | Expiry |
| BATCH-001 | ABC Motors | ₹50 | 500 | 182 | 318 | View | 15-Jan-2026 | 31-Dec-2026 |
| BATCH-002 | XYZ Motors | ₹0 | 1000 | 856 | 144 | View | 20-Jan-2026 | 31-Dec-2026 |

Batch Detail View (click 'View'):

| Batch Details: BATCH-001 Batch Name: ABC Motors - January 2026 │ │ Dealer: ABC Motors (Delhi) │ │ Coupon Value: ₹50 │ │ Created: 15-Jan-2026 by Admin User 1 │ │ Expiry: 31-Dec-2026 Statistics: Total Coupons: 500 │ │ Available: 182 (36.4%) │ │ Reserved: 15 (3%) │ │ Used: 318 (63.6%) │ │ Expired: 0(0%) │ │ Revoked: 0 (0%) [📥 Download Available Coupons]       [📊 Usage Report]          [❌ Expire All] Individual Coupons: [Search by code] [Filter by status ▼] |
| --- |
| Coupon Code | Status | Reserved For | Used For | Action |
| ABCDEL-0001 | Used | IT-2026-00001 15-Jan 10:30 | IT-2026-00001 15-Jan 14:45 | View |
| ABCDEL-0002 | Reserved | IT-2026-00001 20-Jan 12:30 |  | Release |
| ABCDEL-0003 | Available |  |  | Revoke |

**Download Coupon Batches: Button:** 📥 Download Available Coupons

| **Coupon Code** | **Value** | **Status** | **Expiry Date** |
| --- | --- | --- | --- |
| ABCDEL-0001 | ₹50 | Available | 31-Dec-2026 |
| ABCDEL-0002 | ₹50 | Available | 31-Dec-2026 |
| ABCDEL-0003 | ₹50 | Available | 31-Dec-2026 |
| ... | ... | ... | ... |
| ABCDEL-0500 | ₹50 | Available | 31-Dec-2026 |

### Admin Actions on Individual Coupons

##### **Release, Reserved Coupon**

Scenario: Dealer reserved coupon but verification not completed, need to free it up.

Button: Release (only visible for reserved status)

Backend:

**Processing**:

- Validate:

- Coupon status = 'reserved'

- Not yet used

- Update:

- status = 'released' (temporary state)

- Then auto-transition to 'available'

- Clear reserved_at, reserved_by, reserved_for_lead_id

-  Audit log:

- action = 'released'

- performed_by = admin_user_id

- notes = "Manually released by admin"

- 4. Notify dealer:

- "Coupon {code} released, now available for reuse"

- Response: { success: true, couponCode: "ABCDEL-0002", newStatus: "available", message:"Coupon released and now available" }

### Revoke Coupon

Scenario: Fraud detected, wrong batch, dealer suspended, etc.

Button: Revoke (only visible for reserved status)

Modal:

| Revoke Coupon: ABCDEL-0003 Reason for Revocation * ○ Fraud suspected ○ Wrong batch allocation ○ Dealer suspended ○ Duplicate coupon ○ Other (specify below) Additional Notes: ┌────────────────────────┐ └────────────────────────┘ ⚠️ This action is permanent and cannot be undone. Revoked coupons cannot be used. [Cancel]                                       [Confirm Revoke] |
| --- |

**Backend:**

POST /api/admin/coupons/:couponId/revoke

Request: { couponId: 123, reason: "Fraud suspected", notes: "Duplicate verification attempt detected", adminUserId: "ADMIN-001" }

Processing:

- Validate:

- Coupon exists - Not already revoked

- Update:

- status = 'revoked'

- revoked_at = NOW (Date and timestamp)

- revoked_by = admin_user_id

- revoked_reason = reason +notes

- If coupon was reserved:

- Unlink from lead (set reserved_for_lead_id = NULL)

- Notify dealer of revocation

- Audit log:

- action = 'revoked'

- details = { reason, notes }

Response: { success: true, message: "Coupon revoked successfully" }

### Expire Batch (Bulk Action)

Scenario: Batch reached expiry date, or admin wants to force-expire old batch.

Button: Expire All (in Batch Detail view)

Modal:

| Expire Entire Batch? This will expire all coupons in batch: BATCH-001 (ABC Motors - January 2026) Affected Coupons: │ │  Available: 182 │ │  Reserved: 15 Used and already-expired coupons unaffected. [Cancel]                       [Expire All Available Coupons] |
| --- |

**Backend:**

POST /api/admin/coupons/batch/:batchId/expire-all

Processing:

- Update all coupons in batch:

UPDATE coupons

SETstatus = 'expired'

WHERE batch_id = :batchId AND status IN ('available', 'reserved');

- Update batch:

UPDATEcoupon_batches

SET status = 'expired'

WHERE id = :batchId;

- Notify dealers:

If any reserved coupons expired,notify dealer

Response: { success: true, expiredCount: 197, message: "197 coupons expired successfully" }

### COUPON DISTRIBUTION (Manual - Phase 1)

1. Admin downloads coupon file

2. Admin sends file to dealer via:

- Email attachment

- WhatsApp file

 3.Dealer receives and stores coupons locally

Future Enhancement (Not in Scope Now):

- In-app coupon delivery

- Dealer dashboard showing assigned coupons

- Auto-notification on new batch allocation

### DEALER - COUPON ENTRY **&** VALIDATION

This is where the coupon enters the KYC workflow.

When: After all documents uploaded, before admin verification.

### Coupon Code Field Frontend

- Text input field

- Placeholder: 'Enter verification coupon code'

- Max length: 20 characters

- Alphanumeric only

- Required

**Backend:**

- Validates coupon code against dealer specific assigned coupon codes API

- If valid: strike off and enable verification

- If invalid: Show error 'Invalid coupon code'

- Store: coupon_code, coupon_applied_at, coupon_status change to used

### **Validate Button Frontend:**

- Check if coupon code entered

- If empty: Show error 'Please enter coupon code'

- If filled:

- Disable button

- show spinner

- Call validation API

- On success:

- Show toast: 'Coupon validated

- Enable 'Submit for Verification' button

- On failure:

- Show error: 'Invalid coupon or expired'

- Keep 'Submit for Verification' disabled

**Backend:**

POST /api/coupons/validate

Request: { couponCode: "ABCDEL-0001", leadId: "IT-2026-0000123", dealerUserId: "USR-456" }

Validation Checks:

- Coupon exists:

const coupon = await db.coupons.findOne({ where: { coupon_code:couponCode } }); if (!coupon) { return { valid: false, error: "Coupon code not found" }

- Coupon belongs to dealer:

const dealer = await getCurrentDealer(dealerUserId); if (coupon.dealer_id !== dealer.id) { return { valid: false, error:"This coupon is not assigned to your dealership" }

- Coupon status is available:

if (coupon.status !== 'available') {return { valid: false, error: `Coupon already ${coupon.status}` };

- Coupon not expired:

if (coupon.expiry_date &&new Date(coupon.expiry_date) < new Date()) { // Auto-expire if not already await coupon.update({ status: 'expired' });return { valid: false, error: "Coupon expired" }

- Lead doesn't already have a reserved coupon: const existingCoupon =await db.coupons.findOne({ where: { reserved_for_lead_id: leadId, status: 'reserved' } }); if (existingCoupon) { return {valid: false, error: `Lead already has coupon ${existingCoupon.coupon_code} reserved` }; } If All Checks Pass - ReserveCoupon: await coupon.update({ status: 'reserved', reserved_at: NOW, reserved_by: dealerUserId, reserved_for_lead_id:leadId }); await db.coupon_audit_log.create({ coupon_id: coupon.id, action: 'reserved', old_status: 'available', new_status:'reserved', lead_id: leadId, performed_by: dealerUserId, notes: `Reserved for Lead #${leadId}` });

Response (Success): {valid: true, coupon: { code: "ABCDEL-0001", value: 50, status: "reserved", reservedAt: "2026-07-26T10:30:00Z",expiryDate: "2026-12-31" }, message: "Coupon validated and reserved successfully" } Response (Failure): { valid: false,error: "Coupon already used", message: "This coupon has already been used for another verification" }

### Frontend Handling

### **On Success:**

if (response.valid) { setCouponStatus('validated'); toast.success('Coupon validated successfully!'); // Save to lead stateupdateLead({ coupon_code: response.coupon.code, coupon_value: response.coupon.value, coupon_status: 'reserved' }); // Enable "Submit for Verification" button setCanSubmit(true); }

### **On Failure:**

if (!response.valid) { setCouponStatus('invalid'); toast.error(response.message || response.error); // Highlight input with error setErrors({ coupon: response.error }); // Keep "Submit for Verification" disabled setCanSubmit(false); }

### Change Coupon (After Validation)

Scenario: Dealer entered wrong code or wants to use different coupon.

Button: [Change Coupon]

Action:

- Release current reserved coupon

- Show input field again

- Allow entering new code

**Backend**:

POST /api/coupons/release-and-change Request: { leadId: "IT-2026-0000123", currentCouponCode: "ABCDEL-0001" }

Processing:

- Find reserved coupon: const coupon = await db.coupons.findOne({ where: { reserved_for_lead_id: leadId,status: 'reserved' } });

- Release it: await coupon.update({ status: 'available', reserved_at: NULL, reserved_by: NULL,reserved_for_lead_id: NULL });

- Audit log: await db.coupon_audit_log.create({ coupon_id: coupon.id, action:'released', old_status: 'reserved', new_status: 'available', lead_id: leadId, notes: "Dealer changed coupon" });

- Response: {success: true, message: "Coupon released. You can now enter a new code." }

### **Submit for Verification Button When:** Admin clicks "Run Verification" button (Section 2.3.3)

Critical Rule: Coupon is consumed ONLY when verification successfully starts, NOT when submitted by the dealer.

### Verification Start - Consume Coupon

| **Stage** | **Documents Status** | **Submit for verification** | **Admin Can See?** | **Admin Can Run OCR/API?** |
| --- | --- | --- | --- | --- |
| Documents Uploaded | Uploaded, stored in cloud | Not entered yet | No | NO (cannot run verification) |
| Consent Verified | Uploaded | Not entered yet | YES (can view files) | No |
| Coupon Reserved | Uploaded | Reserved | Yes | No |
| Submitted to Admin | Uploaded | Reserved | Yes | YES (can run verification |
| Verification Running | Uploaded | Consumed | Yes | YES (In progress) |
| Verification Complete | Verified | Used | Yes | Results available |

**Verification Failure Handling: Scenario 1: Verification job fails to start (API error, system crash)**

// If verification job creation fails BEFORE coupon consumed:

if (verificationJobFailed) {

  // Coupon remains 'reserved' (not consumed)

  // Dealer can try again or admin can retry

  // DO NOT consume coupon

}

### Scenario 2: Verification completes but all checks fail

// If verification runs but customer KYC rejected:

// Coupon is STILL consumed (verification service was used)

// Admin can decide to:

// Option 1: Keep coupon as used (standard)

// Option 2: Manually release coupon back to dealer (exceptional)

**Backend:**

POST /api/admin/kyc/:leadId/cancel-verification

Request:

{

  leadId: "IT-2026-0000123",

  couponAction: "release" | "consume"

}

Processing:

if (couponAction === "release") {

  await reservedCoupon.update({

    status: 'released', // Then auto-transition to 'available'

    reserved_for_lead_id: NULL,

    // Clear reservation fields

  });

  message = "Verification cancelled. Coupon released back to dealer.";

} else {

  await reservedCoupon.update({

    status: 'used',

    used_at: NOW,

    used_by: adminUserId

  });

  message = "Verification cancelled. Coupon marked as used.";

}

```

### COUPON INVENTORY TRACKING

Dealer Dashboard Widget

Display: Dealers see their coupon balance prominently.

| **Your Verification Coupons  Available: 182                                 Reserved: 15 Used This Month: 48 Running low! Request more coupons [Contact Support]   ** |
| --- |

### Backend API

GET /api/dealer/coupons/summary

Response:

{

  dealerId: "DLR-001",

  dealerName: "ABC Motors",

  coupons: {

    available: 182,

    reserved: 15,

    used: 318,

    expired: 5,

    revoked: 0

  },

 usageThisMonth: 48,

  batches: [

    {

      batchId: "BATCH-001",

      batchName: "January 2026",

      available: 120,

      total: 500

    },

    {

      batchId: "BATCH-002",

      batchName: "February 2026",

      available: 62,

      total: 200

    }

  ],

  lowStockAlert: true, // Trigger if available < 50

  message: "You have 182 coupons remaining"

}

### --- Low Coupon Alert

Trigger: When dealer's available coupons fall below threshold (e.g., 50 coupons).

### Alert Banner (Dealer Dashboard)

| **⚠️ Low Coupon Balance You have only 32 coupons remaining.     [Request More Coupons]** |
| --- |

### When Coupons Finish (Zero Available)

Scenario: Dealer tries to validate coupon but none available.

### Error Message

|  ❌ No Coupons Available You have no verification coupons remaining.                                               Please contact iTarang support to request new coupons:  📧 support@itarang.com  **📞 1**800-XXX-XXXX  [Contact Support] |
| --- |

**Backend:**

// In coupon validation API

const availableCoupons = await db.coupons.count({

  where: {

    dealer_id: dealerId,

    status: 'available'

  }

});

if (availableCoupons === 0) {

  // Send alert to admin

  await sendAdminNotification({

    type: 'dealer_out_of_coupons',

    dealerId: dealerId,

    dealerName: dealer.name,

    message: `Dealer ${dealer.name} has run out of coupons`

  });

  return {

    valid: false,

    error: "NO_COUPONS_AVAILABLE",

    message: "No verification coupons available. Please contact support.",

    supportContact: {

      email: "support@itarang.com",

      phone: "1800-XXX-XXXX"

    }

  };

}

**COUPON EXPIRY - AUTO-CLEANUP **(Cron Job: Runs daily at midnight)

// Scheduled task: 0 0 * * * (Daily at 00:00)

async function expireOldCoupons() {

  const today = new Date();

  // Find all coupons past expiry date but not yet marked expired

  const expiredCoupons = await db.coupons.findAll({

    where: {

      expiry_date: { $lt: today },

      status: { $in: ['available', 'reserved'] }

    }

  });

  console.log(`Found ${expiredCoupons.length} coupons to expire`);

  for (const coupon of expiredCoupons) {

    // If coupon was reserved, release it first

    if (coupon.status === 'reserved') {

      // Notify dealer

      await notifyDealerCouponExpired(coupon);

    }

    // Mark as expired

    await coupon.update({ status: 'expired' });

    // Audit log

    await db.coupon_audit_log.create({

      coupon_id: coupon.id,

      action: 'expired',

      old_status: coupon.status,

      new_status: 'expired',

      performed_by: null, // System action

      notes: 'Auto-expired by system'

    });

  }

  console.log(`Expired ${expiredCoupons.length} coupons`);

}

### **GATING RULE UPDATE - STEP 2 TO ADMIN VERIFICATION Critical Change:** Admin cannot run verification without a valid coupon.

### Updated Admin Verification Button Logic

/// Frontend - Step 2 (KYC Page)

const canSubmitForVerification = () => {

  const checks = {

    paymentMethodSelected: lead.payment_method !== null,

    allDocsUploaded: uploadedDocs.length === requiredDocs.length,

    consentVerified: lead.consent_status === 'admin_verified' ||

                     lead.consent_status === 'manual_verified',

    couponValidated: lead.coupon_status === 'reserved' &&

                     lead.coupon_code !== null

  };

  return Object.values(checks).every(check => check === true);

};

// Button UI

<button

  disabled={!canSubmitForVerification()}

  onClick={handleSubmitForVerification}

  className={canSubmitForVerification() ? "btn-primary" : "btn-disabled"}

>

  {canSubmitForVerification()

    ? "Submit for Verification"

    : getBlockingReason()}

</button>

// Helper function

function getBlockingReason() {

  if (!paymentMethodSelected) return "⏳ Select payment method";

  if (!allDocsUploaded) return "⏳ Upload all documents";

  if (!consentVerified) return "⏳ Awaiting consent verification";

  if (!couponValidated) return "⏳ Enter verification coupon";

  return "⏳ Complete all steps above";

}

// Tooltip

{!canSubmitForVerification() && (

  <Tooltip>

    <strong>Required to submit:</strong>

    <ul>

      <li>{paymentMethodSelected ? "✅" : "❌"} Payment method selected</li>

      <li>{allDocsUploaded ? "✅" : "❌"} All documents uploaded ({uploadedDocs.length}/{requiredDocs.length})</li>

      <li>{consentVerified ? "✅" : "❌"} Consent verified by admin</li>

      <li>{couponValidated ? "✅" : "❌"} Verification coupon validated</li>

    </ul>

  </Tooltip>

)}

### COUPON AUDIT **&** REPORTING

Admin Reports:

Navigation: Admin → Reports → Coupon Usage Report

Report Filters:

- Date Range

- Dealer (single or all)

- Batch

- Coupon Status

- Coupon Value

### Report Columns

| Date | Dealer | Batch | Coupon Code | Value | Lead ID | Status | Used By | Used At |

|------|--------|-------|-------------|-------|---------|--------|---------|---------|

| 26-Jul | ABC | BATCH-001 | ABCDEL-0001 | ₹50 | #123 | Used | Admin 1 | 26-Jul 14:30 |

| 26-Jul | ABC | BATCH-001 | ABCDEL-0002 | ₹50 | #124 | Used | Admin 2 | 26-Jul 15:15 |

### Export Options

- Excel

- CSV

- PDF

Summary Stats:

Total Coupons Issued: 5,000

Total Used: 1,850 (37%)

Total Available: 2,980 (59.6%)

Total Expired: 120 (2.4%)

Total Revoked: 50 (1%)

By Dealer:

- ABC Motors: 318 used / 500 total (63.6%)

- XYZ Autos: 144 used / 1000 total (14.4%)

...

By Month:

- January 2026: 520 used

- February 2026: 680 used

- March 2026: 650 used

COMPLETE COUPON WORKFLOW DIAGRAM

│ ADMIN CREATES BATCH

│   ↓

│ Generates 500 unique coupon codes

│   ↓

│ Status: Available

│   ↓

│ Downloads Excel file

│   ↓

│ Sends to dealer via email

                          ↓

│ DEALER RECEIVES COUPONS

│   ↓

│ Stores codes locally

│   ↓

│ Customer walk-in → Creates lead → Uploads KYC docs

│   ↓

│ Enters coupon code: ABCDEL-0001

│   ↓

│ Clicks "Validate"

                          ↓

│ SYSTEM VALIDATES COUPON

│   ├── Exists? ✅

│   ├── Belongs to dealer? ✅

│   ├── Status = available? ✅

│   ├── Not expired? ✅

│   └── Lead doesn't have coupon already? ✅

│   ↓

│ ALL CHECKS PASS

│   ↓

│ Coupon status: available → reserved

│ Reserved for Lead #123

│ Timestamp: 26-Jul 10:30 AM

                       ↓

│ DEALER SUBMITS LEAD FOR ADMIN REVIEW

│   ↓

│ Lead appears in Admin KYC Queue

                          ↓

│ ADMIN REVIEWS DOCUMENTS

│   ↓

│ Checks coupon status: Reserved ✅

│   ↓

│ Clicks "Run Verification"

│   ↓

│ COUPON CONSUMED

│ Status: reserved → used

│ Used by: Admin User 1

│ Timestamp: 26-Jul 14:30 PM

│   ↓

│ Verification job starts (OCR + APIs)

│   ↓

│ Results stored

│   ↓

│ Admin approves/rejects KYC

iTARANG ADMIN KYC VERIFICATION WORKFLOW - iTarang view

Add as Section (After Coupon Management)

### **OVERVIEW - ADMIN VERIFICATION PURPOSE Objective:** After the dealer completes document upload, consent verification, and coupon validation, the lead is handed off to iTarang Admin for comprehensive KYC verification using third-party APIs and manual review.

### Core Principles

- Admin has full control over verification execution

- APIs are triggered manually (not auto-run on upload)

- Coupon consumed when first verification API executes

- Admin can request additional documents or co-borrower KYC

- Cost control: Limited API retry attempts

- Final decision: Approve, Reject, or Request More Info

### Verification Scope

- **API Verifications:** Aadhaar (OTP), PAN, Bank Account, Face Match, CIBIL

- **OCR Extraction:** Aadhaar, PAN, Bank Statement, Cheques, RC

- **Manual Reviews:** Document authenticity, data consistency, cross-field matching

- **Risk Assessment:** CIBIL score interpretation, fraud checks

### **CASE HANDOFF FROM DEALER TO iTARANG**

#### **Trigger Conditions**

The lead automatically moves to iTarang verification queue when ALL of the following are met:

**Checklist:**

- Customer consent completed and admin-verified

- All required documents uploaded (11/11 for loan, 3/3 for cash)

- Verification coupon validated and reserved

- Dealer clicked "Submit for Verification"

### System Actions on Handoff, Backend API: **POST /**api**/**kyc**/:**leadId**/**submit**-**for**-**verification Processing

- Lock dealer editing:

- Documents become read-only for dealer

- Dealer cannot upload new versions

- Only admin can request changes

- Update lead status:

- await lead update:

- kyc_status: 'pending_itarang_verification'

- submitted_for_verification_at: NOW

- submitted_by: dealerUserId

- dealer_edits_locked: true

- Add to admin queue:

- await db.admin_verification_queue.create:

- queue_type: 'kyc_verification'

- lead_id: leadId

- priority: calculatePriority(lead)

- assigned_to: null, // Auto-assigned or manual

- created_at: NOW

- status: 'pending_itarang_verification''

- Store metadata:

- await db.kyc_verification_metadata.create:

- lead_id: leadId

- submission_timestamp: NOW

- coupon_code: reservedCoupon.coupon_code

- coupon_status: 'reserved'

- documents_count: uploadedDocs.length

- consent_verified: true'

- Notify admin:

- await sendAdminNotification:

- type: 'new_kyc_case'

- leadId: leadId

- customerName: lead.fullName

- dealerName: [lead.dealer.name](http://lead.dealer.name)

- priority: 'normal'

- Notify dealer:

- await sendDealerNotification:

- type: 'kyc_submitted'

- message: 'KYC submitted. Awaiting iTarang verification.'

- estimatedTime: '10-12 hours'

- Response:

- success: true

- leadStatus: 'pending_itarang_verification'

- queuePosition: 8

- estimatedReviewTime: '10-12 hours'

- message: 'Case submitted to iTarang verification team'

### iTARANG ADMIN VERIFICATION QUEUE

Navigation**: **Admin Dashboard** → **KYC Verification Queue Queue Dashboard:**

Queue View:

| KYC Verification Queue                                                                                [🔄 Refresh] |
| --- |
| Filters: [Status ▼] [Dealer ▼] [City ▼] [Priority ▼] [Date Range] |
| Summary: Pending: 18 │ In Progress: 5 │ Requested correction: 2 │ Rejected: 1 │Approved: 24 |
| Lead ID | Customer | Contact # | Dealer | Submitted Date | Consent Status | Coupon Code | Status | SLA | Action |
| ABC-2026-0000001 | Vijay Sharma | +91 9876543210 | ABC Motors Varanasi | 26-Jul 10:30 AM | Verified | ABCVAR-0001 | Pending | 2h 15m | Review |
| XYZ-2026-0000002 | Rakesh Kumar | +91 9988776655 | XYZ Auto Delhi | 25-Jul 04:00 PM | Verified | XYZDEL-0001 | In Progress | 22h 30m | Review |
| BIH-2026-0000002 | Anjali Singh | +91 9898989898 | Bihar Dealer Patna | 25-Jul 04:01 PM | Verified | BIHPAT-001 | Approved | 5h 20m | View |

Priority Indicators:

🔴 **High Priority**: <> Requested or Rejected or Approved > 12 hours

🟡 **Medium**: <> Requested or Rejected or Approved > 10 hours

🟢 **Normal**: <> Requested or Rejected or Approved < 10 hours

ADMIN CASE REVIEW SCREEN: When admin clicks **"Review"** button, the full KYC case file opens.

Case Review Layout:

| [← Back to Queue]                                              Lead #ABC-2026-0000001 - Vijay Sharma |
| --- |
| Lead info                                                                                                  [Document Viewer] Name: Vijay Sharma │ Date of Birth: XXXXXX │ Phone: +91 9876543210 │ Gender: Male │ Husband/Father Name: XXXX Permanent Address: Connaught Place, Delhi │ Current Address: Connaught Place, Delhi Product: 3W IOT 51.2V-105AH │ Vehicle: DL-3C-A-7889 │ Vehicle Ownership: XXXX │ Owner Name: XXXX │ Owner Contact: XXXX DOCUMENTS (Quick Access - Click to View) [Aadhaar F] [Aadhaar B] [PAN] [Photo] [Address] [RC] [Bank] [Cheques] VERIFICATION CARDS (Run APIs & See Results) [Card 1: Aadhaar] [Card 2: PAN] [Card 3: Face] [Card 4: Bank] [Card 5: Address] [Card 6: RC] [Card 7: CIBIL] [Card 8: Phone]... (scroll down for more cards as needed) Consent Copy [Download] [View]              [Approve] [Reject] COUPON: ABCDEL-0001 (Reserved) FINAL DECISION ○ Approve ○ Reject ○ Dealer Action Required [Submit Decision]  [Save] [Back] |

Key Features:

- All elements visible without scrolling (except verification cards)

- Document thumbnails clickable (opens lightbox viewer)

- Coupon status visible at all times

- Decision panel always visible at bottom

**VERIFICATION CARD SYSTEM: Card-Based Architecture (NOT Checklist Table)

- **Cost Control**: Admin sees cost BEFORE clicking

- **Flexibility**: Each verification is independent

- **Scalability**: Easy to add new verification types

- **Better UX**: Results shown within same card

- **Manual Override**: Each card allows admin input if needed

### Standard Verification Card Structure

Every card follows this template:

| [VERIFICATION NAME]                                                                   Status: XXXXXXXXXXX |
| --- |
| 📥 INPUT DATA (Auto-filled from OCR/Lead)                                     [[Autofill OCR](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-document-forensics-document-extraction)] Field 1: [Value] [✏️ Edit if needed] Field 2: [Value] [✏️ Edit if needed] Field 3: [Value] [✏️ Edit if needed] AVAILABLE VERIFICATIONS [Run API] Filed Name Input Data Document Data (From API) Match Result 1 Field 1 Field 1 Matched 2 Field 2 Field 1 Not Matched 3 Field 3 Field 1 Not Matched 💬 ADMIN NOTES [Text area for remarks] ⚡ ACTIONS [✓ Accept] [✗ Reject] [⚠️ Request More Docs ] |

### VERIFICATION CARDS - COMPLETE LIST (PHASE 1)

- Aadhaar Verification

- PAN Verification

- Bank Account

- CIBIL Score

- RC Verification

- Phone Intelligence

Card Status:

- Pending

- Initiating

- Awaiting Consent (in case of Aadhaar)

- Consent Failed (in case of Aadhaar)

- Awaiting Response

- Response Received (200)

- Response Failed (400 or server/API error)

### DETAILED VERIFICATION CARDS

CARD 1: AADHAAR VERIFICATION ([Adhaar Check Documentation](https://docs.decentro.tech/reference/kyc_api-digilocker-get-e-aadhaar))

| CARD 1: [AADHAAR VERIFICATION ](https://docs.decentro.tech/docs/kyc-and-onboarding-identities-digilocker-services)                                                      Status: ⏳ Pending |
| --- |
| 📥 INPUT DATA                                                                                  [[Autofill OCR](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-document-forensics-document-extraction)] ├─ Aadhaar Number (From Aadhaar ID): XXXX-XXXX-3456             [✏️ Edit if OCR wrong] ├─ Name (From Lead): VIJAY SHARMA ├─ DOB (From Lead): 15-01-1985 ├─ Father/Hunband Name (Lead): XXXXX ├─ Address (From Lead): 123 Main St, Delhi-110001 ├─ Gender (From Lead): Male ├─ Mobile (From Lead): +91 9876543210 └─ Email (From Lead): vijay.sharma@example.com (optional) VERIFICATION  [[Initate]](https://docs.decentro.tech/reference/kyc_api-digilocker-initiate-session) |

### Manual Entry Policy

- Audit Log: Store data_source = **"**manual**"** | **"**ocr**"**

AFTER ADMIN SELECTS "USE DIGILOCKER METHOD"

| AADHAAR VERIFICATION (via Digilocker)                                       Status: 🔵 Initiating |
| --- |
| STEP 1: SEND DIGILOCKER CONSENT LINK TO CUSTOMER Customer Mobile: +91 9876543210                  [Send Digilocker Link to Customer via SMS] Link Valid For: ○ 24 hours ○ 48 hours ○ 72 hours What happens next: Customer receives SMS with secure Digilocker link Customer clicks link → Redirected to Digilocker login Customer logs in with Aadhaar/Mobile OTP Customer authorizes iTarang to fetch Aadhaar XML Document auto-fetched and displayed below |

BACKEND API CALL - INITIATE DIGILOCKER FLOW

POST /api/admin/kyc/:leadId/aadhaar/digilocker/initiate

Request:

{

  leadId: "IT-2026-0000123",

  customerName: "Vijay Sharma",

  customerMobile: "+919876543210",

  customerEmail: "vijay.sharma@example.com", // Optional

  notificationChannel: "sms"

  documentsRequested: ["aadhaar"]

  linkValidityHours: 24,

  adminUserId: "ADMIN-001"

}

Backend Processing:

1. Generate unique transaction ID:

   const txnId = `DIGI-${leadId}-${Date.now()}`;

2. Call Decentro Digilocker SSO Init API:

   const decentroResponse = await axios.post(

     'https://in.decentro.tech/kyc/digilocker/sso/init',

     {

       reference_id: txnId,

       redirect_url: `https://itarang.com/kyc/digilocker/callback/${txnId}`,

       purpose_message: "Aadhaar verification for battery loan application",

       requested_documents: ["aadhaar"],

       consent_text: "I authorize iTarang to fetch my Aadhaar from Digilocker",

       expiry_hours: 24

     },

     {

       headers: {

         'client_id': process.env.DECENTRO_CLIENT_ID,

         'client_secret': process.env.DECENTRO_CLIENT_SECRET,

         'module_secret': process.env.DECENTRO_MODULE_SECRET,

         'provider_secret': process.env.DECENTRO_PROVIDER_SECRET

       }

     }

   );

3. Extract Digilocker consent URL:

   const digilockerUrl = decentroResponse.data.data.digilocker_url;

   const sessionId = decentroResponse.data.data.session_id;

4. Generate short URL (optional, for SMS):

   const shortUrl = await generateShortUrl(digilockerUrl);

5. Store transaction in database:

   await db.digilocker_transactions.create({

     transaction_id: txnId,

     lead_id: leadId,

     session_id: sessionId,

     digilocker_url: digilockerUrl,

     short_url: shortUrl,

     requested_documents: ["aadhaar"],

     status: 'link_sent',

     link_sent_at: NOW,

     link_expires_at: NOW + 24 hours,

     notification_channel: 'sms',

     customer_mobile: customerMobile,

     customer_email: customerEmail

   });

6. Send SMS to customer:

   await sendSMS({

     to: customerMobile,

     message: `

Hi ${customerName},

iTarang needs your Aadhaar for loan verification.

Please click the link below to share from Digilocker:

${shortUrl}

This is a secure government platform. Your data is safe.

Link expires in 24 hours.

- iTarang Team

     `.trim()

   });

7. If email also requested, send email:

   if (notificationChannel === 'email' || notificationChannel === 'both') {

     await sendEmail({

       to: customerEmail,

       subject: 'Aadhaar Verification - Action Required',

       html: `

         <h2>Aadhaar Verification for Loan Application</h2>

         <p>Dear ${customerName},</p>

         <p>Please share your Aadhaar from Digilocker to complete KYC verification.</p>

         <p><a href="${digilockerUrl}" style="background: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block;">

           Share Aadhaar from Digilocker

         </a></p>

         <p>Link expires in 24 hours.</p>

         <p>This is a secure government platform. Your data is protected.</p>

       `

     });

   }

8. Update lead status:

   await lead.update({

     aadhaar_digilocker_status: 'link_sent',

     aadhaar_digilocker_link_sent_at: NOW

   });

Response:

{

  success: true,

  transactionId: txnId,

  sessionId: sessionId,

  linkSent: true,

  sentTo: {

    mobile: "+919876543210",

    email: customerEmail || null

  },

  linkExpiresAt: "2026-07-27T11:30:00Z",

  message: "Digilocker link sent to customer. Awaiting authorization."

}

DECENTRO API DETAILS

#### **API 1: Digilocker SSO Init Endpoint:** POST /kyc/digilocker/sso/init

**Request:**

{

  "reference_id": "DIGI-IT-2026-123-1722012345678",

  "redirect_url": "https://itarang.com/kyc/digilocker/callback/DIGI-IT-2026-123-1722012345678",

  "purpose_message": "Aadhaar verification for battery loan application",

  "requested_documents": ["aadhaar"],

  "consent_text": "I authorize iTarang Technologies LLP to fetch my Aadhaar document from Digilocker for KYC verification purposes.",

  "expiry_hours": 24

}

**Request:**

{ "status": "SUCCESS", "message": "Digilocker consent link generated successfully", "data": { "session_id": "SESSION-ABC123XYZ", "digilocker_url": "https://digilocker.gov.in/authorize?client_id=XXX&redirect_uri=https://decentro.tech/callback&state=SESSION-ABC123XYZ", "expires_at": "2026-07-27T11:30:00Z", "requested_documents": ["aadhaar"] }, "decentroTxnId": "DCTR1234567890" }

### AFTER LINK SENT - WAITING STATE

| AADHAAR VERIFICATION (via Digilocker)                          Status: 🟡 Awaiting Consent |
| --- |
| STEP 1 COMPLETED: Link Sent to Customer WAITING FOR CUSTOMER ACTION Transaction ID: DIGI-IT-2026-123-1722012345678 Session ID: SESSION-ABC123XYZ Link Sent To:  Mobile: +91 98765XXXXX                      Delivered at 11:30 AM Link Status: ⏳ Not Opened Yet    Link Expires: 26-Jul-2026 11:30 PM (12 hours remaining) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ CUSTOMER PROGRESS TRACKER ○ Link Sent: Completed (11:30 AM) ○ Link Opened: Waiting ○ Digilocker Login:  Waiting ○ Consent Given: Waiting ○ Document Fetched: Waiting  🔄 Auto-refreshing every 10 seconds... WHAT TO DO IF CUSTOMER HASN'T RESPONDED: If customer hasn't acted within 20 hours admin can: 1. [Resend Link] - Send reminder SMS/Email 2. [Call Customer] - Assist them over phone 3. [Extend Link Validity] - Add 24 more hours ACTIONS  [Resend Link] [Extend Validity]  [Cancel] |

### Auto Refresh Logic

// Frontend polling (every 10 seconds) useEffect(() => { const interval = setInterval(async () => { const status = awaitcheckDigilockerStatus(transactionId); if (status.linkOpened) { setProgress('link_opened'); } if(status.digilockerLoginComplete) { setProgress('digilocker_login'); } if (status.consentGiven) {setProgress('consent_given'); } if (status.documentFetched) { setProgress('document_fetched'); clearInterval(interval); // Stop polling } }, 10000); return () => clearInterval(interval); }, [transactionId]); // Backend status check API GET/api/admin/kyc/:leadId/aadhaar/digilocker/status/:transactionId Response: { transactionId: "DIGI-IT-2026-123-1722012345678", status: "awaiting_customer", linkOpened: false, linkOpenedAt: null, digilockerLoginComplete: false,consentGiven: false, documentFetched: false, linkExpiresAt: "2026-07-26T23:30:00Z", timeRemaining: "12 hours 15 minutes" }

AFTER CUSTOMER AUTHORIZES - DOCUMENT FETCHED Backend Callback Handler: POST /api/kyc/digilocker/callback/:transactionId // This endpoint is called by Decentro after customer authorizes Processing:

1. Receive callback from Decentro: const callbackData = req.body; // Callback data structure: { reference_id:"DIGI-IT-2026-123-1722012345678", session_id: "SESSION-ABC123XYZ", status: "success", documents: [ { type:"aadhaar", format: "xml", data: "<base64-encoded-xml>", fetched_at: "2026-07-26T11:45:00Z" } ], consent_given_at:"2026-07-26T11:45:00Z", decentroTxnId: "DCTR1234567890" }

2. Update transaction status: awaitdb.digilocker_transactions.update({ status: 'document_fetched', consent_given_at: callbackData.consent_given_at,document_fetched_at: NOW, decentro_txn_id: callbackData.decentroTxnId }, { where: { transaction_id: transactionId }});

3. Parse Aadhaar XML: const aadhaarXmlBase64 = callbackData.documents[0].data; const aadhaarXmlDecoded =Buffer.from(aadhaarXmlBase64, 'base64').toString('utf-8'); const aadhaarData =parseAadhaarXML(aadhaarXmlDecoded); // Parsed data structure: { uid: "123456789012", // Full Aadhaar number name:"Vijay Sharma", gender: "M", dob: "15-01-1985", careof: "S/O Ramesh Sharma", house: "123", street: "Main Street",landmark: "Near Delhi Metro", locality: "Connaught Place", vtc: "New Delhi", subdist: "New Delhi", dist: "New Delhi",state: "Delhi", pincode: "110001", photo_base64: "<base64-image>", mobile: "+919876543210" // If available }

4. Storeextracted data: await db.aadhaar_verification_digilocker.create({ lead_id: leadId, transaction_id: transactionId, // Aadhaar details aadhaar_number: aadhaarData.uid, aadhaar_number_masked: maskAadhaar(aadhaarData.uid), full_name:aadhaarData.name, gender: aadhaarData.gender, dob: aadhaarData.dob, care_of: aadhaarData.careof, // Addressaddress_line1: `${aadhaarData.house}, ${aadhaarData.street}`, address_line2: `${aadhaarData.landmark}, ${aadhaarData.locality}`, city: aadhaarData.vtc, district: aadhaarData.dist, state: aadhaarData.state, pincode:aadhaarData.pincode, full_address: buildFullAddress(aadhaarData), // Photo photo_base64: aadhaarData.photo_base64, // XML data aadhaar_xml: aadhaarXmlDecoded, // Metadata fetched_at: NOW, source: 'digilocker', verification_status:'fetched' });

5. Cross-match with lead data: const lead = await db.leads.findById(leadId); const nameMatch =fuzzyMatch(aadhaarData.name, lead.fullName); const dobMatch = (aadhaarData.dob === lead.dob); const phoneMatch =aadhaarData.mobile ? (aadhaarData.mobile === lead.phone) : null;

6. Update verification status: const overallStatus =(nameMatch.score > 80 && dobMatch) ? 'success' : 'failed'; await db.aadhaar_verification_digilocker.update({verification_status: overallStatus, name_match_score: nameMatch.score, dob_match: dobMatch, phone_match:phoneMatch, verified_at: NOW }, { where: { transaction_id: transactionId } });

7. Notify admin (WebSocket or push notification): await sendAdminNotification({ type: 'digilocker_document_received', leadId: leadId, message: 'Aadhaar received from Digilocker', verificationStatus: overallStatus }); 8. Store photo for face match: awaitdb.kyc_documents.create({ lead_id: leadId, document_type: 'aadhaar_photo_digilocker', file_data_base64:aadhaarData.photo_base64, source: 'digilocker', uploaded_at: NOW });

### Response Status

200: Success

400: Invalid DCTL ID, Failure: Invalid Reference ID, Failure: Invalid Consent

### ADMIN VIEW - AFTER DOCUMENT RECEIVED

| **AADHAAR VERIFICATION** (via **Digilocker**)                     **Status**: Response Awaited** |
| --- |
| STEP 2 COMPLETED: Document Received from Digilocker AADHAAR DETAILS (Extracted from Digital XML) Transaction ID: DIGI-IT-2026-123-1722012345678 Fetched At: 26-Jul-2026 11:45 AM  Source:DigiLocker ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ Field Name Input Data Document Data (From API) Action Match Result Name Name (From Lead) "name" [Run Match Engine](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-data-forensics-match-engine)/Manual Validation ≥80%: Strong Match <80%: Weak Match Gender  First letter: Gender (From Lead) "gender" [Run Match Engine](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-data-forensics-match-engine)/Manual Validation ≥80%: Strong Match <80%: Weak Match DOB DOB (From Lead) "dob" [Run Match Engine](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-data-forensics-match-engine)/Manual Validation ≥80%: Strong Match <80%: Weak Match Father/Husband Name Father/Hunband Name (Lead) S/O RAMESH SHARMA [Run Match Engine](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-data-forensics-match-engine)/Manual Validation ≥80%: Strong Match <80%: Weak Match Address Address (From Lead) "proofOfAddress" [Run Match Engine](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-data-forensics-match-engine)/Manual Validation ≥80%: Strong Match <80%: Weak Match Mobile Mobile (From Lead): "hashedMobileNumber" [Run Match Engine](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-data-forensics-match-engine)/Manual Validation ≥80%: Strong Match <80%: Weak Match PHOTOGRAPH  [Passport Size Photo]           (from lead) [View Full Size] [Aadhaar Photo]           (from XML) [View Full Size] [Run Face Match](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-face-forensics-face-match-v3)/Manual Validation ≥90%: Strong Match; 75-89%: Moderate Match; <75%: Mismatch ADMIN NOTES Aadhaar verified via Digilocker. All details match. High confidence. Photo extracted and available for face match verification. ADMIN DECISION [✓ Accept Verification] [✗ Reject Verification] [⚠️ Request More Docs ] |

**CARD 2: PAN VERIFICATION: **[**DOCUMENT LINK**](https://docs.decentro.tech/docs/kyc-and-onboarding-identities-verification-services-customer-verification)

| **PAN VERIFICATION                                                                       Status: Pending** |
| --- |
| INPUT DATA                                                                                         [[Autofill OCR](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-document-forensics-document-extraction)] ├─ PAN Number (From PAN): ABCDE1234F                           [✏️ Edit if OCR wrong] ├─ PAN Status (Default): Active ├─ PAN Type (Default): Personal ├─ Name (From Lead): VIJAY SHARMA ├─ DOB (From Lead): 15-01-1985 ├─ Aadhaar Number (From Lead): XXXX-XXXX-3456            ├─ Address (From Lead): 123 Main St, Delhi-110001 ├─ Gender (From Lead): Male ├─ Mobile (From Lead): +91 9876543210 └─ Email (From Lead): vijay.sharma@example.com (optional) VERIFICATION OPTIONS [Initiate PAN] Field Name Input Data Document Data (From API) Action Match Result PAN Status PAN Status (Default) "idStatus" /"panStatus"  [Run Match Engine](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-data-forensics-match-engine)/Manual Validation  ≥80%: Strong Match <80%: Weak Match PAN Type (Default) PAN Type (Default) "category"  [Run Match Engine](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-data-forensics-match-engine)/Manual Validation  ≥80%: Strong Match <80%: Weak Match Name Name (From Lead) "name"  [Run Match Engine](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-data-forensics-match-engine)/Manual Validation  ≥80%: Strong Match <80%: Weak Match Gender First Letter: Gender (From Lead) "gender"  [Run Match Engine](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-data-forensics-match-engine)/Manual Validation ≥80%: Strong Match <80%: Weak Match DOB DOB (From Lead) "dateOfBirth"  [Run Match Engine](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-data-forensics-match-engine)/Manual Validation ≥80%: Strong Match <80%: Weak Match Aadhaar Number Aadhaar Number (From Lead) "maskedAadhaar" [Run Match Engine](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-data-forensics-match-engine)/Manual Validation ≥80%: Strong Match <80%: Weak Match Address Address (From Lead) "full" [Run Match Engine](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-data-forensics-match-engine)/Manual Validation ≥80%: Strong Match <80%: Weak Match Mobile Mobile (From Lead) "mobile" [Run Match Engine](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-data-forensics-match-engine)/Manual Validation ≥80%: Strong Match <80%: Weak Match ADMIN NOTES PAN verified successfully |

| ADMIN DECISION [✓ Accept] [✗ Reject] [⚠️ Request More Docs **]** |
| --- |

### Manual Entry Policy

- Audit Log: Store data_source = **"**manual**"** | **"**ocr**" CARD 3: BANK ACCOUNT VERIFICATION **[**Document link**](https://docs.decentro.tech/reference/validate-bank-account-v3)

| **BANK ACCOUNT VERIFICATION                                                     Status:  Pending** |
| --- |
| INPUT DATA                                                                                        [[Autofill OCR](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-document-forensics-document-extraction)] ├─ Account Holder Name: Vijay Sharma [✏️ Edit] ├─ Account Number: 1234567890123 [✏️ Edit] ├─ IFSC Code: HDFC0001234 [✏️ Edit] ├─ Bank Name: HDFC Bank [✏️ Edit] └─ Branch: Connaught Place, Delhi [✏️ Edit] VERIFICATION OPTIONS Bank Verification APIs Cost Action Pennydrop ₹1.50 + Pennydrop Amount [Run API] Penniless ₹1.50 [Run API] Pennydrop (Name Match) ₹1.50 + Pennydrop Amount [Run API] VERIFICATION RESULTS (After Penny Drop) Account Status: Valid/Invalid/Inconclusive/NRE/Blocked/Blacklisted Account Holder Name (Bank): VIJAY SHARMA Name Match: 95% (if applicable)  Bank Reference Number: 417110293521 validation_message: The account has been successfully verified. ADMIN NOTES  Bank account verified, name matches ADMIN DECISION  [✓ Accept]     [✗ Reject]     [⚠️ Request More Docs ] |

### Business Rules

- Name match threshold: 100%

- Cross-match with Aadhaar name

- Retry limit: 3 attempts

**CARD 4: CIBIL CREDIT SCORE:**[** Document Link1**](https://docs.decentro.tech/docs/bytes-credit-bureau) [**Document Link2**](https://docs.decentro.tech/reference/financial_api-customer-data-pull)

| **CIBIL CREDIT SCORE                                                                       Status:  Pending** |
| --- |
| INPUT DATA (From Lead)            ├─ Name: VIJAY SHARMA ├─ PAN: ABCDE1234F ├─ DOB: 15-01-1985 ├─ Mobile: +91 9876543210 └─ Address: Delhi VERIFICATION OPTIONS Report Type Cost Action Credit Score Only ₹4.00 [Get Score] Credit Report Summary ₹20.00 [Get Report] VERIFICATION RESULTS (Score Only) CIBIL SCORE: 780  Risk Category: LOW Credit Report ID: CIBIL-20260726-ABC123 Generated: 26-Jul-2026 11:30 AM Score Interpretation: 750+ = Excellent (Low Risk) 700-749 = Good (Low Risk) 650-699 = Moderate (Medium Risk) <650 = Poor (High Risk) → Co-borrower needed SUMMARY DATA (if Full Report run) Active Loans: 2 Total Outstanding: ₹1,50,000 Credit Utilization: 35% Payment Defaults: 0  Recent Enquiries (30 days): 1 Oldest Account Age: 8 years Credit Mix: 70% Secured, 30% Unsecured  ADMIN NOTES  Ok ADMIN DECISION  [✓ Accept]     [✗ Reject]     [⚠️ Need Co-Borrower KYC ] |

**CARD 5: RC to Chassis Check **[**Document**](https://docs.decentro.tech/reference/rc-to-chasis)

| **RC to Chassis (Vehicle)                                                   Status: ⏳ Pending** |
| --- |
| INPUT DATA ├─ RC Number: DL-3C-A-7889 [✏️ Edit]                                                         [[Autofill OCR](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-document-forensics-document-extraction)]  [Initiate Verification] RC Number Chassis Number RC Number "chassisNumber" ADMIN NOTES  Ok ADMIN DECISION  [✓ Accept]     [✗ Reject]     [⚠️ Request More Docs ] |

### **Audit Log Structure**

CREATE TABLE kyc_data_audit (

  id INT PRIMARY KEY,

  lead_id INT,

  field_name VARCHAR(50),

  field_value VARCHAR(200),

  data_source ENUM('ocr', 'api', 'manual'),

  entered_by INT, -- Admin user ID

  entered_at TIMESTAMP,

  reason TEXT -- Why manual entry was needed

);

---

## Part D — Step 3: Conditional Re-verification (Supporting Docs / Co-Borrower)

### Admin request scenarios

After reviewing the primary applicant's KYC in Step 2, iTarang Admin may identify conditions requiring further information. Step 3 is a conditional, gated workflow step that appears only when Admin triggers one of the following:

| **Scenario** | **Trigger Condition** | **Admin Action** |
| --- | --- | --- |
| **Scenario 1** | Supporting documents needed (PAN unclear, bank statement incomplete, address expired, RC illegible) | Request Additional Documents → Specific doc type(s) flagged with admin reason and deadline |
| **Scenario 2** | CIBIL <650 │ Income insufficient │ High DTI ratio │ No credit history │ Risk flag | Request Co-Borrower KYC → Full KYC required for co-borrower (same as primary applicant) |
| **Scenario 3** | Both: supporting docs AND co-borrower needed simultaneously | Request Both — Step 3 shows two sections: Section A (Supporting Docs) + Section B (Co-Borrower KYC) |

## **Final Decision Panel — Always Visible at Bottom of Screen**

The Final Decision Panel is pinned to the bottom of the admin Step 3 review screen and is always visibl. It contains three actions:

| **Button** | **Lead Status Written** | **Conditions **&** Behaviour** |
| --- | --- | --- |
| **Approve** | step_3_cleared → Step 4 unlocked | Enabled only when every individual verification card has been Approved (✓). Mandatory admin notes before confirming. Triggers dealer + customer notification. |
| **Reject** | kyc_rejected → Lead closed | Available at any time regardless of card states. Mandatory rejection reason. Lead is permanently closed. Dealer + customer notified. |
| **Dealer Action Required** | awaiting_additional_docs │ awaiting_co_borrower_replacement │ awaiting_doc_reupload — whichever is applicable | Used when one or more cards are in Rejected or Request More Docs state. Saves all per-card decisions and pushes the consolidated outstanding requests back to the dealer. Step 3 re-opens on the dealer side showing exactly which cards need action. Dealer notified via SMS + email + dashboard push. |

# Approve Lead = Submit Decision after Approve. Reject Lead = Submit Decision after Reject. Dealer Action Required = the new third action specific to Step 3, replacing the previous 'Request More Info' radio option with an explicit save-and-route-back mechanism

### How Per-Card Decisions Drive the Final Panel

| **Card State Combination** | **Approve Lead** | **Save Available** |
| --- | --- | --- |
| All cards → ✓ Approved | ✅ Enabled | Also available (admin can save before submitting final) |
| One or more cards → ✗ Rejected or ⚠️ Request More Docs | 🔒 Disabled | ✅ Enabled — this is the expected action |
| Any state | N/A | ❌ Reject Lead always available regardless of card state |

### Status Written to Lead — Save Action Routing

When admin clicks Dealer Action Required, the status written depends on which cards triggered the save:

| **Reason for Save** | **kyc_status Written** |
| --- | --- |
| Supporting doc(s) rejected or additional doc requested | awaiting_additional_docs |
| Co-borrower check(s) rejected — same co-borrower can resubmit | awaiting_co_borrower_kyc |
| Co-borrower CIBIL / identity failed — new co-borrower required | awaiting_co_borrower_replacement |
| Mix of supporting doc issue + co-borrower issue | awaiting_both |

### Admin Request Forms — Triggered from Request More Docs

### **Request Additional Documents Form**

Opened when admin clicks **'Request More Docs'** on a supporting document or primary applicant check card:

- Document checklist with reason per item (visible to dealer)

- Primary applicant documents: Aadhaar Front / Back, PAN, Passport Photo, Bank Statement, Address Proof, Cheques, RC Copy

- Custom documents: Salary Slips, ITR, Business Proof, Other (free text)

- Notification toggles: SMS to customer, Email to dealer, Push to dashboard

### **Request Co-Borrower KYC Form**

Opened when admin clicks ⚠️ Request More Docs on a co-borrower check, or selects the co-borrower option from the primary KYC Final Decision Panel:

- Written reason field — visible to dealer (explains CIBIL / income issue)

- Required documents pre-set to full KYC list (11 docs, same as primary applicant)

- Notification toggles: same three channels as above

**DEALER SIDE — STEP 3 SCREEN SPECIFICATION Gating Rule — When Step 3 Appears**

Step 3 is a conditional, interim step. It appears in the workflow navigation only when the lead's kyc_status matches one of the following values:

Canonical status check (fixes Issue #4)

const showStep3 = [

  'awaiting_additional_docs',

  'awaiting_co_borrower_kyc',

  'awaiting_both'

].includes(lead.kyc_status);

If showStep3 is false, Step 3 is skipped entirely. The workflow progress bar jumps from Step 2 directly to Step 4 (Product Selection).

Step 4 and Step 5 are blocked until Step 3 is submitted and reviewed by Admin (unless Step 3 does not exist for this lead).

### Screen Header **&** Progress Indicator

| **Screen Title** | **Other Documents **&** Co-Borrower KYC** |
| --- | --- |
| **Reference ID Display** | **#IT-2026-XXXXXXX** |
| **Workflow Progress Label** | **Interim Step (highlighted in progress bar)** |
| **Progress Bar State** | **Step 1 ✅ → Step 2 ✅ → Step 3 ⏳ (active) → Step 4 🔒 → Step 5 🔒** |

### Admin Request Banner (Always Visible on Step 3)

At the top of Step 3 screen, a read-only banner displays the admin's request details:   **Admin request date Section A — Supporting Documents (Primary Applicant)**

Visible only when:** kyc_status is 'awaiting_additional_docs' or 'awaiting_both'**

### **Dynamic Card Display Logic The backend** returns only the documents the admin requested. The screen renders one card per requested document. No static document list is shown.**

### **Each Document Card Contains**

| **Field** | **Description** |
| --- | --- |
| Card Title | Document name (e.g. 'Bank Statement — Complete 3 months') |
| Required / Optional Badge | Red asterisk (*) for required. 'Optional' text for optional. |
| Admin Reason | Admin's reason text from request form. Non-editable. |
| Upload Button | Opens file picker. Accepts: PDF, PNG, JPEG. Max: 5 MB. |
| Upload Status | Not Uploaded │ Uploading... │ Uploaded — Pending Review │ Verified ✅ │ Rejected ❌ |
| Uploaded Timestamp | Shown after upload: 'Uploaded: DD-MMM HH:MM AM/PM' |
| View / Replace Buttons | Shown after upload. Replace opens picker again. |

### **Section A Footer**

'Documents Uploaded: X / Y   |   Documents Pending: [list of pending doc names]'

This footer updates in real-time as uploads complete

### Section B — Co-Borrower KYC

Visible only when: **kyc_status is 'awaiting_co_borrower_kyc' or 'awaiting_both'**

### **Sub-section B1 — Co-Borrower Information Form Dealer fills the following fields:**

| **Field** | **Type** | **Validation** |
| --- | --- | --- |
| **Full Name** | **Text** | **Required. Min 2 chars.** |
| **Father / Husband Name** | **Text** | **Required.** |
| **Date of Birth** | **Date picker** | **Age ≥ 18. Must be a valid date.** |
| **Phone Number** | **Numeric** | **10 digits. Must NOT match primary applicant's phone (Issue #6 related — prevent same-person co-borrower).** |
| **Permanent Address** | **Text** | **Required.** |
| **Current Address** | **Text** | **Required. Checkbox: 'Same as Permanent' to auto-fill.** |
| **PAN Number** | **Text** | **Format: AAAAA9999A. Required.** |
| **Aadhaar Number** | **Numeric** | **12 digits. Stored masked. Required.** |
| **Relationship to Applicant** | **Dropdown** | **Spouse │ Parent │ Sibling │ Other. Required.** |

Auto-fill from ID button: pre-fills fields from uploaded Aadhaar OCR if available.

### **Sub-section B2 — Co-Borrower Document Upload Cards**

Identical card style to primary applicant KYC:

| **#** | **Document** | **Notes** | **Format** | **Required** |
| --- | --- | --- | --- | --- |
| 1 | Aadhaar Front |  | PNG/JPEG/PDF | Yes |
| 2 | Aadhaar Back |  | PNG/JPEG/PDF | Yes |
| 3 | PAN Card |  | PNG/JPEG/PDF | Yes |
| 4 | Passport Size Photo |  | PNG/JPEG | Yes |
| 5 | Address Proof | Not expired | PNG/JPEG/PDF | Optional |
| 6 | Bank Statement | 3 months minimum | PDF | Optional |
| 7-10 | Undated Cheques (4) | Separate card per cheque | PNG/JPEG | Optional |
| 11 | Consent (Digital or Manual) | See Sub-section B3 | PDF | Yes |

**Documents Uploaded: **X/11 shown below the card grid. Pending documents listed by name.

### **Sub-section B3 — Co-Borrower Consent**

| **Option** | **Behaviour** |
| --- | --- |
| **Send SMS/WhatsApp Consent** | **Triggers OTP-based eSign link to co-borrower's mobile. Consent status updates to 'link_sent'.** |
| **Generate Consent PDF** | **Downloads a pre-filled consent PDF for manual signature.** |
| **Upload Signed Consent PDF** | **Dealer uploads scanned signed PDF. Marked as 'manual_uploaded' pending admin review.** |

Consent Status badge (right-aligned): Not Started | Link Sent | Awaiting Signature | Success | Failed

### Verification Action Block (Coupon + Submit) Coupon Conditional Display

The coupon input block is shown ONLY when co-borrower KYC is included (kyc_status = awaiting_co_borrower_kyc or awaiting_both). For supporting documents only, no new coupon is needed — the original lead coupon covers re-verification. Hiding the coupon block in docs-only requests prevents dealer confusion.

| **Element** | **Behaviour** |
| --- | --- |
| Coupon Code Input | Shown only if co-borrower KYC requested. Required before Submit. |
| Validate Button | Calls POST /api/coupons/validate. Shows cost estimate on success. |
| Submit for Verification Button | Enabled only when all gating conditions are met (see 2.9.3.7). |

### Gating Rule — Submit Button Enable Conditions

| **Request Type** | **Conditions to Enable Submit** |
| --- | --- |
| Supporting Documents Only | All required supporting doc cards uploaded. No coupon required. |
| Co-Borrower KYC Only | Co-borrower info form complete. All 11 docs uploaded. Consent obtained. Coupon validated. |
| Both | All required supporting docs uploaded AND all co-borrower conditions met AND coupon validated. |

### Verification Status Table (Co-Borrower) —

Consent Row Placeholder Removed

The 'Content / Content / Pending' row found in the reference draft has been replaced with the correct 'Consent Verification' row below

| **Check** | **Status** | **Last Update** | **Action** | **Failed Reason** |
| --- | --- | --- | --- | --- |
| Aadhaar Verification | System initiating data fetch | — | Button |  |
| PAN Verification | Awaiting action | — | Button |  |
| Bank Verification | Awaiting action | — | Edit |  |
| Address Proof | Failed | — | Edit | Address not matching Aadhaar |
| RC Verification | Pending | — | Edit | Image Blur |
| Mobile Number | Success | — | Edit |  |
| Consent Verification | Pending | — | View |  |

### Other Documentation (Admin-Requested Extra Cards)

Below the verification status table, a section titled 'Other Documentation' shows additional doc request cards that do not fit into the standard document upload grid. Each card displays:

- Document name / label (as set by admin)

- Admin comment / reason (read-only)

- Required indicator (red asterisk)

- Upload button

Cards are rendered dynamically from the admin's request. The number of cards varies.

### Bottom Action Bar

| **Button** | **Position** | **Style** | **Behaviour** |
| --- | --- | --- | --- |
| Back | Bottom left | Secondary | Navigate to Step 2 (read-only view). |
| Save Draft | Bottom centre | Secondary | Saves progress without submitting. Lead stays in awaiting_* status. |
| Preview Customer Profile | Bottom right | Primary | Opens read-only full profile view of primary + co-borrower. |
| Submit for Verification | Floating / in Verification Action block | Primary, disabled until conditions met | Submits to admin. Status → pending_itarang_reverification. |

### ADMIN SIDE — STEP 3 APPEND VIEW

When Admin opens a lead in status 'pending_itarang_reverification' that had a Step 3 request, the existing Admin KYC screen  is extended with new appended panels below the primary KYC panels. The primary KYC is read-only. No data is overwritten

### Screen Layout — Appended Sections

| **Panel #** | **Panel Title** | **Content** |
| --- | --- | --- |
| 1 | Primary Customer KYC (existing) | Original lead KYC — read-only. All original verification cards from Section 2.8. No changes. |
| 2 | Supporting Documents (Appended) | Shown only if supporting docs were requested. Displays all uploaded docs with admin review actions. |
| 3 | Co-Borrower KYC (Appended) | Shown only if co-borrower was requested. Full co-borrower profile, document cards, and verification execution cards. |
| 4 | Final Decision | Combined decision panel covering both supporting docs and co-borrower outcome. |

### Panel 2 — Supporting Documents Review

For each uploaded supporting document, admin sees the document card followed by a three-button action block. Admin must act on each document individually before the Final Decision Panel becomes active

### **Per-Document Card Fields**

•       Document name + admin's original request reason

•       Requested date | Uploaded date

•       [View Document] button — opens file in modal viewer

•       Admin Notes field — free text, visible internally

### **Per-Document Action Buttons (3 buttons per card)**

| **Button** | **Label** | **Behaviour** |
| --- | --- | --- |
| **1** | **Approve** | Marks this specific document as accepted. Admin can add an optional approval note before confirming. Document status → 'verified'. Button turns green / disabled after action. |
| **2** | **Reject** | Marks this document as rejected. Admin must enter a rejection reason (mandatory text field). Document status → 'rejected'. Triggers re-upload request for this specific document on dealer side. |
| **3** | **Request Docs** | Opens a mini-request form to ask for an additional/supplementary document related to this check (e.g. requesting a clearer scan, or an extra page). This triggers Step 3 to reopen on the dealer side with the new request appended. Lead status → 'awaiting_additional_docs'. |

All three buttons are mutually exclusive per document card. Once one action is taken, the other two are disabled for that card. Admin can undo and re-act until the Final Decision is submitted

### Re-upload Loop

If Admin uses Reject or Request Docs on a supporting document, the lead status is set to 'awaiting_doc_reupload'. Step 3 re-opens on dealer side with the affected card highlighted in red and the admin's rejection reason visible. Step 4 remains blocked until re-upload and admin re-acceptance.

### Panel 3 — Co-Borrower KYC Review

### **Co-Borrower Profile Summary**

Read-only display: Full Name, DOB, Phone, Relationship, PAN, Aadhaar (masked), Addresses.

### **Co-Borrower Document Cards — Per-Check Action Buttons**

Each verification check (Aadhaar, PAN, Bank, CIBIL, Face Match, Address, Consent) is presented as a card with identical three-button action logic as per last section. Admin must act on each check independently:

| **Button** | **Label** | **Behaviour** |
| --- | --- | --- |
| **1** | **Approve** | **Approves this specific check / document for the co-borrower. Admin may add an optional note. Check status → 'verified'.** |
| 2 | Reject | Rejects this check. Mandatory rejection reason text required. Check status → 'rejected'. If CIBIL is rejected (score <700), this feeds into the co-borrower rejection decision. |
| 3 | Request Docs | Requests supplementary documentation for this specific check from the dealer. E.g. if Address Proof fails, admin can request an alternative address document. This triggers Step 3 to reopen on dealer side. Lead status → 'awaiting_additional_docs'. |

### **Co-Borrower API Verification Cards**

Same verification cards as primary applicant. Each card includes the three action buttons above:

| **#** | **Verification Card** | **Notes** |
| --- | --- | --- |
| 1 | Aadhaar (Digilocker SSO) | Uses co-borrower Aadhaar number |
| 2 | PAN Verification | Cross-match with Aadhaar name |
| 3 | Face Match | Passport photo vs Aadhaar photo |
| 4 | Bank Account Verification | Penny drop to confirm account |
| 5 | Address Proof Verification | OCR + manual check |
| 6 | CIBIL Score | Key decision: co-borrower must score ≥700 |

### Panel 4 — Step 3 Final Decision Panel

The Final Decision Panel is always visible at the bottom of the Admin Step 3 review screen. It becomes actionable only after admin has taken an Approve / Reject / Request Docs action on every individual check card above. It contains exactly three actions:

| **#** | **Button** | **Lead Status Written** | **Behaviour **&** Notes** |
| --- | --- | --- | --- |
| 1 | Approve Lead | step_3_cleared → Step 4 (Product Selection) unlocked | All checks passed. Mandatory admin notes field before confirming. Triggers dealer + customer notification: 'KYC approved — proceed to product selection.' |
| 2 | Reject Lead | kyc_rejected → Lead closed | Full KYC rejection. Mandatory rejection reason. Lead is marked closed. Triggers dealer + customer notification. No further action possible on this lead. |
| 3 | Dealer Action Required | awaiting_additional_docs │ awaiting_co_borrower_replacement │ awaiting_doc_reupload — whichever applies | Used when one or more individual checks were Rejected or had 'Request Docs' triggered. Saves the admin's per-check decisions and pushes the combined outstanding requests back to the dealer. Step 3 re-opens on dealer side showing exactly which items need action. Dealer is notified via SMS + email + dashboard push. |

### Business Rule — Save vs Approve

Approve Lead is only enabled when ALL individual check cards have been approved (green). If any card is in Rejected or Request Docs state, only Save (Dealer Action Required) and Reject Lead are available. This prevents partial approvals from slipping through.

Co-Borrower Replacement via Save

When the admin rejects the co-borrower's CIBIL or identity check and uses Save (Dealer Action Required), the system sets status 'awaiting_co_borrower_replacement'. Dealer Step 3 shows a banner: 'Previous co-borrower rejected. Reason: [admin reason]. Please submit a new co-borrower.' The co_borrower_requests table increments attempt_number.

Admin Notes field (global, applies to the final decision — separate from per-card notes). Required for Approve Lead and Reject Lead actions.

**NOTIFICATIONS**

| **Event** | **Recipient** | **Channels** |
| --- | --- | --- |
| **Admin requests Step 3** | **Dealer + Customer** | **SMS to customer, Email to dealer, Dashboard push** |
| **Dealer submits Step 3** | **Admin** | **Dashboard notification + queue entry** |
| **Supporting doc rejected** | **Dealer** | **Dashboard push + Email** |
| **Co-borrower rejected** | **Dealer + Customer** | **SMS + Email + Dashboard** |
| **Step 3 approved** | **Dealer + Customer** | **SMS + Email + Dashboard** |
| **Deadline approaching (24h)** | **Dealer + Customer** | **SMS + Dashboard reminder** |

### STATUS FLOW — COMPLETE STEP 3 LIFECYCLE

| **Status** | **Triggered By** | **Next Status** |
| --- | --- | --- |
| **awaiting_additional_docs** | **Admin — Request Docs** | **pending_itarang_reverification** |
| **awaiting_co_borrower_kyc** | **Admin — Request Co-Borrower** | **pending_itarang_reverification** |
| **awaiting_both** | **Admin — Request Both** | **pending_itarang_reverification** |
| **pending_itarang_reverification** | **Dealer — Submit Step 3** | **reverification_in_progress** |
| **reverification_in_progress** | **Admin — Reviewing** | **step_3_cleared │ awaiting_doc_reupload │ awaiting_co_borrower_replacement │ kyc_rejected** |
| **awaiting_doc_reupload** | **Admin — Doc Rejected** | **pending_itarang_reverification (on re-submit)** |
| **awaiting_co_borrower_replacement** | **Admin — Co-Borrower Rejected** | **pending_itarang_reverification (on new co-borrower submit)** |

---

## Part E — Step 4: Product Selection (Cash & Finance split)

| **step_3_cleared** | **Admin — Approve Step 3** | **Lead proceeds to Step 4: Product Selection** |
| **kyc_rejected** | **Admin — Full Rejection** | **Lead closed** |

### DATABASE SCHEMA

## **additional_document_requests**

| **Column** | **Type** | **Notes** |
| --- | --- | --- |
| **id** | **INT PK AUTO** |   |
| **request_id** | **VARCHAR(50) UNIQUE** | **ADR-YYYYMMDD-NNN** |
| **lead_id** | **INT FK** | **references leads(id)** |
| **requested_by** | **INT FK** | **references admin_users(id)** |
| **requested_at** | **TIMESTAMP** |   |
| **request_type** | **ENUM** | **'supporting_documents' │ 'co_borrower' │ 'both'** |
| **documents_requested** | **JSON** | **Array of {documentCode, reason, required}** |
| **admin_reason** | **TEXT** | **Visible to dealer** |
| **deadline** | **TIMESTAMP** |   |
| **status** | **ENUM** | **'pending' │ 'partially_uploaded' │ 'complete' │ 'overdue'** |
| **completed_at** | **TIMESTAMP NULL** |   |

 additional_document_uploads**

| **Column** | **Type** | **Notes** |
| --- | --- | --- |
| **id** | **INT PK AUTO** |   |
| **request_id** | **VARCHAR(50) FK** | **references additional_document_requests** |
| **lead_id** | **INT FK** |   |
| **document_code** | **VARCHAR(50)** |   |
| **file_url** | **TEXT** |   |
| **file_size** | **INT** | **bytes** |
| **uploaded_at** | **TIMESTAMP** |   |
| **uploaded_by** | **INT FK** | **references dealer_users** |
| **status** | **ENUM** | **'uploaded' │ 'verified' │ 'rejected'** |
| **verified_by** | **INT NULL FK** |   |
| **verified_at** | **TIMESTAMP NULL** |   |
| **rejection_reason** | **TEXT NULL** |   |

 co_borrower_requests**

| **Column** | **Type** | **Notes** |
| --- | --- | --- |
| **id** | **INT PK AUTO** |   |
| **request_id** | **VARCHAR(50) UNIQUE** | **CBR-YYYYMMDD-NNN** |
| **lead_id** | **INT FK** |   |
| **requested_by** | **INT FK** |   |
| **requested_at** | **TIMESTAMP** |   |
| **reason** | **TEXT** |   |
| **requirements** | **JSON** | **{minCibilScore, relationship[], incomeProof}** |
| **required_documents** | **JSON** | **Array of document codes** |
| **deadline** | **TIMESTAMP** |   |
| **attempt_number** | **INT DEFAULT 1** | **Increments on co-borrower replacement (Issue #6)** |
| **status** | **ENUM** | **'pending' │ 'submitted' │ 'approved' │ 'rejected'** |

 co_borrowers**

| **Column** | **Type** | **Notes** |
| --- | --- | --- |
| **id** | **INT PK AUTO** |   |
| **co_borrower_id** | **VARCHAR(50) UNIQUE** | **CB-NNN** |
| **lead_id** | **INT FK** |   |
| **full_name** | **VARCHAR(200)** |   |
| **father_husband_name** | **VARCHAR(200)** |   |
| **dob** | **DATE** |   |
| **gender** | **ENUM('M','F','T')** |   |
| **phone** | **VARCHAR(20)** | **Must differ from primary applicant phone** |
| **email** | **VARCHAR(100) NULL** |   |
| **permanent_address** | **TEXT** |   |
| **current_address** | **TEXT** |   |
| **pan_number** | **VARCHAR(20)** |   |
| **aadhaar_number_masked** | **VARCHAR(20)** | **Last 4 visible** |
| **relationship** | **ENUM** | **'spouse' │ 'parent' │ 'sibling' │ 'other'** |
| **kyc_status** | **ENUM** | **'pending' │ 'in_progress' │ 'approved' │ 'rejected'** |
| **aadhaar_verified** | **BOOLEAN DEFAULT FALSE** |   |
| **pan_verified** | **BOOLEAN DEFAULT FALSE** |   |
| **bank_verified** | **BOOLEAN DEFAULT FALSE** |   |
| **cibil_score** | **INT NULL** | **Target ≥700** |
| **cibil_verified** | **BOOLEAN DEFAULT FALSE** |   |
| **created_at** | **TIMESTAMP** |   |
| **created_by** | **INT FK** | **dealer_user_id** |
| **verified_at** | **TIMESTAMP NULL** |   |
| **verified_by** | **INT NULL FK** | **admin_user_id** |

## **Co_borrower_consent consent_type Nullable**

consent_type DEFAULT NULL is correctly set to avoid INSERT errors when consent has not yet been initiated. The application layer sets it to 'digital' or 'manual' when the dealer initiates the consent process.

| **Column** | **Type** | **Notes** |
| --- | --- | --- |
| id | INT PK AUTO |  |
| co_borrower_id | VARCHAR(50) FK |  |
| consent_type | ENUM NULL DEFAULT NULL | 'digital' │ 'manual' │ NULL (not yet selected) — Issue #7 fix |
| consent_link_url | TEXT NULL |  |
| consent_link_sent_at | TIMESTAMP NULL |  |
| esign_transaction_id | VARCHAR(100) NULL |  |
| esign_completed_at | TIMESTAMP NULL |  |
| manual_pdf_uploaded_at | TIMESTAMP NULL |  |
| manual_pdf_url | TEXT NULL |  |
| consent_status | ENUM | 'not_started' │ 'link_sent' │ 'esign_in_progress' │ 'esign_completed' │ 'manual_uploaded' │ 'admin_review_pending' │ 'admin_verified' │ 'admin_rejected' |
| verified_by | INT NULL FK |  |
| verified_at | TIMESTAMP NULL |  |

 **co_borrower_documents**

| **Column** | **Type** | **Notes** |
| --- | --- | --- |
| id | INT PK AUTO |  |
| co_borrower_id | VARCHAR(50) FK |  |
| document_type | VARCHAR(50) |  |
| file_url | TEXT NULL |  |
| file_size | INT NULL |  |
| uploaded_at | TIMESTAMP NULL |  |
| uploaded_by | INT NULL FK |  |
| status | ENUM | 'not_uploaded' │ 'uploaded' │ 'verified' │ 'rejected' |
| verified_by | INT NULL FK |  |
| verified_at | TIMESTAMP NULL |  |
| rejection_reason | TEXT NULL |  |

# **COMPLETE WORKFLOW SUMMARY **

| **Step** | **Actor** | **Action **&** Outcome** |
| --- | --- | --- |
| 1 | Dealer | Uploads primary customer KYC documents. Consent obtained. Coupon validated. Submits Step 2. |
| 2 | Admin | Reviews primary KYC. Runs verification APIs. Identifies issues (e.g. CIBIL 620, bank statement incomplete). Selects appropriate option from Final Decision Panel. |
| 3 | System | Sets lead kyc_status to 'awaiting_additional_docs' │ 'awaiting_co_borrower_kyc' │ 'awaiting_both'. Sends notifications to dealer + customer. |
| 4 | Dealer | Step 3 tab appears in workflow. Uploads required supporting docs (Section A) and/or fills co-borrower KYC (Section B). Validates co-borrower coupon (if applicable). Submits Step 3. |
| 5 | System | Sets status to 'pending_itarang_reverification'. Adds to Admin queue (high priority). Notifies admin. |
| 6 | Admin | Opens lead. Sees primary KYC (unchanged) + appended panels. Reviews supporting docs. Runs co-borrower API verifications (with cost-confirm modal). Makes Step 3 Final Decision. |
| 7a | Admin | Approves all → lead status = 'step_3_cleared' → Step 4 (Product Selection) unlocks. |
| 7b | Admin | Rejects supporting doc → status = 'awaiting_doc_reupload' → Step 3 re-opens on dealer side with rejected card highlighted. |
| 7c | Admin | Rejects co-borrower → status = 'awaiting_co_borrower_replacement' → Step 3 re-opens with replacement banner and attempt_number incremented. |
| 7d | Admin | Rejects KYC entirely → lead status = 'kyc_rejected' → lead closed. |

### Step 4: Product **Selection

Step 4 is the Product Selection page. It is reached after KYC is approved by iTarang Admin (finance flow) or immediately after Step 1 when payment_method = 'Cash'. The dealer maps physical inventory — battery serial, charger serial, and paraphernalia — to the lead, sets their margin, and submits for final approval. Once submitted, the product information is appended to the Admin KYC screen and the lead is routed to final approval

### Entry Conditions — When Step 4 Unlocks

| **Condition** | **Value** | **Step 4 Access** |
| --- | --- | --- |
| **Finance / Dealer Finance** | **lead.kyc_status = 'step_3_cleared' OR 'kyc_approved'** | **✅ Unlocked after Admin KYC approval (Steps 2-3 complete)** |
| **Cash Payment** | **lead.payment_method = 'Cash'** | **✅ Unlocked immediately after Step 1 — skips KYC heavy flow. No admin approval step. Dealer self-confirms sale.** |
| **Any other state** | **Any other kyc_status** | **🔒 Blocked — redirect to last valid step** |

| GET /api/lead/:leadId/step-4-access   Response (allowed): { "allowed": true, "paymentMode": "finance" │ "cash", "category": "3W", "subCategory": "E-Rickshaw" }   Response (blocked): { "allowed": false, "redirectTo": "/leads/:leadId/step-2" } |
| --- |

### STEP 4 SCREEN — DEALER SIDE Screen Header

| **Element** | **Value** |
| --- | --- |
| **Screen Title** | **Product Selection** |
| **Reference ID** | **Display: #IT-2026-XXXXXXX** |
| **Payment Mode Badge** | **Finance │ Cash (colour-coded, read-only)** |
| **Progress Bar** | **Step 1 ✅ → Step 2 ✅ → Step 3 ✅ → Step 4 ⏳ (active) → Step 5 🔒** |
| **Cash Badge** | **If payment_mode = Cash, a yellow banner: 'CASH SALE — KYC steps skipped' is shown below the header** |

### SECTION A — PRODUCT CATEGORY **&** SUB-CATEGORY Category **&** Sub-Category Selection

The category and sub-category are pre-filled from Step 1. The dealer may change them at this step — this is the last point at which category can be modified before inventory is locked.

| **Field** | **Pre-fill Source** | **Editable?** |
| --- | --- | --- |
| **Product Category** | **Step 1 lead.product_category** | **Yes — dropdown. Changing reloads inventory.** |
| **Product Sub-Category** | **Step 1 lead.product_sub_category** | **Yes — depends on category selection.** |

| POST /api/lead/:leadId/update-product-category   Request: { "category": "3W", "subCategory": "E-Rickshaw" }   Effect: Clears any previously selected battery/charger serial (cannot keep         cross-category inventory). Reloads inventory list. |
| --- |
| **Business Rule If a dealer** changes category at Step 4, any previously selected battery or charger serial is cleared and the inventory list refreshes. The dealer must re-select from the new category's stock.** |

### SECTION B — BATTERY SELECTION Battery Inventory Display

The battery list is fetched from the dealer's current inventory, filtered by the selected category and sub-category

| **GET /api/inventory/dealer/:dealerId/batteries      ?category=3W**&**subCategory=E-Rickshaw   Response: array of battery objects (see fields below) Sorting: ORDER BY invoice_date ASC  (oldest first — see priority rule)** |
| --- |

### **Battery Card — Fields Displayed**

| **Field** | **Source** | **Notes** |
| --- | --- | --- |
| **Serial Number** | **inventory.serial_number** | **Unique battery ID. Primary selection key.** |
| **Model** | **inventory.model** | **Battery model name** |
| **Invoice Date** | **inventory.invoice_date** | **Date stock was invoiced to dealer** |
| **Inventory Age** | **Calculated: TODAY − invoice_date** | **Displayed as: 'X days'. Highlighted orange if **>**90 days, red if **>**180 days.** |
| **SOC (State of Charge)** | **IoT backend (if available)** | **Shown as percentage (e.g. 78%). If unavailable: 'SOC: N/A'. Last sync timestamp shown.** |
| **Status** | **inventory.status** | **Available (selectable) │ Reserved (greyed out) │ Dispatched (hidden)** |

### Inventory Priority Rule — Oldest First Mandatory Business Rule — Ageing Priority

The system must default-sort inventory by invoice_date ASC so that the oldest available stock is presented first. This reduces dead stock and prevents dealers from cherry-picking newer units. The dealer may manually reorder the list but the recommended selection badge appears on the oldest available unit.

| **Age Bracket** | **UI Treatment** | **Badge** |
| --- | --- | --- |
| 0 - 90 days | Normal card | None |
| 91 - 180 days | Orange border on card | Ageing Stock |
| > 180 days | Red border on card | Old Stock — Prioritise |
| Oldest available unit | Highlighted card with tag | Recommended |

### SOC (State of Charge) Display

| **Condition** | **Display** |
| --- | --- |
| **IoT data available** | **SOC: 78% │ Last sync: DD-MMM-YYYY HH:MM** |
| **IoT data stale (**>**24h)** | **SOC: 78%  (last sync **>**24h ago) — data may be outdated** |
| **IoT data unavailable** | **SOC: N/A** |

| **GET /api/iot/battery/:serialNumber/soc   Response: { serial: 'BAT12345', soc_percent: 78, last_sync: '2026-07-26T10:30:00Z', available: true }        OR: { serial: 'BAT12345', available: false }** |
| --- |

### Battery Selection Validation

- Battery must have status = 'available'

- Battery must belong to the selected category and sub-category

- Battery must belong to the current dealer's inventory

- Cannot select a battery already reserved against another lead

### SECTION C — CHARGER SELECTION Charger Selection

Charger list is fetched from the dealer's inventory, filtered by compatibility with the selected battery model.

| GET /api/inventory/dealer/:dealerId/chargers      ?batteryModel=MODEL_XYZ   Response: [{ serial: "CHR98765", model: "Fast Charger 48V", status: "available",              invoice_date: "2026-01-15", inventory_age: 192 }] |
| --- |

| **Field** | **Source** | **Notes** |
| --- | --- | --- |
| **Serial Number** | **inventory.serial_number** | **Primary selection key** |
| **Model** | **inventory.model** |   |
| **Compatibility** | **Derived from battery model** | **Only compatible chargers shown** |
| **Inventory Age** | **TODAY − invoice_date** | **Same ageing rules as battery** |
| **Status** | **inventory.status** | **Available │ Reserved (greyed out)** |

### SECTION D — PARAPHERNALIA SELECTION Paraphernalia Items

Dealer selects add-on items available for the chosen product category. Items are count-based (not serial-tracked). Stock availability is checked against dealer inventory at submission time.

| **Item** | **Input Type** | **Notes** |
| --- | --- | --- |
| Digital SOC | Quantity (0-N) | Count of digital SOC units. Validated against dealer stock. |
| Volt SOC | Quantity (0-N) | Count of volt SOC units. |
| Harness Variant | Dropdown: Type A / B / C / None | Only one variant selectable per lead. |
| Additional Accessories | Free multi-select | Other items from dealer's paraphernalia inventory. Shown dynamically from backend. |

| GET /api/inventory/dealer/:dealerId/paraphernalia      ?category=3W   Response: [{ item: "digital_soc", label: "Digital SOC", available_qty: 12 },            { item: "volt_soc",    label: "Volt SOC",    available_qty: 5  },            { item: "harness",     label: "Harness",     variants: ["A","B","C"] }] |
| --- |

### SECTION E — PRICING **&** MARGIN Price Calculation

All base prices are system-controlled. The dealer enters only their margin. The system calculates and displays the final price in real-time.

| **Component** | **Source** | **Editable?** |
| --- | --- | --- |
| Battery Base Price | Dealer Inventory master | No — system controlled |
| Charger Price | Dealer Inventory master | No — system controlled |
| Paraphernalia Cost | Dealer Inventory master (Sum of selected items) | No — system controlled |
| Dealer Margin (₹) | Dealer input | Yes — free numeric input |
| Final Price | Sum of all above | No — auto-calculated. Read-only display. |

### SECTION F — SUBMISSION Submission — Finance vs Cash Paths

The submit action diverges based on payment_method. For finance leads, the dealer submits for admin final approval. For cash leads, there is no admin approval step — the dealer confirms the sale directly, which immediately marks inventory as sold and triggers warranty.

### Key Rule — Cash Flow

In a cash transaction, the dealer is the sole authorising party. After confirming the sale, the system immediately moves inventory to 'sold', creates the warranty record, and opens post-sales service tracking — without any admin queue or approval wait.

### **Submit / Confirm Button Label — Conditional**

| **Payment Mode** | **Button Label** | **What Happens** |
| --- | --- | --- |
| Finance / Dealer Finance | Submit for Final Approval | Inventory reserved. Lead → pending_final_approval. Admin approval queue triggered. |
| Cash | Confirm Sale | Dealer sees confirmation modal. On confirm: inventory → sold, warranty created, post-sales service activated. No admin step. |

### **Dealer Confirmation Modal — Cash Only**

When dealer clicks 'Confirm Sale', a modal appears before any backend action:

| **✅ Confirm Sale — Are you sure?** Customer:    Vijay Sharma Battery:     BAT12345 │ Model XYZ │ Age: 45 days │ SOC: 78% Charger:     CHR98765 Final Price: ₹85,000 By confirming, inventory will be marked SOLD and warranty will be activated immediately. **[Cancel]   [Confirm Sale →]** |
| --- |

### **Submit / Confirm — Validation Requirements**

Both paths require the following before the button is enabled:

•       Battery serial selected (available, correct category)

•       Charger serial selected (available, compatible)

### **Submit API — Finance Path**

| POST /api/lead/:leadId/submit-product-selection // Used for: Finance │ Dealer Finance  Request: {  "batterySerial":  "BAT12345",    "chargerSerial":  "CHR98765",    "paraphernalia":  { "digital_soc": 2, "volt_soc": 0, "harness": "type_b" },    "dealerMargin":   5000,    "finalPrice":     85000,    "submittedBy":    "dealer_user_id" }  Processing:   1. Server-side validate inventory status (race-condition guard)   3. inventory.status = 'reserved'  (battery + charger)   4. Deduct paraphernalia qty from dealer stock   5. Store product_selection record   6. lead.status = 'pending_final_approval'   7. Notify admin queue  Response: { "success": true, "leadStatus": "pending_final_approval",   "inventoryLocked": { "battery": "BAT12345", "charger": "CHR98765" } } |
| --- |

### **Confirm Sale API — Cash Path**

| POST /api/lead/:leadId/confirm-cash-sale // Used for: Cash only. No admin approval. Dealer-authorised.  Request: {  "batterySerial":  "BAT12345",    "chargerSerial":  "CHR98765",    "paraphernalia":  { "digital_soc": 2, "volt_soc": 0, "harness": "type_b" },    "dealerMargin":   5000,    "finalPrice":     85000,    "confirmedBy":    "dealer_user_id",    "confirmedAt":    "2026-07-28T14:30:00Z" }  Processing (all in single transaction):   1. Server-side validate inventory status   3. Store product_selection record (admin_decision = 'dealer_confirmed')   4. inventory.status = 'sold'  (battery + charger) — IMMEDIATE, no reserved step   5. inventory.dispatch_date = TODAY   6. inventory.linked_lead_id = leadId   7. Deduct paraphernalia qty from dealer stock   8. lead.status = 'sold'   9. POST /api/warranty/create  (triggered inline)  10. POST /api/after-sales/create  (post-sales service record opened)  11. Notify dealer: 'Sale confirmed. Warranty activated.'  12. Notify customer SMS: 'Your battery is now registered. Warranty ID: WRN-...'  Response: { "success": true, "leadStatus": "sold",   "warrantyId": "WRN-2026-BAT12345",   "warrantyStart": "2026-07-28",   "afterSalesId": "AS-2026-0000123",   "message": "Sale confirmed. Inventory sold. Warranty activated." } |
| --- |

### **Status Written on Submission / Confirmation**

| **Status** | **Triggered By** | **Next State / Notes** |
| --- | --- | --- |
| **pending_final_approval** | Finance — dealer submits Step 4 | Routes to admin product panel. Inventory = reserved. |
| **loan_sanctioned** | Admin — Loan Sanctioned action | Loan details stored. Routes to dealer Step 5 for customer approval. |
| **loan_rejected** | Admin — Loan Rejected action | Inventory released. Routes to dealer Step 5 showing rejection. |
| **product_selection_rejected** | Admin — Product Rejected action | Inventory released. Dealer Step 4 re-opens with rejection banner. |
| **sold** | Cash — dealer confirms sale | Immediate. No admin queue. Inventory = sold. Warranty + after-sales activated. |

### **Bottom Action Bar**

| **Button** | **Position** | **Style** | **Behaviour** |
| --- | --- | --- | --- |
| **Back** | **Bottom left** | **Secondary** | **Return to Step 3 (finance) or Step 1 (cash). Does not clear selections.** |
| **Save Draft** | **Bottom centre** | **Secondary** | **Saves current selections. Lead stays in product_selection_in_progress. Cash: draft does not reserve inventory.** |
| **Submit for Final Approval (Finance only)** | **Bottom right** | **Primary — disabled until conditions met** | **Finance path only. Reserves inventory. Routes to the admin approval queue.** |
| Confirm Sale (Cash only) | Bottom right | Primary green — disabled until conditions met | Cash path only. Shows confirmation modal. On confirm: inventory → sold, warranty + after-sales activated immediately. |

**ADMIN VIEW — PRODUCT SELECTION PANEL (FINANCE LEADS ONLY) Cash Flow — No Admin Panel**

For cash sales, the dealer confirms the sale directly. There is no admin KYC screen, no product panel, and no admin approval step. The admin product panel described in this section applies exclusively to finance and dealer finance leads.

Once a finance dealer submits Step 4, a read-only Product Selection Panel is appended to the bottom of the existing Admin KYC screen for that lead — following the same append pattern used for Step 3. No data is overwritten.

### Product Selection Panel — Fields Shown (**As per screen 4)

| **Field** | **Value / Source** |
| --- | --- |
| **Battery Serial Number** | **Selected serial — linked to inventory record** |
| **Battery Model** | **inventory.model** |
| **Battery Invoice Date** | **inventory.invoice_date** |
| **Battery Inventory Age** | **Calculated: X days (colour-coded)** |
| **Battery SOC** | **IoT value at time of submission (or N/A)** |
| **Charger Serial Number** | **Selected serial** |
| **Charger Model** | **inventory.model** |
| **Paraphernalia** | **List: Digital SOC ×2, Harness Type B, etc.** |
| **Battery Price** | **₹ As per screen 4** |
| **Charger Price** | **₹ As per screen 4** |
| **Paraphernalia Cost** | **₹ As per screen 4** |
| **Dealer Margin** | **₹ as entered by dealer (As per screen 4)** |
| **Final Price** | **₹ total (As per screen 4)** |
| **Submitted At** | **Timestamp** |
| **Category (final)** | **Category + sub-category as used for inventory match** |

### Admin Actions on Product Panel

The product panel has four distinct action buttons. Each opens a specific form or view. These actions are the primary mechanism by which admin drives the lead to its next state.

### ACTION 1 — Loan Sanctioned

Admin clicks Loan Sanctioned when the product selection is verified and the loan has been approved by the lender/NBFC. A loan input form opens inline within the product panel.

### **Loan Sanction Input Form**

| **#** | **Field** | **Type** | **Notes** |
| --- | --- | --- | --- |
| 1 | Loan Amount (₹) | Numeric | Total loan value sanctioned by lender. Required. |
| 2 | Down Payment (₹) | Numeric | Amount paid upfront by customer. Required. |
| 3 | File Charge (₹) | Numeric | Processing / documentation charge. Required. |
| 4 | Subvention (₹) | Numeric | Interest subvention amount if applicable. 0 if none. |
| 5 | Disbursement Amount (₹) | Numeric | Net amount to be disbursed to the dealer.Required. |
| 6 | EMI (₹) | Numeric | Monthly installment amount. Required. |
| 7 | Tenure (Months) | Numeric | Loan repayment period in months. Required. |
| 8 | Rate of Interest (%) | Decimal | Annual ROI. Required. |
| 9 | Loan Approved By | Text | Lender / NBFC name. Required. |
| 10 | Loan File Number | Text | Unique reference number assigned by lender. Required. |

### **On Save — Loan Sanctioned**

| POST /api/admin/lead/:leadId/sanction-loan  Request: {  "loanAmount":       85000,    "downPayment":      15000,    "fileCharge":       1500,    "subvention":       0,    "disbursementAmount": 83500,    "emi":              3200,    "tenureMonths":     24,    "roi":              18.5,    "loanApprovedBy":   "ABC Finance Ltd",    "loanFileNumber":   "ABC-2026-00789",    "sanctionedBy":     "admin_user_id" }  Processing:   1. Store loan_sanction record   2. lead.status = 'loan_sanctioned'   3. Notify dealer: 'Loan sanctioned. Customer approval required at Step 5.'   4. Route lead to Step 5 on dealer side  Response: { "success": true, "leadStatus": "loan_sanctioned",   "loanSanctionId": "LS-2026-0000123",   "message": "Loan details saved. Lead routed to dealer for customer approval." } |
| --- |

| **What Happens After Loan Sanctioned** The lead moves to Step 5 on the dealer side. The dealer, on behalf of the customer, reviews the full loan details and must approve them. Only after dealer/customer approval of the loan terms does inventory move to 'sold' and warranty get activated. This is specified fully in Section 4.0 (Step 5). |
| --- |

### ACTION 2 — Loan Rejected

Admin clicks Loan Rejected when the lender / NBFC has declined the loan application. A rejection reason input opens inline.

### **Loan Rejection Form**

| **Field** | **Notes** |
| --- | --- |
| **Rejection Reason** | **Free text. Mandatory. Min 10 characters. Visible to dealer at Step 5.** |

### **On Save — Loan Rejected**

| POST /api/admin/lead/:leadId/reject-loan   Request: {  "rejectionReason":  "Low CIBIL score after lender check",    "rejectedBy":       "A    "rejectionDate":    "2026-07-28",    "rejectedByAdmin":  "admin_user_id" }   Processing:   1. Store loan_rejection record   2. lead.status = 'loan_rejected'   3. inventory.status = 'available'  (reserved → available, battery + charger released)   4. Notify dealer: 'Loan rejected by lender. Reason: [reason]. Lead routed to Step 5.'   5. Notify customer SMS: 'Your loan application could not be approved at this time.'   6. Route lead to Step 5 on dealer side (dealer sees rejection details)   Response: { "success": true, "leadStatus": "loan_rejected",   "inventoryReleased": true,   "message": "Loan rejection recorded. Inventory released. Dealer notified." } |
| --- |

### Why Inventory Is Released on Loan Rejection

When a loan is rejected, the reserved battery and charger must return to 'available' immediately. The lead may be re-worked with a different product or co-borrower, or it may be closed. Holding inventory reserved against a rejected lead would incorrectly block stock from other customers.

### ACTION 3 — Download Customer Profile

Admin can download the complete customer profile at any point after Step 4 is submitted. This generates a ZIP archive, containing:

•       customer_profile.pdf — complete summary of all lead, KYC, product, and loan data

•       /documents/ — all primary KYC documents

•       /supporting_docs/ — Step 3 additional documents (if any)

•       /co_borrower_docs/ — co-borrower KYC documents (if any)

•       /product/ — product selection summary

| **GET /api/admin/lead/:leadId/download-profile → Streams ZIP file. See Section 3.3 for full structure and content.** |
| --- |

### FULL CUSTOMER PROFILE DOWNLOAD

Admin must be able to download a complete, consolidated customer profile at any point after Step 4 is submitted. The profile is generated as a ZIP archive containing a summary PDF and all attached documents organised by folder.

### Download API

| **GET /api/admin/lead/:leadId/download-profile   Generates and streams a ZIP file.   ZIP structure:   customer_profile.pdf          ← Summary document (all data in one PDF)   /documents/     aadhaar_front.jpg     aadhaar_back.jpg     pan_card.jpg     passport_photo.jpg     address_proof.pdf     bank_statement.pdf     cheque_1.jpg ... cheque_4.jpg     consent_signed.pdf   /supporting_docs/             ← If Step 3 supporting docs were requested     bank_statement_3months.pdf     salary_slips.pdf   /co_borrower_docs/            ← If co-borrower was added     cb_aadhaar_front.jpg     cb_pan_card.jpg     cb_bank_statement.pdf     cb_consent_signed.pdf     ... (all 11 co-borrower docs)   /product/     product_selection_summary.pdf** |
| --- |

### Summary PDF — Content Sections

| **#** | **Section** | **Fields Included** |
| --- | --- | --- |
| 1 | Customer Details | Full name, DOB, gender, phone, email, permanent address, current address |
| 2 | Lead Details | Reference ID, created date, payment mode, product category, sub-category, dealer name, dealer code |
| 3 | KYC Verification Results | Aadhaar: verified/rejected, PAN: verified/rejected, Bank: account number (masked), CIBIL score, face match result, address verification result, RC verification result, mobile intelligence result |
| 4 | Consent | Consent type (digital/manual), consent date, eSign transaction ID (if digital) |
| 5 | Supporting Documents | List of additional docs requested and uploaded (if any). Each doc: name, upload date, admin decision. |
| 6 | Co-Borrower Details | Full name, DOB, relationship, PAN, Aadhaar (masked), phone, CIBIL score, KYC status — shown only if co-borrower exists |
| 7 | Product Selection | Battery serial, model, age, SOC; charger serial, model; paraphernalia list; dealer margin; final price; submission timestamp |
| 8 | Admin Decision Log | Chronological log of all admin actions: each verification card decision, Step 3 decisions, Final Decision, timestamps, admin user name |

### Admin Actions on Product Panel

| **Action** | **lead.status After** | **Inventory Impact **&** Next Step** |
| --- | --- | --- |
| **Loan Sanctioned** | **loan_sanctioned** | **Inventory stays reserved. Lead routes to Step 5 (dealer side) for customer loan approval.** |
| ** Loan Rejected** | **loan_rejected** | **Inventory released (reserved → available). Lead routes to Step 5 (dealer sees rejection). Can be re-worked or closed.** |
| **Download Profile** | **No change** | **ZIP download. No status change. Available at any point after Step 4 submission.** |

### CASH FLOW — COMPLETE SPECIFICATION

---

## Part F — Step 5: Final Approval & Sale (Finance only)

| **Screen Title** | **Step 5 — Loan Details **&** Dispatch Confirmation** |
| **Reference ID** | **#IT-2026-XXXXXXX** |
| **Status Badge** | **Loan Sanctioned — Pending Customer Confirmation** |
| **Sanctioned By** | **Admin name │ Timestamp** |

### Loan Details Display Panel (Read-Only)

All 10 fields entered by admin are displayed in a clear, print-friendly summary card. The dealer uses this to walk the customer through the loan terms.

| **Loan Field** | **Displayed Value** |
| --- | --- |
| **Loan Amount** | **₹ 85,000** |
| **Down Payment** | **₹ 15,000** |
| **File Charge** | **₹ 1,500** |
| **Subvention** | **₹ 0** |
| **Disbursement Amount** | **₹ 83,500  (Amount to be disbursed to dealer)** |
| **EMI** | **₹ 3,200 / month** |
| **Tenure** | **24 months** |
| **Rate of Interest** | **18.5% per annum** |
| **Loan Approved By** | **ABC Finance Ltd** |
| **Loan File Number** | **ABC-2026-00789** |

| **Dealer Guidance Note Dealer must explain all loan terms to the customer before requesting OTP confirmation. The OTP is the customer's binding acceptance of these loan terms, the product, and the dispatch. The OTP confirmation cannot be undone once submitted.** |
| --- |

### Product **&** Pricing Summary Panel (Read-Only)

Below the loan details, the selected product summary is shown for final verification before dispatch:

| **Product Field** | **Value** |
| --- | --- |
| **Battery Serial** | **BAT12345** |
| **Battery Model** | **Model XYZ** |
| **Charger Serial** | **CHR98765** |
| **Paraphernalia** | **Digital SOC ×2, Harness Type B** |
| **Final Product Price** | **₹ 85,000** |
| **Dealer Margin** | **₹ 5,000** |

### OTP CONFIRMATION FLOW

Customer confirmation is collected via a time-bound OTP sent to the customer's registered mobile number. This OTP serves as the customer's digital acceptance of the loan terms and authorisation of the dispatch. The dealer enters the OTP on behalf of the customer in the Step 5 screen

### OTP Request

### **Dealer Action**

Dealer clicks 'Send OTP to Customer'. The system sends an OTP SMS to the customer's registered mobile (from Step 1 lead data).

| POST /api/lead/:leadId/step-5/send-otp  Processing:   1. Generate 6-digit OTP   2. Store: otp_hash, lead_id, expiry = NOW + 10 minutes   3. Send SMS to lead.phone:      "Your iTarang loan has been sanctioned.       Loan: ₹85,000 │ EMI: ₹3,200/month │ Tenure: 24 months       Lender: ABC Finance Ltd       OTP to confirm: 847291       Valid for 10 minutes. Do not share."  Response: { "success": true, "otpSentTo": "+91 98765 XXXXX",   "expiresInSeconds": 600,   "message": "OTP sent to customer mobile" } |
| --- |

### **OTP SMS Content**

| **Element** | **Value** |
| --- | --- |
| **Recipient** | **Customer registered mobile (from lead)** |
| **Loan summary** | **Loan amount, EMI, tenure, lender name — shown in SMS for customer reference** |
| **OTP** | **6-digit numeric, time-bound** |
| **Validity** | **10 minutes from generation** |
| **Max resends** | **3 attempts. After 3rd: 30-minute cooldown before new OTP can be requested** |

### OTP Entry UI — Dealer Screen

| **Customer OTP Confirmation OTP sent to customer: +91 98765 XXXXX Expires in: 09:42  ⏱ Enter OTP:  [ _ ][ _ ][ _ ][ _ ][ _ ][ _ ] [Resend OTP]                                    [Validate **&** Confirm Dispatch →]** |
| --- |

| **UI Element** | **Behaviour** |
| --- | --- |
| **OTP input** | **6-box numeric entry. Auto-advances between boxes. Paste-compatible.** |
| **Countdown timer** | **Shows remaining validity (10:00 → 0:00). On expiry: input greys out, 'OTP Expired — Resend' shown.** |
| **Resend OTP** | **Available after 30 seconds. Generates new OTP, resets timer. Max 3 total sends per session.** |
| **Validate **&** Confirm Dispatch** | **Enabled only when 6 digits entered. On click: calls confirm-dispatch API.** |

### OTP Validation **&** Dispatch Confirmation API

| POST /api/lead/:leadId/step-5/confirm-dispatch   Request: {  "otp":            "847291",    "loanSanctionId": "LS-2026-0000123",    "confirmedBy":    "dealer_user_id",    "confirmedAt":    "2026-07-28T15:45:00Z" }   OTP Validation:   1. Fetch stored otp_hash for leadId   2. Verify hash(otp) matches stored hash   3. Verify NOW < otp_expiry   4. Verify otp not already used (single-use)   → If any check fails: return { success: false, error: 'Invalid or expired OTP' }   On OTP Valid — Single Database Transaction:   5.  inventory.status = 'sold'          (battery + charger)   6.  inventory.dispatch_date = TODAY   7.  inventory.linked_lead_id = leadId   8.  paraphernalia stock deducted (already done at Step 4; verify not double-deducted)   9.  product_selection.status = 'dealer_confirmed'   10. loan_sanction.dealer_approved = TRUE   11. loan_sanction.dealer_approved_at = NOW   12. loan_sanction.dealer_approved_by = dealer_user_id   13. loan_sanction.status = 'dealer_approved'   14. lead.status = 'sold'   15. lead.sold_at = NOW   16. otp record marked as used   17. POST /api/warranty/create  (inline — see Section 3.6)   18. POST /api/after-sales/create  (post-sales record opened)   Notifications (async, after transaction commits):   19. SMS to customer:        "Congratulations! Your battery [BAT12345] has been dispatched.         Warranty ID: WRN-2026-BAT12345. Loan: ABC-2026-00789.         For service: [support link]"   20. Notify admin: 'Lead #IT-2026-0000123 sold and dispatched.'   21. Dealer dashboard: lead moves to 'Completed' list   Response: { "success": true,   "leadStatus":    "sold",   "warrantyId":    "WRN-2026-BAT12345",   "warrantyStart": "2026-07-28",   "afterSalesId":  "AS-2026-0000123",   "loanStatus":    "dealer_approved",   "message":       "Dispatch confirmed. Inventory sold. Warranty activated. Loan recorded." } |
| --- |

### What Gets Recorded at Dispatch Confirmation

| **Record** | **What Is Stored** | **Table** |
| --- | --- | --- |
| **Inventory Movement** | **status = sold, dispatch_date, linked_lead_id** | **inventory (battery + charger rows)** |
| **Product Selection** | **status = dealer_confirmed, confirmed_by, confirmed_at** | **product_selections** |
| **Loan Sanction Update** | **dealer_approved = true, dealer_approved_at, dealer_approved_by** | **loan_sanctions** |
| **Lead Closure** | **status = sold, sold_at, payment_mode = finance** | **leads** |
| **Warranty Record** | **battery_serial → customer → dealer → lead, warranty_start, warranty_end, source** | **warranties (new row created)** |
| **After-Sales Record** | **warranty_id, lead_id, dealer_id, opened_at — ready for service module** | **after_sales_records (new row created)** |
| **OTP Audit** | **otp_used = true, used_at, used_by — non-repudiation record** | **otp_confirmations** |

### SCENARIO B — LOAN REJECTED SCREEN

When lead.status = 'loan_rejected', Step 5 opens in a read-only informational state. There is no OTP, no dispatch, and no confirmation action. The dealer sees the rejection details and can take next steps.

### Loan Rejected Screen Layout

| **Loan Application Rejected Rejection Date:  28-Jul-2026 Reason: Low CIBIL score after lender credit check. Minimum required: 650. Customer score: 610. Inventory has been released. Battery BAT12345 and Charger CHR98765 are available again.** |
| --- |

### Available Actions After Loan Rejection

| **Action** | **Behaviour** |
| --- | --- |
| Re-apply with Co-Borrower | Routes dealer back to Step 3 (additional docs / co-borrower KYC flow). Lead status set to 'awaiting_co_borrower_kyc'. Admin will re-run KYC and re-submit to lender. |
| Change Payment Mode to Cash | Converts the lead to a cash sale. Routes to Step 4 (product re-selection under cash mode). Dealer confirms sale directly without lender involvement. |
| Close Lead | Marks lead as 'closed_loan_rejected'. No further action. Inventory already released. |

### Inventory Already Released

When the admin records a loan rejection (Step 4 admin action), inventory is released immediately at that point. By the time the dealer reaches Step 5 and sees the rejection screen, the battery and charger serials are already back in the available pool. The rejection screen confirms this with an informational note.

### OTP EDGE CASES **&** FALLBACK

| **Scenario** | **System Behaviour** |
| --- | --- |
| **OTP expires before entry** | **Input field greys out with 'OTP Expired' message. Dealer clicks Resend OTP to generate a new one. Timer resets. Previous OTP is invalidated.** |
| **Wrong OTP entered** | **Error shown inline: 'Incorrect OTP. X attempts remaining.' After 3 wrong attempts: input locked for 5 minutes. Resend OTP available after lock expires.** |
| **Customer unable to receive SMS (no signal / wrong number)** | **Dealer contacts iTarang support. Admin can trigger an admin-override dispatch with mandatory reason logged. Override is logged with admin ID, timestamp, and reason for audit.** |
| **Max resend limit reached (3 sends)** | **30-minute cooldown before a new OTP session can be started. Dealer can use this time to verify customer mobile number with support.** |
| **OTP reuse attempt** | **Each OTP is single-use. Once used in a successful confirm-dispatch call, the OTP record is marked as used and any re-submission is rejected: 'OTP already used'.** |
| **Transaction failure mid-confirm** | **All DB writes in confirm-dispatch are inside a single transaction. If any step fails, the entire transaction is rolled back — inventory stays reserved, loan stays pending, no warranty created. Dealer can retry.** |

### DATABASE SCHEMA — STEP 5 otp_confirmations

| **Column** | **Type** | **Notes** |
| --- | --- | --- |
| **id** | **INT PK AUTO** |   |
| **lead_id** | **INT FK** | **references leads.id** |
| **otp_type** | **ENUM** | **'dispatch_confirmation' — extensible for future OTP uses** |
| **otp_hash** | **VARCHAR(255)** | **Hashed OTP — never store plain text** |
| **phone_sent_to** | **VARCHAR(20)** | **Masked for display (last 4 digits shown)** |
| **created_at** | **TIMESTAMP** |   |
| **expires_at** | **TIMESTAMP** | **created_at + 10 minutes** |
| **send_count** | **INT DEFAULT 1** | **Increments on each resend. Max 3.** |
| **attempt_count** | **INT DEFAULT 0** | **Wrong attempts counter. Max 3 before lockout.** |
| **is_used** | **BOOLEAN DEFAULT FALSE** | **Set TRUE on successful validation. Single-use enforced.** |
| **used_at** | **TIMESTAMP NULL** |   |
| **used_by** | **INT NULL FK** | **dealer_user_id** |
| **override_by_admin** | **BOOLEAN DEFAULT FALSE** | **TRUE if admin override was used instead of OTP** |
| **override_reason** | **TEXT NULL** | **Mandatory if override_by_admin = TRUE** |

## **after_sales_records**

| **Column** | **Type** | **Notes** |
| --- | --- | --- |
| **id** | **INT PK AUTO** |   |
| **after_sales_id** | **VARCHAR(50) UNIQUE** | **AS-YYYY-LEADREF** |
| **lead_id** | **INT FK** |   |
| **warranty_id** | **VARCHAR(50) FK** | **references warranties.warranty_id** |
| **battery_serial** | **VARCHAR(50) FK** |   |
| **customer_id** | **INT FK** |   |
| **dealer_id** | **INT FK** |   |
| **payment_mode** | **ENUM** | **'cash' │ 'finance'** |
| **opened_at** | **TIMESTAMP** | **Set at dispatch confirmation / cash sale confirmation** |
| **status** | **ENUM** | **'active' │ 'closed'** |

### COMPLETE STEP 5 WORKFLOW SUMMARY

| **#** | **Actor** | **Action **&** Outcome** |
| --- | --- | --- |
| **── SCENARIO A: LOAN SANCTIONED ──** |
| **1** | **System** | **Admin sanctioned loan in Step 4. lead.status = 'loan_sanctioned'. Dealer Step 5 tab activates.** |
| **2** | **Dealer** | **Open Step 5. Sees read-only loan details panel (10 fields) + product summary. Reviews with customer.** |
| **3** | **Dealer** | **Clicks 'Send OTP to Customer'. System sends 6-digit OTP to customer's registered mobile including loan summary.** |
| **4** | **Customer** | **Receives SMS with loan summary + OTP. Shares OTP with dealer.** |
| **5** | **Dealer** | **Enters 6-digit OTP in Step 5 screen. Clicks 'Validate **&** Confirm Dispatch'.** |
| **6** | **System** | **OTP validated (hash match + expiry check + single-use). Single DB transaction executes.** |
| **7** | **System** | **In transaction: inventory → sold │ product_selection → dealer_confirmed │ loan_sanction → dealer_approved │ lead → sold │ warranty created │ after-sales record opened.** |
| **8** | **System** | **Async notifications: SMS to customer (warranty ID + loan ref), admin notified, dealer dashboard updated. Lead moves to Completed.** |
| **── SCENARIO B: LOAN REJECTED ──** |
| **1** | **System** | **Admin rejected loan in Step 4. lead.status = 'loan_rejected'. Inventory already released. Dealer Step 5 tab activates.** |
| **2** | **Dealer** | **Opens Step 5. Sees rejection banner with lender name, date, and reason.** |
| **3** | **Dealer** | **Chooses next action: Re-apply with Co-Borrower (→ Step 3) │ Change to Cash (→ Step 4 cash) │ Close Lead.** |

### Dealer Inventory **Management &** Product Master

This section defines the complete workflow for how physical inventory (batteries, chargers, and paraphernalia) is assigned to a dealer, and moves through its lifecycle until sold. It is the upstream dependency for Step 4 (Product Selection) — without inventory data in the system, the Step 4 screen has nothing to display.

### Dependency Chain

Admin uploads inventory → Inventory assigned to dealer → Dealer sees stock in Step 4 → Dealer maps serial to lead → Inventory reserved → OTP confirmed → Inventory marked Sold → Warranty activated. Every downstream step in the lead lifecycle depends on this section being implemented first.

### Inventory Entry Methods

iTarang supports two methods for adding inventory to the system. Both are admin-initiated. Dealers cannot add inventory themselves — they can only view and use inventory that has been assigned to them.

| **Method** | **How It Works** | **Best For** |
| --- | --- | --- |
| **Method A Bulk CSV Upload** | Admin selects a dealer, uploads a CSV file with all serial numbers and item details. The system validates and imports in bulk. | Large stock transfers from OEM. Multiple serials at once (e.g. 50 batteries in one shipment). |
| **Method B Manual Single-Item Entry** | Admin fills an item-by-item form for each serial. Used for smaller additions or corrections. | Individual replacements, warranty stock, single-unit additions after audit. |

### ADMIN SIDE — INVENTORY UPLOAD Navigation Path

Admin Panel → Inventory Management → Upload Inventory

| **Screen Element** | **Value** |
| --- | --- |
| Page Title | Upload Inventory |
| Breadcrumb | Admin → Inventory Management → Upload Inventory |
| Access | Admin roles: Ops Manager, Super Admin only. KYC Officers cannot access inventory upload. |

### Step 1 — Select Dealer

The first action on the upload screen is selecting the target dealer. All inventory uploaded in this session will be assigned to this dealer.

| **Dealer Selection Control** |
| --- |

| **Field** | **Specification** |
| --- | --- |
| **Dealer Selector** | **Searchable dropdown. Search by dealer name, dealer code, or city. Shows: Dealer Name │ Dealer Code │ City │ State.** |
| **Dealer Info Card** | **On selection, it shows a read-only card: Dealer Name, Code, Address, Active Since, Current Inventory Count (batteries/chargers/paraphernalia summary).** |
| **Validation** | **A dealer must be selected before the upload form appears. Cannot proceed without selection.** |

| GET /api/admin/dealers?search=:query   Response: [{ dealerId: "DLR-001", name: "Vijay Motors", code: "VM01",              city: "Patna", state: "Bihar",              currentStock: { batteries: 12, chargers: 15, paraphernalia: 45 } }] |
| --- |

### Step 2 — Select Inventory Type

After selecting the dealer, admin chooses which type of inventory to upload. Each type has its own field set and CSV template.

| **Type** | **Items Covered** | **Serial Tracked?** |
| --- | --- | --- |
| Battery | All battery units. Primary inventory item. | Yes — every unit has a unique serial number. |
| Charger | All charger units linked to battery models. | Yes — every unit has a unique serial number. |
| Paraphernalia | Digital SOC, Volt SOC, Harness variants, accessories. | No — tracked by quantity, not individual serial. |

| **BATTERY UPLOAD — Field Specification** |
| --- |

### Battery Upload Fields

The table below uses the field names as they appear in both the admin upload form and the CSV template. Where the field has a specific system column name it is noted in the Notes column.

| **#** | **Field Label (UI / CSV Header)** | **Type / Format** | **Required?** | **Notes / Validation** |
| --- | --- | --- | --- | --- |
| **1** | **Battery ID (DB: serial_number)** | Text — uppercase alphanumeric | Yes | Primary identifier of the physical unit. Unique across the entire system. Also used by the IoT module as the vehicle/battery identifier — the IoT device reports telemetry using this same ID. Duplicate check runs at upload. Immutable after creation. Max 50 chars. |
| **2** | **IMEI ID (DB: imei_id)** | Numeric — 15 digits | Conditional | Required when the battery has an IoT module fitted (i.e. when IoT Enabled = Yes). This is the GSM IMEI of the IoT device embedded in the battery pack. Used for network registration, SIM identification, and device-level telemetry linking. Leave blank for non-IoT batteries. |
| **3** | **IoT Enabled (DB: iot_enabled)** | Boolean toggle — Yes / No | Yes | Indicates whether this battery unit has an IoT module installed. When Yes: IMEI ID becomes required, SOC data is expected from telemetry. When No: SOC shows as N/A in Step 4 and dealer views. |
| **4** | **Material Code (DB: material_code)** | Text — alphanumeric | Yes | Reference code provided by the OEM for this specific battery unit or SKU. Used for OEM-level tracking, warranty claims with the manufacturer, and future integration with OEM portals. Stored as-is without transformation. Distinct from Battery ID — Material Code is OEM's reference, Battery ID is iTarang's physical serial. |
| **5** | **Product Category (DB: category)** | Dropdown from product master | Yes | 3W │ 2W │ 4W │ Inverter │ Solar │ Other. Top-level classification. Determines which leads this battery appears in during Step 4 product selection. Immutable after creation. |
| **6** | **Product Sub-Category (DB: sub_category)** | Dropdown — depends on Category | Yes | See Sub-Category matrix in Section 5.1.2. E.g. 3W → E-Rickshaw │ E-Cart │ E-Auto. Sub-Category is also the context used in the lead creation model (Step 1) to match battery inventory to a lead — the label a dealer sees in Step 4 is the Sub-Category of the battery, not the category. |
| **7** | **Model Number (DB: model_number) also used as Battery Model** | Dropdown from product master | Yes | Selects the battery model from the product master (Section 5.1.3). The model defines the technical spec (voltage, capacity, chemistry), pricing (base price, min price, margin cap), and warranty duration. In the lead creation model and Step 4, this field appears as 'Battery Model'. The model options shown are filtered by the selected Product Sub-Category — each sub-category has its own list of eligible models. |
| **8** | **Voltage (V) (DB: voltage_v)** | Decimal | Yes | Auto-filled from product master when Model Number is selected. Editable override allowed for non-standard units. e.g. 51.2 |
| **9** | **Capacity (AH) (DB: capacity_ah)** | Decimal | Yes | Ampere-hour rating. Auto-filled from product master. e.g. 105 |
| **10** | **Star Rating (DB: star_rating)** | Integer — 1 to 5 | Yes | Performance/quality rating index assigned at time of upload. 1 = lowest, 5 = highest. Used in Step 4 to surface premium inventory and in post-sales for warranty tier differentiation. Can be defined by the OEM grade or iTarang internal classification. Shown as ★ stars in dealer and admin inventory views. |
| **11** | **Invoice Number (DB: invoice_number)** | Text | Yes | OEM or supplier invoice reference number. Used for stock reconciliation, audit, and OEM warranty claims. Groups units from the same purchase invoice. |
| **12** | **Sold Date (to Dealer) (DB: invoice_date)** | Date — DD-MM-YYYY | Yes | Date on which the OEM or supplier sold/invoiced this battery unit to the dealer. This is the anchor date for inventory_age calculation in Step 4 (TODAY − sold_date = age in days). Called 'Sold Date' in the upload form to match real-world dealer terminology; stored as invoice_date in the database. |
| **13** | **Invoice Value (₹) (DB: invoice_value)** | Decimal | Yes | Per-unit purchase price paid by dealer to OEM/supplier. Used for write-off valuation, margin analysis, and financial reporting. |
| **14** | **Supplier / OEM Name (DB: supplier_name)** | Text | Yes | Name of the battery manufacturer or OEM supplier. Used for warranty claim routing and OEM-level reporting. |
| **15** | **OEM Warranty Date (DB: oem_warranty_date)** | Date — DD-MM-YYYY | Yes | The date from which the OEM's warranty is valid for this unit. This may differ from the Sold Date — some OEMs start warranty from manufacturing date; others from invoice date. This is the OEM's warranty start, not the customer warranty start (which is set at dispatch/IoT activation in Section 3.6). |
| **16** | **OEM Warranty Period (DB: oem_warranty_months)** | Integer — months | Yes | Duration of the OEM's warranty coverage in months. e.g. 24. This is the upstream warranty (iTarang ← OEM), distinct from the customer warranty (Customer ← iTarang) defined in the product master. Used to calculate oem_warranty_expiry = oem_warranty_date + oem_warranty_months. Enables automated OEM warranty expiry alerts. |
| **17** | **OEM Warranty Clauses (DB: oem_warranty_clauses)** | Rich text / long text | No | Free-text field to capture specific OEM warranty terms, exclusions, and conditions. e.g. 'Warranty void if water damage detected', 'Cell replacement only — no full pack replacement in year 1', 'Must return to OEM service centre for warranty claims > 20% capacity loss'. Though optional at upload, this data is critical for after-sales service teams when processing warranty claims — it determines what is claimable from the OEM. Displayed in the Battery Detail Card and in the after-sales warranty claim module. |
| **18** | **Batch / PO Reference (DB: batch_reference)** | Text | No | Purchase order or iTarang batch reference. Groups serials from the same shipment for bulk operations (e.g. bulk write-off of a faulty batch). |
| **19** | **Physical Condition (DB: physical_condition)** | Dropdown | Yes | New │ Refurbished │ Demo Unit. Affects minimum price floor eligibility (refurbished units may have a different floor in the product master). |
| **20** | **Warehouse / Location (DB: warehouse_location)** | Text | No | Storage location at dealer premises. e.g. 'Main Godown', 'Branch 2'. For dealers with multiple storage locations. |

| **🔵 Identity **&** IoT fields (rows 1-3)** | **🟡 OEM Reference field (row 4)** | **🟢 Product Classification (rows 5-10)** | **🟠 OEM Warranty fields (rows 15-17)** |
| --- | --- | --- | --- |

| **CHARGER UPLOAD — Field Specification** |
| --- |

### Charger Upload Fields

| **#** | **Field** | **Type / Format** | **Required?** | **Notes / Validation** |
| --- | --- | --- | --- | --- |
| **1** | **Serial Number** | **Text — uppercase alphanumeric** | **Yes** | **Unique across system. Format: CHR-XXXXXXXXX or free text up to 50 chars.** |
| **2** | **Charger Model** | **Dropdown from product master** | **Yes** | **e.g. 'Fast Charger 48V', 'Standard Charger 51.2V'.** |
| **3** | **Compatible Battery Models** | **Multi-select from product master** | **Yes** | **Which battery models this charger is compatible with. Controls charger options shown in Step 4.** |
| **4** | **Output Voltage (V)** | **Decimal** | **Yes** | **Auto-filled from product master on model selection.** |
| **5** | **Output Current (A)** | **Decimal** | **Yes** | **Ampere output rating. Auto-filled from product master.** |
| **6** | **Invoice Number** | **Text** | **Yes** | **OEM invoice reference.** |
| **7** | **Invoice Date** | **Date — DD-MM-YYYY** | **Yes** | **Drives inventory_age for charger.** |
| **8** | **Invoice Value (₹)** | **Decimal** | **Yes** | **Per-unit invoice price.** |
| **9** | **Supplier / OEM Name** | **Text** | **Yes** |   |
| **10** | **Physical Condition** | **Dropdown** | **Yes** | **New │ Refurbished │ Demo Unit.** |

| **PARAPHERNALIA UPLOAD — Field Specification** |
| --- |

### Paraphernalia Upload Fields

Paraphernalia items are count-tracked, not serial-tracked. Admin uploads a quantity for each item type.

| **#** | **Field** | **Type / Format** | **Required?** | **Notes** |
| --- | --- | --- | --- | --- |
| 1 | Item Type | Dropdown | Yes | Digital SOC │ Volt SOC │ Harness (Type A) │ Harness (Type B) │ Harness (Type C) │ Other Accessory. Expandable via product master. |
| 2 | Compatible Category | Multi-select | Yes | Which product categories this item is available for (e.g. Digital SOC available for 3W and 2W but not Solar). |
| 3 | Quantity | Integer > 0 | Yes | Number of units being added to dealer stock. |
| 4 | Unit Cost (₹) | Decimal | Yes | Per-unit cost. Used for paraphernalia_total calculation in Step 4. |
| 5 | Invoice Number | Text | Yes |  |
| 6 | Invoice Date | Date | Yes |  |
| 7 | Supplier | Text | No |  |

| **Paraphernalia Stock Logic When a dealer confirms a sale in Step 4, the selected paraphernalia quantities are deducted from the dealer's stock. The system blocks selection if quantity requested exceeds available stock. Stock is NOT reserved at Step 4 submission — only deducted at final sale confirmation (cash: Confirm Sale, finance: OTP confirm dispatch).** |
| --- |

### BULK CSV UPLOAD — METHOD A CSV Template

Admin downloads a pre-formatted CSV template for the selected inventory type, fills it, and uploads. The template has fixed column headers matching the field specification above. A separate template exists for Battery, Charger, and Paraphernalia.

| GET /api/admin/inventory/csv-template?type=battery│charger│paraphernalia  Returns: CSV file download with header row and one example data row.  Battery template columns (in order): battery_id, imei_id, iot_enabled, material_code, category, sub_category, model_number, voltage_v, capacity_ah, star_rating, invoice_number, sold_date, invoice_value, supplier_name, oem_warranty_date, oem_warranty_months, oem_warranty_clauses, batch_reference, physical_condition, warehouse_location |
| --- |

### Upload **&** Validation Flow

| **Step** | **Action** | **Detail** |
| --- | --- | --- |
| **1** | **Admin uploads CSV** | **Drag-and-drop or file picker. Accepted formats: .csv, .xlsx. Max file size: 5 MB. Max rows: 500 per upload.** |
| **2** | **System parses file** | **Reads all rows. Maps columns to fields. Shows a preview table of the first 10 rows before validation runs.** |
| **3** | **Row-level validation** | **Every row is validated against the rules in Section 5.0.2.4 / 5.0.2.5 / 5.0.2.6. Results shown in a validation panel with pass/fail per row.** |
| **4** | **Duplicate check** | **Serial numbers are checked against the entire inventory table. Duplicate serials are flagged as errors (not warnings). Admin must fix before import proceeds.** |
| **5** | **Admin reviews errors** | **All rows with errors are highlighted. Admin can: (a) fix the CSV and re-upload, or (b) use inline edit to correct individual cells in the preview.** |
| **6** | **Admin confirms import** | **'Import X valid rows' button enabled only when 0 errors remain. Admin clicks to trigger the import API.** |
| **7** | **System imports** | **All valid rows inserted to inventory table with status = 'available', assigned dealer_id, created_by = admin_user_id, created_at = NOW.** |
| **8** | **Confirmation** | **Import summary shown: X rows imported successfully, Y rows skipped (with reasons). Downloadable import report available.** |

| POST /api/admin/inventory/bulk-upload Content-Type: multipart/form-data   Request fields:   dealerId:      'DLR-001'   inventoryType: 'battery' │ 'charger' │ 'paraphernalia'   file:          CSV/XLSX binary   uploadedBy:    admin_user_id   Processing:   1. Parse file → validate all rows   2. Duplicate serial check (DB query)   3. If errors: return validation report, no import   4. If clean: bulk INSERT to inventory table   5. Create inventory_upload_event record   6. Notify dealer (push + SMS): 'X new items added to your inventory'   Response: { "success": true, "imported": 48, "skipped": 2, "errors": [],   "uploadEventId": "UPL-20260726-DLR001-001",   "reportUrl": "/api/admin/inventory/upload-report/UPL-20260726-DLR001-001" } |
| --- |

### MANUAL SINGLE-ITEM ENTRY — METHOD B

Admin fills one item at a time using a form. All the same fields as the CSV template apply. This is used for small additions, replacements, or corrections.

| POST /api/admin/inventory/add-item  Request: { dealerId, inventoryType, fields as per Section 5.0.2.4 / 5.0.2.5 / 5.0.2.6 }  Processing: Same validation as bulk upload (single row).   On success: insert 1 row, notify dealer.  Response: { "success": true, "inventoryId": "INV-2026-BAT-001", "serialNumber": "BAT12345" } |
| --- |

| **Edit After Upload** Once an inventory item is created with status = 'available', admin can edit non-critical fields (warehouse location, IoT device ID, physical condition notes). Serial number, category, and invoice date cannot be edited after creation — these are locked as the immutable identity of the item. To correct these, the item must be written off and re-uploaded. |
| --- |

### INVENTORY STATUS LIFECYCLE

Every inventory item (battery or charger) moves through a strict, one-way status pipeline from the moment it enters the system.

| **Status** | **Triggered By** | **Next State / Notes** |
| --- | --- | --- |
| **available** | Item uploaded by admin | Visible in Step 4 product selection. Can be selected by dealer. |
| **reserved** | Dealer submits Step 4 (finance path) | Locked against a specific lead. Not selectable for any other lead. |
| **sold** | OTP confirm-dispatch (finance) OR Confirm Sale (cash) | Dispatched to customer. Triggers warranty + after-sales record. |
| **written_off** | Admin — write-off action | Removed from available pool. No warranty created. Audit record created. |
| **available (released)** | Admin rejects product selection OR lead cancelled | Returns from reserved → available. Item back in pool. |
| **transferred_out** | Admin — inter-dealer transfer (sender) | Being moved to another dealer. Not selectable during transit. |
| **transferred_in** | Admin — inter-dealer transfer (receiver) | Pending dealer acknowledgement. Becomes available after acknowledgement. |

| **Irreversibility Rule** Once an item reaches 'sold' status it can never return to 'available'. The only permitted post-sold transitions are: sold → warranty_voided (admin action, requires approval) for fraud/error cases. This must go through a formal exception process and is logged permanently. |
| --- |

### Inventory Events Log

Every status change is recorded in an inventory_events table. This gives a full audit trail for every serial number — who changed it, when, and why.

| Every status change calls: POST /api/inventory/log-event (internal)  Event types: uploaded │ reserved │ released │ sold │ written_off │              transfer_initiated │ transfer_received │ iot_linked │ edited |
| --- |

### DEALER SIDE — INVENTORY VIEW

Once admin uploads inventory for a dealer, it becomes immediately visible in the dealer's Inventory section of the navigation menu. The dealer cannot add, edit, or delete inventory — they can only view it and use it in the lead workflow**. Dealer Inventory Screen — Navigation**

Dealer Navigation → Inventory

| **Element** | **Description** |
| --- | --- |
| Page Title | My Inventory |
| Tabs | Batteries │ Chargers │ Paraphernalia |
| Summary Cards (top) | Three count cards: Available Batteries │ Available Chargers │ Total Paraphernalia items. Updates in real-time. |
| Ageing Alert Banner | If any battery or charger has inventory_age > 180 days:  'X items have been in stock for over 180 days. Prioritise dispatch.' Banner is dismissible per session but reappears next login. |

### Battery Tab — Table View

| **Column** | **Source** | **Notes** |
| --- | --- | --- |
| **Serial Number** | **inventory.serial_number** | **Clickable — opens detail card modal.** |
| **Model** | **inventory.battery_model** |   |
| **Category / Sub-Category** | **inventory.category + sub_category** | **e.g. 3W / E-Rickshaw** |
| **Invoice Date** | **inventory.invoice_date** |   |
| **Inventory Age** | **TODAY − invoice_date** | **Colour-coded: green (**<**90d) │ orange (90-180d) │ red (**>**180d)** |
| **SOC** | **IoT backend** | **% if available. 'N/A' if no IoT.  if stale **>**24h.** |
| **Status** | **inventory.status** | **Available │ Reserved  │ Sold ✓** |
| **Linked Lead** | **inventory.linked_lead_id** | **Shown only if Reserved. Shows lead reference number.** |

| GET /api/inventory/dealer/:dealerId/batteries      ?status=available│reserved│sold│all   (default: all)      &category=3W   (optional filter)      &sort=invoice_date_asc   (default: oldest first)   Response: [{ serialNumber, model, category, subCategory, invoiceDate,              inventoryAge, soc, status, linkedLeadId }] |
| --- |

### Battery Detail Card Modal

Dealer clicks any serial number to open a read-only detail card. This is also the card shown to admin via the 'View Inventory' action in the Step 4 product panel.

| **Field** | **Value** |
| --- | --- |
| Battery ID (Serial Number) | BAT12345 |
| IMEI ID | 354000123456789 (IoT Enabled ✅) |
| IoT Enabled | Yes — device linked |
| Material Code | OEM-MAT-5V105-003 (OEM reference) |
| Model Number | 51.2V-105AH  (Battery Model) |
| Product Category / Sub-Category | 3W / E-Rickshaw |
| Voltage / Capacity | 51.2 V │ 105 AH |
| Star Rating | ★★★★☆  (4 / 5) |
| Physical Condition | New |
| Supplier / OEM | XYZ Battery Co. |
| Invoice Number | INV-2026-0045 |
| Sold Date (to Dealer) | 15-Jan-2026 |
| Invoice Value | ₹ 62,000 |
| Inventory Age | 192 days  (>180 days — prioritise dispatch) |
| Current SOC | 74% (last sync: 26-Jul-2026 10:30 AM) |
| OEM Warranty Date | 15-Jan-2026 |
| OEM Warranty Period | 24 months  (expires: 15-Jan-2028) |
| OEM Warranty Clauses | Warranty void if water damage detected. Cell replacement only in year 1 — no full pack replacement. Claims must be routed through XYZ Battery Co. authorised service centre. |
| Batch / PO Reference | PO-2026-XYZ-011 |
| Current Status | Available |
| Status History | Uploaded 15-Jan-2026 by Admin (Kartik) │ Reserved 20-Mar-2026 → Lead #IT-2026-0000031 │ Released 25-Mar-2026 │ Available since |

### Charger Tab

Identical structure to Battery Tab. Columns: Serial Number, Model, Compatible Battery Models, Invoice Date, Inventory Age, Status, Linked Lead.

| GET /api/inventory/dealer/:dealerId/chargers      ?status=available│reserved│sold│all      &compatibleModel=51.2V-105AH   (optional filter) |
| --- |

### Paraphernalia Tab

Paraphernalia is shown as a stock summary (not individual serials).

| **Item** | **Available Qty** | **Reserved Qty** | **Notes** |
| --- | --- | --- | --- |
| Digital SOC | 12 | 0 |  |
| Volt SOC | 5 | 2 | 2 units in active leads |
| Harness Type A | 8 | 0 |  |
| Harness Type B | 3 | 1 |  |
| Harness Type C | 0 | 0 | 🔴 Out of stock |

| GET /api/inventory/dealer/:dealerId/paraphernalia      ?category=3W   (optional — filters compatible items)  Response: [{ itemType, label, availableQty, reservedQty, unitCost }] |
| --- |

### Dealer Inventory Filters **&** Search

| **Filter / Control** | **Options** |
| --- | --- |
| **Search** | **By serial number (partial match supported)** |
| **Status filter** | **All │ Available │ Reserved │ Sold** |
| **Category filter** | **All │ 3W │ 2W │ 4W │ Inverter │ Solar** |
| **Age filter** | **All │ **<**90 days │ 90-180 days │ **>**180 days** |
| **Sort** | **Invoice Date (oldest first — default) │ Invoice Date (newest) │ Status** |

### ADMIN INVENTORY MANAGEMENT SCREEN

Admin has a full management view across all dealers. This is separate from the upload screen.

### Admin Inventory Dashboard

Admin Panel → Inventory Management → Dashboard

| **Panel** | **Content** |
| --- | --- |
| Network Summary Cards | Total available batteries │ Total reserved │ Total sold (this month) │ Total written off |
| Ageing Alert | Count of items >90 days, >180 days across all dealers. Drill-down to dealer-level list. |
| Dealer Stock Table | One row per dealer: Dealer Name, Available Batteries, Available Chargers, Paraphernalia items, Last Upload Date. |
| Quick Actions | [Upload Inventory] [View All Serials] [Download Ageing Report] [New Write-Off] |

### Admin — All Serials View

Admin can see every serial in the system across all dealers with full filtering:

- Filter by: Dealer | Status | Category | Sub-Category | Age bracket | Physical Condition | IoT Linked

- Search by serial number

- Sort by: Invoice Date | Status | Dealer

- Export to CSV

| GET /api/admin/inventory/all      ?dealerId=DLR-001&status=available&category=3W&minAge=180      &sort=invoice_date_asc&page=1&limit=50  Response: { total, page, items: [ inventory rows ] } |
| --- |

### Admin — Write-Off Workflow

Admin can write off a battery or charger when it is damaged, stolen, or defective. Write-offs require a supporting reason and, for high-value items, a second admin approval.

| **Field** | **Specification** |
| --- | --- |
| Serial Number | Pre-filled. Read-only. |
| Write-Off Reason | Dropdown: Damaged │ Stolen │ Defective (manufacturing) │ Expired │ Lost in Transit │ Other. Required. |
| Reason Notes | Free text. Mandatory if reason = 'Other'. Min 20 chars. |
| Supporting Document | Optional file upload: police report (stolen), inspection report (defective), etc. |
| Write-Off Value (₹) | Auto-filled from invoice_value. Editable. Used for financial reporting. |

| POST /api/admin/inventory/:serialNumber/write-off  Request: { reason, reasonNotes, supportingDocUrl, writeOffValue, writtenOffBy }  Validation: item must be status = 'available'. Cannot write off reserved or sold items.  Processing:   1. inventory.status = 'written_off'   2. Create inventory_write_off record   3. Log inventory_event   4. Notify dealer: 'Item [serial] has been written off by iTarang admin.'  { "success": true, "serialNumber": "BAT12345", "status": "written_off" } |
| --- |

### Admin — Ageing Report

A purpose-built report showing all inventory items beyond configurable age thresholds.

| GET /api/admin/inventory/ageing-report      ?minAge=90&dealerId=DLR-001&category=3W&format=json│csv  Response columns: battery_id, material_code, dealer_name, category, sub_category,   model_number, sold_date, inventory_age_days, status, invoice_value,   star_rating, soc_percent, imei_id, iot_enabled,   oem_warranty_date, oem_warranty_expiry  Scheduled job: Every Monday 09:00 → auto-send CSV to ops@itarang.com                for all items with inventory_age > 180 days. |
| --- |

# **INTER-DEALER INVENTORY TRANSFER**

iTarang admin can transfer available inventory from one dealer to another. This is used to redistribute slow-moving stock or supply a dealer temporarily out of a category.

| **#** | **Step** | **Detail** |
| --- | --- | --- |
| 1 | Admin initiates | Admin selects source dealer and target dealer. Selects serial numbers to transfer (only 'available' items). Enters transfer reason. |
| 2 | System locks source | Selected serials: inventory.status = 'transferred_out'. No longer appear in source dealer's available inventory. |
| 3 | Target dealer notified | SMS + dashboard push: 'X items are being transferred to you. Acknowledge receipt when stock arrives.' |
| 4 | Target dealer acknowledges | Dealer clicks 'Confirm Receipt' for each serial in their Inventory → Incoming Transfers tab. Optionally adds warehouse location. |
| 5 | System updates | inventory.dealer_id = target_dealer_id. inventory.status = 'available'. Transfer record closed. |

| POST /api/admin/inventory/transfer   Request: { sourceDealerId, targetDealerId, serials: ["BAT12345","BAT12346"],            reason: "Rebalancing stock", initiatedBy: admin_user_id }   POST /api/dealer/inventory/acknowledge-transfer Request: { transferId, serials: ["BAT12345"], confirmedBy: dealer_user_id } |
| --- |

### DATABASE SCHEMA — INVENTORY

## **inventory**

| **Column** | **Type** | **Notes** |
| --- | --- | --- |
| **id** | **INT PK AUTO** |   |
| **inventory_id** | **VARCHAR(50) UNIQUE** | **INV-YYYY-TYPE-SEQ e.g. INV-2026-BAT-001** |
| **serial_number** | **VARCHAR(50) UNIQUE** | **DB name for Battery ID. Immutable after creation. Unique across entire table.** |
| **imei_id** | **VARCHAR(20) NULL** | **15-digit GSM IMEI of the IoT module. NULL for non-IoT batteries. UNIQUE when not null.** |
| **iot_enabled** | **BOOLEAN DEFAULT FALSE** | **TRUE when the battery has an IoT module. Drives SOC display and telemetry linkage.** |
| **material_code** | **VARCHAR(100)** | **OEM-supplied reference code. Required. Used for OEM warranty claims and future OEM portal integration.** |
| **inventory_type** | **ENUM** | **'battery' │ 'charger' │ 'paraphernalia_lot'** |
| **dealer_id** | **INT FK** | **references dealers.id. Changes on inter-dealer transfer.** |
| **category** | **VARCHAR(50)** | **'3W' │ '2W' │ '4W' │ 'Inverter' │ 'Solar' │ 'Other'. Immutable.** |
| **sub_category** | **VARCHAR(50)** | **e.g. 'E-Rickshaw', 'E-Cart', 'E-Auto'. Immutable. Used as context label in lead model.** |
| **model_number** | **VARCHAR(100)** | **DB name for Battery Model / Model Number. FK-validated against product_master_batteries.model_id.** |
| **voltage_v** | **DECIMAL(6,2) NULL** | **Batteries and chargers only. Auto-filled from product master.** |
| **capacity_ah** | **DECIMAL(8,2) NULL** | **Batteries only.** |
| **compatible_models** | **JSON NULL** | **Chargers: array of compatible battery model_ids.** |
| **star_rating** | **TINYINT** | **1-5. Quality/performance rating assigned at upload.** |
| **invoice_number** | **VARCHAR(100)** | **OEM invoice reference.** |
| **invoice_date** | **DATE** | **DB name for Sold Date. Immutable. Drives inventory_age = TODAY - invoice_date.** |
| **invoice_value** | **DECIMAL(12,2)** | **Per-unit purchase value.** |
| **supplier_name** | **VARCHAR(200)** | **OEM or supplier name.** |
| **oem_warranty_date** | **DATE** | **OEM warranty start date for this unit. May differ from invoice_date.** |
| **oem_warranty_months** | **INT** | **OEM warranty duration in months.** |
| **oem_warranty_expiry** | **DATE (computed)** | **Calculated: oem_warranty_date + oem_warranty_months. Stored for query performance. Used for automated expiry alerts.** |
| **oem_warranty_clauses** | **TEXT NULL** | **Free-text OEM warranty terms and exclusions. Optional but important for after-sales claim processing.** |
| **batch_reference** | **VARCHAR(100) NULL** | **PO or batch reference. Groups serials from same shipment.** |
| **physical_condition** | **ENUM** | **'new' │ 'refurbished' │ 'demo'** |
| **warehouse_location** | **VARCHAR(200) NULL** | **Dealer's storage location.** |
| **status** | **ENUM** | **'available' │ 'reserved' │ 'sold' │ 'written_off' │ 'transferred_out' │ 'transferred_in'** |
| **linked_lead_id** | **INT NULL FK** | **Set when status = reserved or sold.** |
| **upload_event_id** | **VARCHAR(50) FK NULL** | **references inventory_upload_events.event_id** |
| **created_by** | **INT FK** | **admin_user_id who uploaded.** |
| **created_at** | **TIMESTAMP** |   |
| **updated_at** | **TIMESTAMP** |   |

## **Paraphernalia_stock**

Paraphernalia is tracked at quantity level, not individual serials.

| **Column** | **Type** | **Notes** |
| --- | --- | --- |
| id | INT PK AUTO |  |
| dealer_id | INT FK | references dealers.id |
| item_type | VARCHAR(50) | 'digital_soc' │ 'volt_soc' │ 'harness_a' │ 'harness_b' │ 'harness_c' │ 'other' |
| item_label | VARCHAR(100) | Display name from product master |
| compatible_categories | JSON | Array of categories this item supports |
| available_qty | INT DEFAULT 0 | Current available units |
| reserved_qty | INT DEFAULT 0 | Units locked in active leads (not yet sold) |
| sold_qty | INT DEFAULT 0 | Cumulative units sold |
| unit_cost | DECIMAL(10,2) | Per-unit cost |
| last_upload_at | TIMESTAMP NULL |  |
| updated_at | TIMESTAMP |  |

## **inventory_events**

| **Column** | **Type** | **Notes** |
| --- | --- | --- |
| id | INT PK AUTO |  |
| serial_number | VARCHAR(50) | FK to inventory.serial_number |
| event_type | ENUM | 'uploaded' │ 'reserved' │ 'released' │ 'sold' │ 'written_off' │ 'transfer_initiated' │ 'transfer_received' │ 'iot_linked' │ 'edited' |
| from_status | VARCHAR(50) | Previous status |
| to_status | VARCHAR(50) | New status |
| lead_id | INT NULL FK | Set for reserve/release/sold events |
| performed_by | INT FK | admin_user_id or dealer_user_id |
| performed_at | TIMESTAMP |  |
| notes | TEXT NULL | Reason or context for the change |

## **I**nventory_upload_events**

| **Column** | **Type** | **Notes** |
| --- | --- | --- |
| id | INT PK AUTO |  |
| event_id | VARCHAR(50) UNIQUE | UPL-YYYYMMDD-DLRXXX-SEQ |
| dealer_id | INT FK |  |
| inventory_type | ENUM | 'battery' │ 'charger' │ 'paraphernalia' |
| upload_method | ENUM | 'csv' │ 'manual' |
| rows_imported | INT |  |
| rows_skipped | INT |  |
| file_url | TEXT NULL | Stored CSV file for audit |
| uploaded_by | INT FK | admin_user_id |
| uploaded_at | TIMESTAMP |  |
| report_url | TEXT NULL | Downloadable import report |

## **Inventory_transfers**

| **Column** | **Type** | **Notes** |
| --- | --- | --- |
| id | INT PK AUTO |  |
| transfer_id | VARCHAR(50) UNIQUE | TRF-YYYYMMDD-SEQ |
| source_dealer_id | INT FK |  |
| target_dealer_id | INT FK |  |
| serials | JSON | Array of serial_numbers being transferred |
| reason | TEXT |  |
| status | ENUM | 'pending_acknowledgement' │ 'completed' |
| initiated_by | INT FK | admin_user_id |
| initiated_at | TIMESTAMP |  |
| acknowledged_by | INT NULL FK | dealer_user_id |
| acknowledged_at | TIMESTAMP NULL |  |

### Product Master **&** Pricing

The Product Master is the central catalogue that defines every product type iTarang supports — its technical specifications, and warranty duration. It is the source of truth for inventory upload (which models exist), Step 4 product selection (which prices apply), and warranty creation (how long the warranty runs). No battery or charger can enter the inventory system without a matching product master entry.

| **Why the Product Master Must Exist Before Inventory Upload When an admin** uploads a battery CSV and selects 'Battery Model = 51.2V-105AH', the system must validate that model against the product master. If the model doesn't exist in the master, the upload is rejected. This prevents phantom products with no pricing from entering the system.** |
| --- |

### CATEGORY **&** SUB-CATEGORY MATRIX

The category and sub-category structure is used across lead creation (Step 1), inventory upload (Section 5.0), and Step 4 product selection. This matrix is the canonical reference.

| **Category (Code)** | **Sub-Categories** | **Notes** |
| --- | --- | --- |
| 3-Wheeler (3W) | 51.2 V-105AH, 51.2 V-140AH, 51.2 V-153AH,  60.8 V-105AH, 60.8 V-140AH, 60.8 V-153AH, 64 V-105AH, 64 V-140AH, 64 V-153AH, | RC document required at KYC. Most common category for iTarang. |
| 2-Wheeler (2W) | NA | RC document required. |
| 4-Wheeler (4W) | NA | RC document required. |
| Inverter | Power Cube 1.4, Power Cube 1.4+, Power Cube 2.7, Power Cube 2.7+, 5KWh | No RC required. No vehicle details in lead. |
| Solar | NA | No RC required. |
| Other | NA | Free-form sub-category entry allowed. |

| GET /api/inventory/categories   Response: [{ code: "3W", label: "3-Wheeler",              subCategories: ["51.2 V-105AH","51.2 V-140AH","51.2 V-153AH","60.8 V-105AH","60.8 V-140AH","60.8 V-153AH", "64 V-105AH","64 V-140AH","6X4 V-153AH"] },            { code: "2W", label: "2-Wheeler", subCategories: [...] }, ...] |
| --- |

**PRODUCT MASTER — BATTERY MODELS Admin Screen — Create / Edit Battery Model**

Admin Panel → Product Master → Batteries → Create New Model

| **#** | **Field** | **Type** | **Required?** | **Notes** |
| --- | --- | --- | --- | --- |
| 1 | Category | select | Yes | Unique. e.g. '3-Wheeler (3W)', '2-Wheeler (2W)','4-Wheeler (4W)','Inverter','Solar','Other'  Used as the dropdown value in inventory upload. |
| 2 | Sub-Categories | select | Yes | Which categories this model can be used for (e.g. 51.2V-105AH supports 3W/ Inverter, etc). |
| 3 | Voltage (V) | Decimal | Yes | e.g. 51.2 |
| 4 | Capacity (AH) | Decimal | Yes | e.g. 105 |
| 5 | Battery Chemistry | Dropdown | Yes | LFP │ NMC │ Lead Acid │ Other |
| 6 | Warranty (Months) | Integer | Yes | Standard warranty period for this model. Written to warranty.warranty_months at sale. |
| 7 | IoT Compatible | Boolean | Yes | Does this model support an IoT module? If true, IoT Device ID is shown in inventory upload. |
| 8 | Compatible Charger Models | Multi-select | Yes | Which charger models work with this battery. Controls Step 4 charger dropdown. |
| 9 | Status | Toggle | Yes | Active │ Inactive. Inactive models cannot be used in new inventory uploads but existing inventory is not affected. |

**PRODUCT MASTER — CHARGER MODELS Admin Screen — Create / Edit Charger Model**

| **#** | **Field** | **Type** | **Required?** | **Notes** |
| --- | --- | --- | --- | --- |
| **1** | **Model Name** | **Text** | **Yes** | **Unique. e.g. 'Fast Charger 51.2V-20A'. Used in inventory upload charger dropdown.** |
| **2** | **Output Voltage (V)** | **Decimal** | **Yes** |   |
| **3** | **Output Current (A)** | **Decimal** | **Yes** |   |
| **4** | **Charging Type** | **Dropdown** | **Yes** | **Standard │ Fast │ Smart │ Solar-Compatible** |
| **5** | **Compatible Battery Models** | **Multi-select** | **Yes** | **Must match the compatibility set defined in the battery model record.** |
| **6** | **Base Price (₹)** | **Decimal** | **Yes** | **Used in Step 4 price calculation.** |
| **7** | **Warranty (Months)** | **Integer** | **Yes** | **Charger warranty period. Separate from battery warranty.** |
| **8** | **Status** | **Toggle** | **Yes** | **Active │ Inactive** |

### PRODUCT MASTER — PARAPHERNALIA Admin Screen — Create / Edit Paraphernalia Item

| **#** | **Field** | **Type** | **Required?** | **Notes** |
| --- | --- | --- | --- | --- |
| **1** | **Item Type Code** | **Text** | **Yes** | **System identifier. e.g. 'digital_soc', 'harness_b'. Lowercase, no spaces.** |
| **2** | **Display Label** | **Text** | **Yes** | **Shown in Step 4 UI. e.g. 'Digital SOC', 'Harness Type B'.** |
| **3** | **Compatible Categories** | **Multi-select** | **Yes** | **Which categories can use this item.** |
| **4** | **Max Qty per Lead** | **Integer** | **Yes** | **Upper limit on how many of this item can be selected for a single lead.** |
| **5** | **Harness Variant** | **Boolean** | **Yes** | **If true: this item appears as a dropdown variant selector (not a quantity input) in Step 4.** |
| **6** | **Status** | **Toggle** | **Yes** | **Active │ Inactive** |

### DATABASE SCHEMA — PRODUCT MASTER

## **product_master_batteries**

| **Column** | **Type** | **Notes** |
| --- | --- | --- |
| **id** | **INT PK AUTO** |   |
| **model_id** | **VARCHAR(50) UNIQUE** | **e.g. 'BAT-51V-105AH-3W'** |
| **model_name** | **VARCHAR(100)** | **Display name** |
| **compatible_categories** | **JSON** | **Array of category codes** |
| **compatible_sub_categories** | **JSON** | **Array of sub-category strings** |
| **voltage_v** | **DECIMAL(6,2)** |   |
| **capacity_ah** | **DECIMAL(8,2)** |   |
| **battery_chemistry** | **ENUM** | **'lfp' │ 'nmc' │ 'lead_acid' │ 'other'** |
| **warranty_months** | **INT** | **Standard warranty duration.** |
| **iot_compatible** | **BOOLEAN DEFAULT FALSE** |   |
| **compatible_charger_models** | **JSON** | **Array of charger model_ids** |
| **status** | **ENUM** | **'active' │ 'inactive'** |
| **created_by** | **INT FK** | **admin_user_id** |
| **created_at** | **TIMESTAMP** |   |
| **updated_at** | **TIMESTAMP** |   |

## **COMPLETE WORKFLOW SUMMARY — SECTIONS 5.0 **&** 5.1**

| **#** | **Actor** | **Action **&** Outcome** |
| --- | --- | --- |
| 1 | Admin | Creates product master entries (battery models, charger models, paraphernalia items) with warranty months. |
| 2 | Admin | Navigates to Inventory Management → Upload Inventory. Selects target dealer. |
| 3 | Admin | Selects inventory type (Battery / Charger / Paraphernalia). Downloads CSV template. |
| 4 | Admin | Fills CSV with serial numbers and all required fields. Re-uploads. System validates: format, required fields, duplicate serials, model existence in product master. |
| 5 | System | On clean import: creates inventory rows with status = 'available', dealer_id set, creates upload_event record, notifies dealer. |
| 6 | Dealer | Logs in. Opens Inventory → Batteries tab. Sees all uploaded serials in table view with age, SOC, status. Can filter, search, and view detail cards. |
| 7 | Dealer | Opens Step 4 for a lead. Battery list loads from dealer's available inventory via GET /api/inventory/dealer/:dealerId/batteries?status=available, sorted oldest first. |
| 8 | System | Step 4 uses product_master to calculate base_price, enforce min_allowed_price and max_dealer_margin in real-time. |
| 9 | Finance path | Dealer submits Step 4 → POST /api/lead/:leadId/reserve-inventory → inventory.status = 'reserved', linked_lead_id set. Admin sanctions loan. On OTP confirm → POST /api/inventory/:serial/sell → inventory.status = 'sold'. Warranty FK to inventory.serial_number created. |
| 10 | Cash path | Dealer clicks Confirm Sale → single transaction: inventory.status = 'sold' immediately. Warranty record created with FK to inventory.serial_number. |
| 11 | Admin (ongoing) | Views inventory dashboard across all dealers. Runs ageing report. Initiates write-offs for damaged stock. Transfers slow-moving stock between dealers. |

### Integration, API Contracts **&** Business Rules STEP 4 ↔ INVENTORY INTEGRATION

This section resolves the primary integration gap identified in the BRD review: Step 4 (Product Selection) must query real dealer inventory — not a generic product catalogue — and must update inventory status atomically when a sale is confirmed. Without this linkage the inventory lifecycle defined in Section 5.0 cannot function**. Critical Gap Resolved**

Previous Step 4 spec referenced generic product endpoints (/api/inventory/products, /api/inventory/categories). These must be replaced with dealer-specific inventory queries. The inventory table, now fully defined in Section 5.0.9, is the authoritative source. All Step 4 product selection calls must query inventory rows, not product master rows directly.

### Step 4 — Corrected Battery Fetch API

| // BEFORE (incorrect — generic product list, no inventory linkage) GET /api/inventory/products?category=3-Wheeler   // AFTER (correct — dealer's actual available inventory) GET /api/inventory/dealer/:dealerId/batteries      ?status=available      &category=3W      &subCategory=51.2-105AH      &sort=invoice_date_asc   Auth: JWT required. dealerId in path must match token.dealer_id.       403 Forbidden if path dealerId != token.dealer_id.   Response: [{ serialNumber, materialCode, modelNumber, category, subCategory,              voltageV, capacityAh, starRating, soldDate, inventoryAge,              soc, status, oemWarrantyExpiry }]   Business rule: Only rows with status = 'available' returned.                Row with linked_lead_id set for any other lead must                not appear regardless of status display. |
| --- |

### Reserve Inventory — On Step 4 Submission (Finance Path)

When a dealer submits Step 4 (finance path), inventory must be atomically reserved before the lead enters the admin queue. This prevents two dealers selecting the same serial concurrently

| POST /api/lead/:leadId/reserve-inventory  Request: {  "batterySerial": "BAT12345",    "chargerSerial": "CHR98765",    "dealerId":      "DLR-001" }  Server-side transaction:   BEGIN TRANSACTION   1. SELECT inventory WHERE serial_number = batterySerial         AND dealer_id = dealerId         AND status = 'available'      FOR UPDATE  ← row-level lock prevents race condition   2. If not found or status != available: ROLLBACK → 409 Conflict      { "error": "INVENTORY_NOT_AVAILABLE",        "message": "Battery BAT12345 is no longer available." }   3. UPDATE inventory SET status='reserved', linked_lead_id=leadId,         updated_at=NOW WHERE serial_number=batterySerial   4. Repeat steps 1-3 for chargerSerial   5. INSERT inventory_events (reserve event for both serials)   6. COMMIT  Response 200: { "success": true, "batteryReserved": "BAT12345", "chargerReserved": "CHR98765" }  Response 409 (conflict): { "success": false, "error": "INVENTORY_NOT_AVAILABLE",   "message": "Battery BAT12345 was selected by another dealer. Please re-select." } |
| --- |

### Mark Inventory Sold — On OTP Confirm / Cash Sale

| POST /api/inventory/:serialNumber/sell // Called internally by confirm-dispatch (finance) and confirm-cash-sale // Not exposed as a standalone public endpoint   Input (from calling function): {  "serialNumber": "BAT12345",    "leadId":       "IT-2026-0000123",    "soldAt":       "2026-07-28T15:45:00Z",    "soldBy":       "dealer_user_id" }   Transaction (part of the parent confirm-dispatch transaction):   UPDATE inventory     SET status = 'sold',         linked_lead_id = leadId,         updated_at = NOW   WHERE serial_number = serialNumber     AND status = 'reserved'          ← guard: must still be reserved     AND linked_lead_id = leadId;     ← guard: reserved for THIS lead only     If rows_affected = 0: ROLLBACK entire parent transaction   INSERT inventory_events (sold event)     Then inline: POST /api/warranty/create  (with battery_serial FK)                ALTER TABLE warranty ADD CONSTRAINT fk_warranty_inventory                FOREIGN KEY (battery_serial)                REFERENCES inventory(serial_number); |
| --- |

### Release Reserved Inventory — On Admin Product Rejection or Lead Cancellation

| POST /api/inventory/release // Called when: admin rejects product selection, loan rejected, lead cancelled   Request: { "leadId": "IT-2026-0000123", "reason": "admin_rejected │ loan_rejected │ lead_cancelled" }   Transaction:   UPDATE inventory     SET status = 'available', linked_lead_id = NULL, updated_at = NOW   WHERE linked_lead_id = leadId AND status = 'reserved'     INSERT inventory_events (released event, reason logged) |
| --- |

### COMPLETE API CONTRACT TABLE

The table below is the authoritative API register for Sections 5.0 and 5.1, incorporating all new endpoints required by the integration analysis. All endpoints require HTTPS. Authentication is JWT unless noted.

| Endpoint | Method | Auth Role | Purpose & Status |
| --- | --- | --- | --- |
| /api/admin/inventory/csv-template | GET | Admin | Download CSV template for battery │ charger │ paraphernalia. ?type= param required. |
| /api/admin/inventory/bulk-upload | POST | Admin | Upload inventory CSV for a dealer. Validates all rows. Returns import report. Transactional. |
| /api/admin/inventory/add-item | POST | Admin | Add single inventory item. Full field validation. 400 if serial duplicate or model not in product master. |
| /api/admin/inventory/all | GET | Admin | Cross-dealer inventory view. Filters: dealerId, status, category, minAge. |
| /api/admin/inventory/:serial/write-off | POST | Admin | Write off a damaged/stolen unit. Only allowed if status = available. Logs event. |
| /api/admin/inventory/transfer | POST | Admin | Initiate inter-dealer transfer. Sets source serials to transferred_out. |
| /api/admin/inventory/ageing-report | GET | Admin | Ageing report with minAge, dealer, category filters. CSV export supported. |
| /api/lead/:leadId/reserve-inventory | POST | Dealer | NEW — Atomically reserves battery + charger serials against a lead. Row-level lock. 409 on conflict. Called at Step 4 submission. |
| /api/inventory/:serial/sell | POST | Internal | NEW — Internal call within confirm-dispatch / confirm-cash-sale transaction. Marks serial sold, sets linked_lead_id. Creates warranty FK. |
| /api/inventory/release | POST | System | NEW — Releases reserved inventory back to available. Called on rejection / cancellation. |
| /api/inventory/dealer/:dealerId/batteries | GET | Dealer | List dealer's batteries. Auth: dealerId must match token. Filters: status, category, sort. |
| /api/inventory/dealer/:dealerId/chargers | GET | Dealer | List dealer's chargers. Same auth rule. |
| /api/inventory/dealer/:dealerId/paraphernalia | GET | Dealer | List dealer's paraphernalia stock quantities. |
| /api/inventory/:serialNumber/card | GET | Dealer/Admin | Full detail card for a serial. Dealers restricted to own inventory serials only. |
| /api/dealer/inventory/acknowledge-transfer | POST | Dealer | Dealer confirms receipt of transferred stock. Sets status = available under new dealer_id. |
| /api/admin/product-master/batteries | GET/POST | Admin | List or create battery models. |
| /api/admin/product-master/batteries/:modelId | PUT | Admin | Update battery model. Creates price_history record. Snapshot stored. |
| /api/admin/product-master/chargers | GET/POST | Admin | List or create charger models. |
| /api/admin/product-master/chargers/:modelId | PUT | Admin | Update charger model. |
| /api/admin/product-master/paraphernalia | GET/POST/PUT | Admin | Manage paraphernalia item types. |
| /api/inventory/categories | GET | Public | Returns category / sub-category matrix. Used in Step 1 and Step 4 UI dropdowns. |
| /api/iot/battery/:serial/soc | GET | Internal | Fetch live SOC from IoT backend for a serial. Returns soc_percent, last_sync. |

Rows highlighted in green are new endpoints added to resolve the Step 4 ↔ inventory integration gap.

### AUDIT LOGGING — INVENTORY EVENTS

Every state-changing operation on inventory must produce an audit record. This satisfies OWASP logging best practices: log who, what, when, and the outcome for all admin actions and validation failures.

## **Events That Must Be Logged**

| **Event** | **Severity** | **Log Fields** |
| --- | --- | --- |
| Inventory item uploaded | INFO | event_type, serial_number, dealer_id, uploaded_by, upload_event_id, timestamp |
| CSV upload — row validation failure | WARN | row_number, field, error_message, upload_event_id, uploaded_by, timestamp |
| Inventory reserved | INFO | serial_number, lead_id, dealer_id, performed_by, timestamp |
| Inventory released (unreserved) | INFO | serial_number, lead_id, reason, performed_by, timestamp |
| Inventory sold | INFO | serial_number, lead_id, sold_by, sold_at, timestamp |
| Write-off | WARN | serial_number, reason, reason_notes, write_off_value, written_off_by, timestamp |
| Transfer initiated | INFO | transfer_id, source_dealer, target_dealer, serials[], initiated_by, timestamp |
| Transfer acknowledged | INFO | transfer_id, serials[], acknowledged_by, timestamp |
| Product master price change | WARN | model_id, old_price, new_price, changed_by, timestamp — old values preserved in price_history |
| Unauthorised access attempt | ERROR | endpoint, method, requester_id, requester_dealer_id, target_dealer_id, timestamp |

| // All inventory_events records use the existing schema from Section 5.0.9 // Additional security/auth events go to a separate security_audit_log table:  CREATE TABLE security_audit_log (   id            INT PRIMARY KEY AUTO_INCREMENT,   event_type    VARCHAR(50)  NOT NULL,  -- e.g. 'FORBIDDEN_ACCESS'   endpoint      VARCHAR(200),   http_method   VARCHAR(10),   requester_id  INT,                    -- user_id (nullable if pre-auth)   requester_role VARCHAR(50),   target_resource VARCHAR(200),         -- e.g. 'inventory/DLR-002/batteries'   outcome       ENUM('allowed','denied','error'),   ip_address    VARCHAR(45),            -- IPv4 or IPv6   user_agent    TEXT,   occurred_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ); |
| --- |

### CSV UPLOAD — ENHANCED VALIDATION **&** ERROR HANDLING

The bulk upload endpoint must perform row-level validation and return structured error responses. Partial imports are permitted — valid rows are imported, invalid rows are reported. Admin can correct and re-upload the rejected rows only.

### Validation Rules per Row

| **Rule** | **Condition** | **Error Message** |
| --- | --- | --- |
| **Required fields present** | **All fields marked Required in Section 'Battery Upload Fields' must be non-empty** | **Row {N}: Field '{field}' is required.** |
| **Serial uniqueness (cross-DB)** | **serial_number must not exist in inventory table** | **Row {N}: Battery ID '{serial}' already exists in the system.** |
| **Serial uniqueness (within CSV)** | **No two rows in the same CSV may share a serial_number** | **Row {N}: Battery ID '{serial}' appears again at row {M} in this file.** |
| **IMEI format** | **imei_id, if provided, must be exactly 15 numeric digits** | **Row {N}: IMEI ID must be 15 digits. Got: '{value}'.** |
| **IMEI required when IoT Enabled** | **If iot_enabled = Yes, imei_id must be present** | **Row {N}: IMEI ID is required when IoT Enabled = Yes.** |
| **IMEI uniqueness** | **imei_id, if provided, must not exist in inventory table** | **Row {N}: IMEI ID '{imei}' is already assigned to another battery.** |
| **Model exists in product master** | **model_number must exist in product_master_batteries.model_id** | **Row {N}: Model Number '{model}' not found in product catalogue.** |
| **Category/Sub-Category match** | **category and sub_category must be in the canonical matrix (Section 5.1.2)** | **Row {N}: Sub-Category '{sub}' is not valid for Category '{cat}'.** |
| **Sold Date format** | **sold_date must be DD-MM-YYYY and not in the future** | **Row {N}: Sold Date '{value}' is invalid or in the future.** |
| **OEM Warranty Date** | **oem_warranty_date, if provided, must be DD-MM-YYYY** | **Row {N}: OEM Warranty Date format invalid.** |
| **Numeric ranges** | **voltage_v **>** 0, capacity_ah **>** 0, invoice_value **>** 0, oem_warranty_months **>** 0** | **Row {N}: Field '{field}' must be a positive number.** |
| **Star Rating range** | **star_rating must be integer 1-5** | **Row {N}: Star Rating must be between 1 and 5.** |
| **Dealer ID valid** | **dealerId must exist in dealers table and be active** | **400: Dealer '{dealerId}' not found or inactive. (Pre-import check, blocks entire upload.)** |
| **Max rows per upload** | **File must not exceed 500 rows** | **400: File contains {N} rows. Maximum per upload is 500. Please split into multiple files.** |

### Upload Response Schema

| POST /api/admin/inventory/bulk-upload   Response 200 (partial or full success): {   "success": true,   "uploadEventId": "UPL-20260726-DLR001-001",   "totalRows": 52,   "imported": 49,   "skipped": 3,   "errors": [     { "row": 7,  "field": "serial_number", "code": "DUPLICATE_SERIAL",       "message": "Battery ID BAT99901 already exists in the system." },     { "row": 18, "field": "model_number",  "code": "MODEL_NOT_FOUND",       "message": "Model Number XYZ-999 not found in product catalogue." },     { "row": 31, "field": "imei_id",       "code": "IMEI_REQUIRED",       "message": "IMEI ID is required when IoT Enabled = Yes." }   ],   "reportUrl": "/api/admin/inventory/upload-report/UPL-20260726-DLR001-001" }   Response 400 (pre-import block — entire upload rejected): {   "success": false,   "code": "INVALID_DEALER",   "message": "Dealer DLR-999 not found or inactive." } |
| --- |

### UI VALIDATION RULES

UI-level validation complements server-side validation. Client-side rules improve UX by surfacing errors before an API call is made. They do not replace server-side validation — all rules are enforced on both sides.

| **Screen / Field** | **Client-Side Rule** | **UX Behaviour** |
| --- | --- | --- |
| Upload: File type | Accept .csv and .xlsx only | File picker filters. If wrong type selected: 'Please upload a CSV or Excel file.' Toast error. |
| Upload: File size | Max 5 MB | 'File exceeds 5 MB limit. Please reduce or split the file.' Blocks upload button. |
| Upload: Dealer selection | Dealer must be selected before upload form appears | Upload form hidden until dealer selected. No bypass. |
| Upload: Preview | Show first 10 rows before validation runs | 'Preview (first 10 rows shown). Click Validate All to check full file.' Prevents blind uploads. |
| Step 4: Battery list | Only show available batteries (from API response) | Reserved/sold items do not appear. If no available stock: 'No batteries available for this category. Please contact your inventory manager.' |
| Step 4: Inventory selection | Cannot proceed without selecting a battery | Submit button disabled. Tooltip: 'Please select a battery to continue.' |
| Step 4: Price display | Final price updates in real-time as margin is entered | If final_price < min_allowed_price: input border turns red, 'Price is below minimum allowed (₹{min}).' |
| Step 4: Conflict (409) | If API returns 409 on submit | Modal: 'Battery {serial} is no longer available. Another dealer may have selected it. Please choose a different battery.' Battery list refreshes automatically. |
| Detail card: IoT badge | Show 'IoT Enabled ' / 'No IoT' | If iot_enabled = true and imei_id present: green badge. If iot_enabled = true but no SOC data: '⚠️ IoT linked — no telemetry received yet'. |
| Inventory list: empty state | No items for this filter | 'No batteries found for the selected filters. Try clearing the status or category filter.' |
| Write-off form | Cannot write off reserved or sold item | Write-off button disabled for reserved/sold items. Tooltip: 'Only available items can be written off.' |

### BUSINESS RULES — CONSOLIDATED

The following table consolidates all business rules governing inventory and product master operations, covering both the original spec and additions from the integration analysis.

| **#** | **Rule** | **Enforcement Point** |
| --- | --- | --- |
| BR-01 | Serial number (battery_id) is immutable after creation. Cannot be edited, only written off. | DB: no UPDATE allowed on serial_number column after INSERT. API enforces. |
| BR-02 | A battery's category and sub_category are immutable after creation. | API: PUT /api/admin/inventory/add-item rejects category field. Only non-critical fields editable. |
| BR-03 | IMEI ID must be unique across all inventory when present. Two batteries cannot share an IMEI. | DB: UNIQUE index on imei_id WHERE imei_id IS NOT NULL. API enforces pre-insert check. |
| BR-04 | model_number in inventory must reference a valid, active entry in product_master_batteries. | DB: FK constraint. API validates against product master before insert. |
| BR-05 | A battery must have status = 'available' and belong to the requesting dealer to appear in Step 4. | API: inventory fetch filtered by status = available AND dealer_id = token.dealer_id. |
| BR-06 | Inventory reservation uses row-level locking (SELECT FOR UPDATE) to prevent race conditions when two dealers attempt to select the same serial simultaneously. | API: reserve-inventory endpoint. See Section 5.2.1.2. |
| BR-07 | A sold item can never return to available except via a formal admin exception (fraud/error case) requiring Super Admin approval and mandatory audit note. | API: no endpoint exposes this path to normal flow. Exception process to be documented separately. |
| BR-08 | final_price in Step 4 must be ≥ product_master.min_allowed_price and dealer_margin must be ≤ product_master.max_dealer_margin. Both enforced server-side. | API: submit-product-selection validates against product master snapshot before reserving inventory. |
| BR-09 | Product master price changes do not retroactively affect in-progress or completed product_selection records. Prices are snapshotted at Step 4 submission. | DB: product_selections stores battery_base_price at submission time. Price history in product_master_price_history. |
| BR-10 | Paraphernalia stock is deducted at sale confirmation (OTP confirm / cash confirm), not at Step 4 submission. Paraphernalia is not reserved at Step 4. | API: deduction happens in confirm-dispatch / confirm-cash-sale transaction. |
| BR-11 | OEM Warranty Clauses, though optional at upload, must be surfaced in the Battery Detail Card and in the after-sales warranty claim module. A missing clause must show 'No OEM clauses recorded — contact supplier directly.' | UI: detail card and after-sales module must show this field. NULL displayed as the fallback message. |
| BR-12 | warranty.battery_serial is a FK referencing inventory.serial_number. A warranty record cannot exist for a serial not in the inventory table. | DB: FK constraint. ALTER TABLE warranty ADD CONSTRAINT fk_warranty_inventory FOREIGN KEY (battery_serial) REFERENCES inventory(serial_number). |

### NON-FUNCTIONAL REQUIREMENTS

| **Category** | **Requirement** | **Implementation Guidance** |
| --- | --- | --- |
| Performance | Interactive API calls (inventory list, detail card) must respond in <500ms under normal load. | DB indexes on serial_number, dealer_id, status, invoice_date. Paginate inventory list (default 50 rows). Cache product master in application layer (TTL 5 minutes). |
| Performance | CSV bulk import: up to 500 rows must complete within 10 seconds. | Async processing with progress polling if >100 rows. Stream CSV — do not load entire file into memory. Batch INSERT in groups of 50. |
| Security | All endpoints must use HTTPS. No plaintext transmission of inventory or financial data. | TLS 1.2 minimum. HSTS header on all responses. |
| Security | DB credentials must not be hard-coded. Use environment variables or secrets manager. | AWS Secrets Manager / Vault. Rotate credentials on schedule. DB account has minimal privileges per table. |
| Security | Prevent SQL injection. All DB queries must use parameterised statements. | Use ORM (Sequelize / Prisma) or prepared statements. No string concatenation in queries. |
| Auditability | All inventory status changes must be logged in inventory_events within the same DB transaction. | Log INSERT is part of the transaction — if transaction rolls back, the log rolls back too, preventing phantom audit records. |
| Auditability | Security events (403s, failed auth) must be logged in security_audit_log asynchronously. | Write to security_audit_log after sending response (async, non-blocking). Do not let logging failure block the response. |
| Resilience | CSV upload failures must not leave partial state. Either all valid rows import or admin is clearly shown what failed. | Use DB transaction per batch of 50 rows. On batch failure: rollback batch, continue with next batch, report errors. |
| Observability | Track: API error rates, CSV import success/failure ratio, inventory reservation conflict rate (409s). | Prometheus metrics or equivalent. Alert if 409 rate on reserve-inventory exceeds 5% over 5 minutes (indicates inventory shortage). |

---

## Part G — Cash Flow streamlined path

When payment_method = 'Cash' is selected in Step 1, the system routes the lead through a streamlined, inventory-driven flow. The KYC and financing stages are bypassed. The primary concern shifts from credit risk to inventory accuracy, price integrity, and delivery confirmation, Warranty and post sales services.

### Cash Flow Status Sequence

| **No Admin Queue in Cash Flow There is no 'pending_cash_approval' or 'approved_cash_sale' status. When the dealer clicks Confirm Sale, the system moves directly from product_selection_in_progress to sold in a single transaction. Warranty and after-sales records are created in the same transaction.** |
| --- |

| **Status** | **Triggered By** | **Next State / Notes** |
| --- | --- | --- |
| **lead_created** | **Step 1 submitted** | **payment_method = 'Cash' written. Steps 2 **&** 3 skipped.** |
| **product_selection_in_progress** | **Dealer opens Step 4** | **Inventory list loaded. Save Draft available.** |
| **sold** | **Dealer clicks Confirm Sale → confirms modal** | **IMMEDIATE. Inventory status = sold. Warranty created. After-sales record opened. Customer notified.** |
| **completed** | **System — post-sale lifecycle closed** | **Warranty active. Service tracking open.** |
| **cancelled_cash** | **Dealer cancels before confirmation** | **No inventory impact (was never reserved). Lead closed.** |

### Cash Flow — System-Side Controls (No Admin)

Because there is no admin approval in a cash sale, the system itself must enforce the integrity checks that admin would normally perform. These are enforced server-side at the point of confirm-cash-sale:

| **Control** | **How Enforced** |
| --- | --- |
| **Correct product category** | **Battery serial must match selected category/sub-category in product master. Server rejects if mismatch.** |
| **Battery serial valid **&** available** | **Server re-checks inventory.status = 'available' at transaction time. Race condition guard prevents double-sale.** |
| **Charger compatible** | **Charger model must be in battery's compatible_chargers list. Server validates.** |
| **No duplicate serial** | **Unique constraint: cannot confirm sale if serial already has status = 'sold' or 'dispatched'.** |
| **Dealer inventory ownership** | **Battery and charger serials must belong to the confirming dealer's inventory. Cross-dealer sale blocked.** |

### Audit Trail

Even without admin approval, every cash sale is fully logged: confirmed_by (dealer user ID), confirmed_at (timestamp), final_price, serial numbers. This log is available to iTarang for post-sale auditing and dispute resolution.

### INVENTORY MOVEMENT — COMPLETE LIFECYCLE

Inventory moves through a strict one-way status pipeline. The same pipeline applies to both cash and finance flows, with the trigger events differing.

### Inventory Status Pipeline

| **Status** | **Triggered By** | **Finance │ Cash** |
| --- | --- | --- |
| available | Stock invoiced to dealer | Both: initial state on stock receipt |
| reserved | Step 4 submitted by dealer (finance only) | Finance: inventory locked against the lead pending admin approval. Cannot be selected for another lead. Cash: this status is skipped entirely — inventory moves directly to 'sold' on dealer confirmation. |
| dispatched | Finance: dealer confirms dispatch after loan disbursement | Finance only. Intermediate state between admin approval and sold confirmation. |
| sold | Finance: after dispatch confirmation Cash: immediately on dealer Confirm Sale | Both paths end here. Triggers warranty creation and after-sales service record. |
| available (released) | Finance: admin rejects product selection OR lead cancelled Cash: dealer cancels before confirming (no inventory impact — was never reserved) | Finance: reserved → available. Cash: no status change needed (never left available). |

### Dispatch Confirmation API — Finance Path Only

For finance leads, dispatch is a separate event that occurs after admin approval and loan disbursement. For cash leads, dispatch is implicit in the Confirm Sale action — no separate dispatch API call is needed.

| POST /api/inventory/dispatch   Request: {  "leadId":         "IT-2026-0000123",    "batterySerial":  "BAT12345",    "chargerSerial":  "CHR98765",    "dispatchDate":   "2026-07-28",    "confirmedBy":    "dealer_user_id",    "deliveryOtp":    "847291"    ← OTP confirmed by customer (if applicable) }   System Actions:   1. inventory.status = 'dispatched'  (battery + charger)   2. inventory.dispatch_date = dispatchDate   3. inventory.linked_lead_id = leadId   4. lead.status = 'dispatched'   5. Trigger: POST /api/warranty/create  (see Section 3.6)   6. Schedule: mark inventory as 'sold' after N days (configurable, default 1 day)   Response: { "success": true, "warrantyId": "WRN-2026-BAT12345", "warrantyStart": "2026-07-28" } |
| --- |

### Inventory Release on Rejection — Finance Path

For cash sales, inventory is never in a 'reserved' state so no release is needed if the dealer cancels. The release API applies only to finance leads where admin has rejected the product selection.

| POST /api/inventory/release  Request: { "leadId": "IT-2026-0000123", "reason": "admin_rejected │ lead_cancelled" }  System Actions:   1. battery.status  = 'available'   2. charger.status  = 'available'   3. Paraphernalia qty restored to dealer stock   4. product_selection record marked 'cancelled' |
| --- |

### Anti-Fraud Rules

| **Risk** | **System Control** |
| --- | --- |
| Dealer selling wrong serial | Admin must verify battery serial exists in dealer inventory and matches selected model before approving. |
| Fake dispatch | Customer OTP or app-based delivery confirmation (see Section 3.5.5). Dispatch not confirmed until OTP received. |
| Old inventory withheld | Ageing priority sort + Recommended badge on oldest unit + admin visibility of inventory_age in product panel. |
| Serial reuse | Once a serial is dispatched, it cannot be reserved again. Unique constraint on inventory.serial_number + status check. |

### Customer Delivery Confirmation (Best Practice)

To prevent fake dispatch events, the system should request a delivery OTP from the customer:

- On dispatch initiation: system sends SMS OTP to customer's registered mobile

- Dealer enters OTP in dispatch confirmation screen

- System validates OTP before finalising dispatch status

- If IoT is available: warranty is activated on first battery usage rather than dispatch date

### WARRANTY MANAGEMENT

Warranty is linked to the physical battery serial number, not to the loan or the dealer. This ensures warranty validity survives loan transfers, dealer changes, and resale scenarios.

### When Does Warranty Start?

| **Option** | **Trigger** | **Recommended?** | **Use Case** |
| --- | --- | --- | --- |
| **Invoice Date** | **When dealer received stock** | **Wrong** | **Does not reflect actual customer use. Battery may sit in stock for months.** |
| **Dispatch Date** | **When product given to customer** | **Standard** | **Default for iTarang. Reliable, no IoT dependency.** |

### iTarang Recommended Logic

warranty_start = dispatch_date. This logic is determined at the time of warranty record creation and stored — it does not change retrospectively.

### Warranty Creation — API

| POST /api/warranty/create   Trigger points:   Finance: called by POST /api/inventory/dispatch (after loan disbursement)   Cash:    called inline by POST /api/lead/:leadId/confirm-cash-sale            (same transaction — warranty is created the moment the sale is confirmed)   Request: {  "batterySerial":    "BAT12345",    "customerId":       "lead_id / customer_id",    "dealerId":         "dealer_id",    "leadId":           "IT-2026-0000123",    "dispatchDate":     "2026-07-28",    "paymentMode":      "cash" │ "finance",    "iotAvailable":     true │ false }   Processing:       warranty_start = dispatchDate  (or confirmation date for cash)     warranty_start_source = 'dispatch'     warranty_end = warranty_start + product_master.warranty_months   Response: { "warrantyId": "WRN-2026-BAT12345", "status": "pending_activation" │ "active",   "warrantyStart": "2026-07-28" │ null, "warrantyStartSource": "dispatch"} |
| --- |

Warranty Data Schema

| **Column** | **Type** | **Notes** |
| --- | --- | --- |
| id | INT PK AUTO |  |
| warranty_id | VARCHAR(50) UNIQUE | WRN-YYYY-SERIALNO |
| battery_serial | VARCHAR(50) FK | references inventory.serial_number. KEY LINK. |
| customer_id | INT FK | references leads.id (or customers table if exists) |
| dealer_id | INT FK |  |
| lead_id | INT FK |  |
| dispatch_date | DATE | Date of physical dispatch |
| warranty_start | TIMESTAMP NULL | NULL until IoT event received (if IoT mode). Populated immediately for dispatch mode. |
| warranty_start_source | ENUM | 'dispatch' |
| warranty_end | TIMESTAMP NULL | Calculated on warranty_start confirmation |
| warranty_months | INT | From product master at time of creation (immutable) |
| status | ENUM | 'pending_activation' │ 'active' │ 'expired' │ 'void' |
| iot_first_use_at | TIMESTAMP NULL | Populated by IoT event listener. Triggers warranty activation if source = 'iot'. |
| payment_mode | ENUM | 'cash' │ 'finance' — stored for reporting |
| created_at | TIMESTAMP |  |

### Critical Gap: Battery → Customer → Warranty Link Critical System Requirement

Every battery serial must be uniquely linked to exactly one active warranty record, which links to exactly one customer and one lead. Without this three-way link (Battery Serial → Customer → Warranty), warranty claims cannot be verified, service history is lost, and replacement tracking breaks. This is non-negotiable for after-sales operations.

| Link | How It Is Enforced |
| --- | --- |
| Battery Serial → Warranty | warranty.battery_serial is a FK to inventory.serial_number. UNIQUE constraint: one active warranty per serial. |
| Warranty → Customer | warranty.customer_id FK to leads/customers table. |
| Warranty → Lead | warranty.lead_id FK to leads table. Full transaction history preserved. |
| Warranty → Dealer | warranty.dealer_id for dealer accountability and service routing. |

### PRODUCT SELECTION DATABASE SCHEMA

## **Product_selections**

| **Column** | **Type** | **Notes** |
| --- | --- | --- |
| id | INT PK AUTO |  |
| lead_id | INT FK UNIQUE | One product selection per lead |
| battery_serial | VARCHAR(50) FK | references inventory.serial_number |
| charger_serial | VARCHAR(50) FK | references inventory.serial_number |
| paraphernalia | JSON | { "digital_soc": 2, "volt_soc": 0, "harness": "type_b" } |
| battery_price | DECIMAL(12,2) | Snapshot from product master at submission time |
| charger_price | DECIMAL(12,2) |  |
| paraphernalia_total | DECIMAL(12,2) |  |
| dealer_margin | DECIMAL(12,2) |  |
| final_price | DECIMAL(12,2) |  |
| category | VARCHAR(50) | Final category used for inventory match |
| sub_category | VARCHAR(50) |  |
| submitted_at | TIMESTAMP |  |
| submitted_by | INT FK | dealer_user_id |
| admin_action | ENUM NULL | NULL │ 'loan_sanctioned' │ 'loan_rejected' │ 'product_rejected' |
| admin_action_at | TIMESTAMP NULL |  |
| admin_action_by | INT NULL FK |  |
| rejection_reason | TEXT NULL | Populated for loan_rejected and product_rejected actions |
| status | ENUM | 'in_progress' │ 'submitted' │ 'loan_sanctioned' │ 'loan_rejected' │ 'product_rejected' │ 'dealer_confirmed' │ 'cancelled' |

## **loan_sanctions**

| **Column** | **Type** | **Notes** |
| --- | --- | --- |
| id | INT PK AUTO |  |
| loan_sanction_id | VARCHAR(50) UNIQUE | LS-YYYY-LEADREF |
| lead_id | INT FK | references leads.id |
| product_selection_id | INT FK |  |
| loan_amount | DECIMAL(12,2) | Total sanctioned loan value |
| down_payment | DECIMAL(12,2) |  |
| file_charge | DECIMAL(12,2) |  |
| subvention | DECIMAL(12,2) | 0 if none |
| disbursement_amount | DECIMAL(12,2) |  |
| emi | DECIMAL(10,2) | Monthly instalment |
| tenure_months | INT |  |
| roi | DECIMAL(5,2) | Annual rate of interest % |
| loan_approved_by | VARCHAR(200) | Lender / NBFC name |
| loan_file_number | VARCHAR(100) | Lender's reference number |
| sanctioned_by | INT FK | admin_user_id |
| sanctioned_at | TIMESTAMP |  |
| dealer_approved | BOOLEAN DEFAULT FALSE | Set to TRUE when dealer approves loan terms at Step 5 |
| dealer_approved_at | TIMESTAMP NULL |  |
| dealer_approved_by | INT NULL FK | dealer_user_id |
| disbursed | BOOLEAN DEFAULT FALSE | Set TRUE after actual disbursement event |
| disbursed_at | TIMESTAMP NULL |  |
| status | ENUM | 'pending_dealer_approval' │ 'dealer_approved' │ 'disbursed' │ 'cancelled' |

### Step 5: Loan Review, OTP Confirmation **&** Dispatch

Step 5 is the final dealer-side action screen. It is reached when the admin has acted on the product selection in Step 4. It handles two scenarios: the loan was sanctioned (dealer reviews terms, gets customer OTP confirmation, dispatches), or the loan was rejected (dealer and customer see the reason). This step does not apply to cash sales — cash leads complete at Step 4.

### Entry Conditions — When Step 5 Appears

| **lead.status** | **Step 5 Visible?** | **Scenario Shown** |
| --- | --- | --- |
| **loan_sanctioned** | **✅ Yes** | **Loan Sanctioned — dealer reviews, gets OTP, dispatches** |
| **loan_rejected** | **✅ Yes** | **Loan Rejected — dealer sees rejection reason** |
| **sold (cash)** | **❌ No — Step 5 not applicable** | **Cash leads are complete after Step 4** |
| **Any other** | **🔒 Blocked** | **Redirect to last valid step** |

| GET /api/lead/:leadId/step-5-access   Response (loan_sanctioned): { "allowed": true, "scenario": "loan_sanctioned", "loanSanctionId": "LS-2026-0000123" }   Response (loan_rejected): { "allowed": true, "scenario": "loan_rejected", "rejectionReason": "...", "rejectedBy": "ABC Finance" }   Response (blocked): { "allowed": false, "redirectTo": "/leads/:leadId/step-4" } |
| --- |

### Progress Bar State

| **Step 1 Lead ✅** | **Step 2 KYC ✅** | **Step 3 Docs ✅ (cond.)** | **Step 4 Product ✅** | **Step 5 Loan **&** Dispatch ** |
| --- | --- | --- | --- | --- |

### SCENARIO A — LOAN SANCTIONED SCREEN

This screen is displayed when lead.status = 'loan_sanctioned'. It shows the complete loan terms as entered by the admin, gives the dealer tools to discuss with the customer, and collects OTP-based customer consent before confirming dispatch

### Screen Header

| **Element** | **Value** |
| --- | --- |

---

## Document maintenance

- This file is the **single source of truth** for the iTarang CRM workflow.
- When the BRD changes, edit this file and commit. Do not edit the `.docx` separately.
- Status values, API contracts, and field schemas are normative — implementation must follow.
- For diagrams, see companion file `docs/specs/CRM_BRD_V2_diagrams.md` (if present) or generate fresh visuals from this BRD.

**Last conversion:** from `CRM_BRD__internal__-_V2__24th_Feb__7_.docx` on 2026-04-24.
