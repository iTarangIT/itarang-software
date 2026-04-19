 **Dashboard\_Button Schema**

## Button Functions & User Interactions

### **Top Menu Action Buttons**

1. **SEARCH BAR**

Purpose: Global search across dealer’s ecosystem.  
Workflow:

1. Click → Open global search overlay  
2. Real-time search (debounced API)  
3. Show categorized results:  
* Leads  
* Loans  
* Assets  
* Inventory  
* Campaigns  
* Customers

4. Each result clickable → redirect to respective module page  
5. Search parameters supported:  
   * Customer Name  
   * Mobile Number  
   * Lead ID  
   * Loan ID  
   * Asset ID  
   * Campaign ID  
   * Inventory ID  
   * Service ticket ID  
6. Add:  
   * Recent searches  
   * Fuzzy search

## **2\. Dealer Profile Dropdown**

## **Flow**

Click → dropdown:

* View Profile  
* Change Password  
* Active subscription status  
* Logout

### 

### **Main Action Buttons**

1. ### **NEW LEAD** 

   ### **Keep Modal Flow (**Click → Create New Lead Form)

2. **PROCESS LOAN (LOAN FACILITATION)**  
     
   Logic  
     
   ‘Payment\_Method \= Finance/Loan  
   AND  
   documents\_uploaded \= true  
   AND  
   facilitation\_fee\_status \!= PAID’  
     
   Probable screen:

Open Loan Facilitation Queue screen

1. Table View:

Columns:

* Customer Name  
* Mobile  
* Document Status  
* Company Validation Status  
* Facilitation Fee Status  
* Action  
3. Filters:  
   * Document Uploaded  
   * Under Validation  
   * Validation Passed  
   * Fee Pending  
4. Click "Process"

   Open detailed pseudo screen:

* Uploaded Documents viewer  
* Validation notes  
* Fee amount payable  
* Pay Facilitation Fee button  
5. On Fee Payment:  
   * Update status → FEE\_PAID  
   * Move file to Loan Management module

   

3. **Add Assets**

   ### **(**Click → Pseudo Screen)

4. **VIEW (Recent Leads)**  
     
* Displays modal with customer information, lead status, timeline, associated loans, edit options, and action buttons  
* Display time since last contact with alert if \>7 days  
* View Lead **(**Click → Lead Page)  
5. **START CAMPAIGN**

**(**Click → Pseudo Screen)

Probable Logic: Opens campaign wizard with audience selection, message composition, channel selection, and confirmation

* Pre-built segments: All Customers, Hot Leads, Pending Loans, Overdue Payments, Inactive Customers  
* Custom segment builder with AND/OR logic  
* Filter criteria: Lead status, Loan status, Purchase history, Last contact date, Location, Product interest  
* Show estimated audience size as filters are applied  
* Save custom segments for future use


### **Navigation Menu Functions**

1. **LEAD MANAGEMENT**

**(**Click → All Lead list with filters(Pseudo screen))  
table view, sorting, bulk actions, Create New Lead button

2. **Loan MANAGEMENT**

**(**Click → All Loan file list with payment processed filters, post disbursal payment and actionable(Pseudo screen))

3. **Deploy Asset MANAGEMENT**  
   **(**Click →Deployed Asset table, filters by type payment type, product type and status, QR code generation, deployment history, maintenance tracking, battery health tracking, telemetry support (Pseudo screen))  
4. **Service  MANAGEMENT**

   ### **(**Click → Pseudo Screen)

5. **ORDERS FROM OEM**

   ### **(**Click → Pseudo Screen)

6. **INVENTORY**

   ### **(**Click → Pseudo Screen)

   

   

![][image1]

**Create New Lead\_Button Schema**	

## Button Functions & User Interactions

## **Screen Overview**

This is the first step in a 5-step workflow for creating a new lead in the iTarang CRM system. The screen collects personal information, product details, vehicle details, and lead classification data.

**Workflow Position: Step 1 of 5**  
Reference ID Format: \#IT-2026-0000001 (Auto-generated)

Generate reference: \#IT-\[YEAR\]-\[SEQUENCE\]

### **Top Menu Action Buttons**

Workflow Type: Multi-step transactional form  
State: `LEAD_DRAFT` until final submission

1. **HEADER BUTTONS & ELEMENTS**

**Frontend**:   
Workflow Progress Bar  
**Type**: Display-only component  
**Function**

* Shows: `Step 1 of 5`  
* Highlights current step  
* Non-clickable

  ### **Backend:**

* No API.  
* Progress state derived from route /leads/create?step=1

2. **Info (ℹ️) Button**  
   **Frontend:**  
* On click → Open help modal  
* Modal shows:  
  * Required fields explanation  
  * Loan compliance guidelines  
  * Example formats

**Backend:** Static content or fetched: GET /api/help/lead-step-1

3. **Auto-fill from ID \[[Document Link](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-document-forensics-document-extraction)\]**  
   **Frontend**  
* Click → Open ‘Auto fill customer details pop up’ modal  
* User click:  
  * Aadhaar Front: To upload image in png, jpeg and PDF   
  * Aadhaar Back: To upload image in png,jpeg and PDF  
  * Start scanning: CALL API initiate OCR API, Both the uploaded images run through OCR and extract Name, Husband/Father Name, Date of Birth, Current Address  
* Validation:  
  * Add File Size & Format Validation  
  * Max file size: 5MB per image  
  * Allowed formats: PNG, JPEG, PDF  
  * Image quality check (min 300 DPI recommended)  
  * Show upload progress bar  
  * OCR Error Handling  
* What if OCR fails to extract data?:   
  * Show error message: 'Could not read document. Please ensure image is clear'  
  * Allow manual entry fallback  
  * Retry option  
  * Support for poor quality scans

	**Backend:**

* POST /api/leads/autofillRequest: { idType: 'aadhaar|pan|customer|lead', idValue: 'string' }Response: { success: boolean, data: { fullName, fatherName, dob, address, phone, etc. }, message: string }

  ### **State Update**:

* Overwrites matching fields  
* Marks form as “Auto-filled”  
* Logs audit event  
  ![][image2]

**PERSONAL INFORMATION – FIELD WORKFLOW**

All fields update **local form state** until save.

1. ## **Full Name (Required)**

**Validation:**

* 2–100 chars  
* Letters \+ spaces \+ . \-  
* Auto-capitalize first letter of each word  
* Validation: At least 2 characters  
* Error message: 'Please enter a valid full name’, ‘No special characters except’

**Frontend:**

* Validate on blur  
* Red border if invalid

**Backend:**

* Revalidated during submission  
* Value syncs to form state

2. ## **Father/Husband Name (Required for loan eligibility)**

   * Same validation as Full Name.  
   * If the product selected later requires a loan: → This becomes mandatory.  
     

3. ## **Date of Birth (Required)**

**Frontend:**

* Calendar picker  
* Age \>= 18  
* Show calculated age

**Backend:**

* Store ISO format

4. **Phone Number (Critical Field)**

**Frontend:**

* Format: \+91 XXXXX XXXXX  
* Real-time validation  
* AJAX duplicate check: GET /api/leads/check-duplicate?phone=9876543210

**If duplicate:**

* Show warning  
* Provide "View Existing Lead" button

**Backend:**

* Store with \+91  
* Soft duplicate allowed (with warning log)

5. ## **Current Address (Optional)**

* Min 20 characters

6. **Permanent Address (Optional)**  
   * Min 20 characters  
   * ☑ Same as Current: if checked ‘Auto copy’

**Backend:**

* Store boolean `is_current_same`

**PRODUCT DETAILS – CONDITIONAL LOGIC**

1. **Product Category (Required)**

Fetch: GET /api/inventory/categories  
**Selection triggers:**

* Load Product Types  
* Determine if vehicle section visible

2. **Product Type (Required)**

Fetch: GET /api/inventory/products?category=3-Wheeler  
**Must store:**

* Product\_Type ids   
* Multiselect as per Product category  
* Add 'Add Another Product' button to create multiple entries  
* Consider: Primary product (required) \+ Secondary products (optional)  
* If not in stock → show: “Order from OEM” suggestion

3. **VEHICLE DETAILS (Conditional Block)**  
   * Visible only if:Product category \= 3W/2W/4W

4. **Vehicle Registration Number (Mandatory)**  
   * Auto uppercase’

5. **Vehicle Ownership**  
   * vehicle\_registration\_number IS NOT NULL  
   * if the user fills Vehicle Reg. Number   
     1. Show validation: 'You've entered vehicle details  
     2. Automatically make dependent fields required:   •   
        1. Vehicle Ownership (Required)  
        2. Owner Name (Required)  
        3. Owner Phone (Required)  
     3. Show asterisk (\*) dynamically on these fields.  
     4. Add section heading: 'Existing Vehicle Information' (for context)

**Dropdown:**

* Self  
* Financed  
* Company  
* Leased  
* Family  
  Conditional fields appear based on selection.

6. **Owner Name**   
   * Name format same as ‘Full Name’.  
   * vehicle\_registration\_number IS NOT NULL  
   * if user fills Vehicle Reg. Number:  
     1. Show validation: 'You've entered vehicle details'  
     2. Automatically make dependent fields required:  
        1. Vehicle Ownership (Required)  
        2. Owner Name (Required)  
        3. Owner Phone (Required)  
     3. Show asterisk (\*) dynamically on these fields  
     4. Add section heading: 'Existing Vehicle Information' (for context)  
7. **Owner Phone**  
   * The phone format is the same as ‘Phone Number’.  
   * vehicle\_registration\_number IS NOT NULL  
   * if the user fills Vehicle Reg. Number:  
   * Show validation:   
     1. 'You've entered vehicle details'  
     2. Automatically make dependent fields required:  
        1. Vehicle Ownership (Required)  
        2. Owner Name (Required)  
        3. Owner Phone (Required)  
   * Show asterisk (\*) dynamically on these fields  
   * Add section heading: 'Existing Vehicle Information' (for context)

**LEAD CLASSIFICATION**

**Hot / Warm / Cold (Required)**  
**Frontend:**

* Toggle group  
* Must select one

**Backend:**  
	Stores:

* interest\_level: hot | warm | cold  
* lead\_score: computed\_value

Suggested scoring:

* Hot → 90  
* Warm → 60  
* Cold → 30

**Triggers:**

* Hot leads: 'Create Lead' saves Step 1 and auto-navigates to Step 2  
* Warm/Cold: 'Create Lead' saves and exits workflow

**PAYMENT METHOD**

1. **Payment Method Dropdown (Required)**

**Options:**

* Cash  
* Other Finance (default)  
* Dealer Finance

**Frontend Logic**  
On change:

* If Cash:  
  * Next page: Inventory Selection and Pricing  
  * Skip intermediary steps  
* If Other Finance/Dealer Finance:  
  * Show full Loan Documents section  
* Required Docs \= 11

**Backend:**

* PATCH /api/kyc/:leadId/payment-method

**Store**:

* payment\_method \= 'Cash' | 'Other finance' | ‘Dealer finance”  
* loan\_required \= true/false

**Return**:

* Next Page Logic

**BOTTOM BUTTONS – CORE LOGIC**

1. **Create Lead**

Purpose: Immediate save & exit workflow

### **Frontend:**

* Validate all required fields  
* If errors → highlight  
* If valid → confirm modal:Create lead  
* On confirm:  
  * Disable button  
  * Show spinner  
  * Call API

**Backend:**

* POST /api/leads/create

**Actions:**

* Server-side validation  
* Generate reference:  
  \#IT-\[YEAR\]-\[SEQUENCE\]  
* Set:  
  status \= INCOMPLETE  
  workflow\_step \= 1  
* Save to leads table  
* Create activity log  
* Trigger notifications if HOT

**Response**  
{success: true,  
  	leadId,  
  	referenceId}

* After Success  
* Toast: Lead created  
* Redirect to:  
  /leads/:id

2. **Cancel**

### **Frontend:**

* ### If form untouched: → Go back

* ### If modified:→ Show confirmation modal

* ### On confirm:

* Clear local state  
* Delete draft if exists:  
  * DELETE /api/leads/draft/:sessionId  
  * Redirect to dashboard

**STATE MANAGEMENT LOGIC**  
**During Step 1:**

* form\_state \= LOCAL  
* lead\_state \= DRAFT (optional)

**After Create Lead:**

* lead\_status \= INCOMPLETE  
* workflow\_step \= 1

| Button | Frontend Action | Backend Action | State Change |
| :---- | :---- | :---- | :---- |
| info | Open modal | None | None |
| Auto-fill | Call autofill API | Return data | Populate form |
| Create Lead | Validate → POST | Insert Lead | incomplete |
| Cancel | Confirm → Navigate | Delete draft (optional) | Discard |

### **Error Handling**

**For every API call and user action, specify:**

* Network errors: 'Connection lost. Please try again'  
  * Validation errors: Field-specific error messages  
  * Server errors (500): 'Something went wrong. Contact support'  
  * Permission errors (403): 'You don't have permission'  
  * Timeout errors: Retry mechanism with exponential backoff

**![][image3]**

	

**Customer KYC – Step 2 of 5 (Hot Lead Only)\_Button Schema**	

**SCREEN ACCESS LOGIC**

**Access Condition**

* User can access Step 2 only if:  
    
  lead\_created \= true  
  AND interest\_level \= 'hot'  
  AND Payment\_Method \<\> ‘Cash’


**Backend Gatekeeper**

* GET /api/kyc/:leadId/access-check  
* If not allowed → redirect to the ‘Create Lead Page’

**CUSTOMER CONSENT**

**DIGITAL CONSENT WORKFLOW (AADHAAR ESIGN)**

**Send SMS/WhatsApp Consent**  
**Frontend:**  
Click button: `Send SMS/WhatsApp Consent`  
Disable `Generate Consent PDF` button (mutually exclusive)  
Show phone number confirmation modal

* On confirm:  
  * Disable button, show spinner  
  * Call API  
* On success:  
  * Show toast: 'Consent form sent to customer'  
  * Update Consent Status: 'Link\_sent (SMS/WhatsApp delivered)'


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
\- consent\_status \= 'link\_sent'  
\- consent\_link\_sent\_at \= CURRENT\_TIMESTAMP  
\- consent\_link\_expires\_at \= CURRENT\_TIMESTAMP \+ INTERVAL 24 HOUR  
\- consent\_link\_url \= generated\_url  
\- consent\_delivery\_channel \= 'whatsapp' | 'sms'  
\`\`\`

\*\*SMS/WhatsApp Template:\*\*  
\`\`\`  
Hi {CustomerName},

iTarang requires your consent to process your loan application.

Click here to review and sign digitally:  
{ConsentLink}

This link expires in 24 hours.  
Uses Aadhaar-based eSign (100% secure)

Questions? Call 1800-XXX-XXXX  
\- Team iTarang

**Link Expiry Handler:**  
Cron job runs every hour  
If `consent_link_expires_at < NOW` AND `consent_status = 'link_sent'`:

* Set `consent_status = 'expired'`  
* Send notification to dealer: "Consent link expired for Lead \#{leadId}"  
* Show "Resend Consent" button in UI

**Customer Completes Aadhaar eSign**

**Customer-Side Flow (External Page)**

* Customer clicks consent link  
* System records: `consent_status = 'link_opened'`  
* Customer reviews consent text [Consent format](https://www.dpdpa.com/templates/consentformfordataprocessingtemplate.html)  
* Clicks "Sign with Aadhaar"  
* eSign provider (DigiLocker/NSDL/eMudhra) opens Aadhaar OTP screen  
* System records: `consent_status = 'esign_in_progress'`  
* Customer enters Aadhaar OTP  
* eSign provider validates OTP with UIDAI  
* eSign provider generates digitally signed PDF with:  
  * Digital signature certificate  
  * Timestamp  
  * Aadhaar number (masked)  
  * eSign transaction ID

**eSign Provider Callback (Webhook):**

POST /api/kyc/consent/esign/callback (called by eSign provider) 

Request Body (from provider): { transactionId:"ESIGN-20260726-ABC123", status: "success" | "failed", signedPdfUrl: "https://esign-provider.com/signed/ABC123.pdf", signedAt: "2026-07-26T10:45:30Z", signerAadhaar: "XXXX-XXXX-3456",certificateId: "CERT-2026-XYZ", errorCode: null, errorMessage: null } 

Backend Processing: 

1\. Validate webhook signature (security check) 

2\. Download signed PDF from provider URL 

3\. Store in iTarang permanent storage: \-S3/Azure: /kyc/{leadId}/consent/signed\_esign\_{timestamp}.pdf 

4\. Extract and store metadata: \- esign\_transaction\_id \-esign\_certificate\_id \- signed\_pdf\_url (iTarang storage) \- signed\_at \- signer\_aadhaar\_masked \- sign\_method \='aadhaar\_esign' 

5\. Update database: \- consent\_status \= 'admin\_review\_pending' 🔶 \- esign\_completed\_at \=CURRENT\_TIMESTAMP 

6\. Create admin task: \- task\_type \= 'consent\_review' \- task\_title \= "Review Digital Consent \- Lead \#{leadId}" \- assigned\_to \= 'consent\_review\_queue' \- priority \= 'high' 

7\. Send notifications: \- Email to admin@itarang.com: "New consent pending review" \- Dashboard alert for Admin users \- SMS to dealer: "Customer signed consent, under review" Response to Provider: { success: true, received: true }

**Failure Handling:**

If eSign status \= "failed"  
consent\_status \= 'esign\_failed' 

* Store failure reason:   
  * esign\_error\_code   
  * esign\_error\_message (e.g., "Invalid OTP", "Aadhaar suspended")  
* Send SMS to customer: "Consent signing failed. Reason: {error}. Click to retry: {link}"  
  * Allow 3 retry attempts  
  * After 3 failures:  
    *  consent\_status \= 'esign\_blocked'  
    * Notify dealer: "Customer eSign blocked, switch to manual consent”

**Admin Reviews Digital Consent\*\***   
\*\*Admin Console \- Consent Review Queue:\*\*  
\*\*Navigation:\*\* \`\`\` Admin Dashboard → Consent ReviewQueue \`\`\`   
\*\*Queue View (Table):\*\* 

| Lead ID | Customer | Signed Via | Signed At | Status | Action |
| :---- | :---- | :---- | :---- | :---- | :---- |
| IT\-2026\-123  | Vijay Sharma | adhaar | 26\-Jul 10:45 | Admin Review Pend. | Review |
| IT\-2026\-124  | Rakesh Kumar | Manual | 26\-Jul 09:30 | Admin Review Pend. | Review |

Filters:

* Status: All / Pending / Verified / Rejected  
* Signed Method: All / Aadhaar eSign / Manual  
* Date Range  
* Dealer 


\*\*Review Screen (Click "Review" button):\*\*   
\*\*Panel \- Signed PDF Viewer:\*\*

| 📄 Signed Consent PDF |
| :---- |
| \[PDF Preview with zoom controls\] Digital Signature Verified Certificate ID: CERT\-2026\-XYZ Signed: 26\-Jul\-2026 10:45:30 AM Signer Aadhaar: XXXX\-XXXX\-3456 \[Download PDF\] \[Print\] \[Admin Notes \- Optional\] \[❌ Reject\]  \[✅ Approve & Verify\] |

**Backend \- Approve Action:**

POST /api/kyc/:leadId/consent/admin/verify   
Request Body: { leadId: "IT-2026-0000123", decision: "approved",reviewerNotes: "All details verified, signature valid", reviewerId: "ADMIN-001" }  
Database Updates:

* consent\_status \='admin\_verified'  
* consent\_verified\_by \= 'ADMIN-001'  
* consent\_verified\_at \= CURRENT\_TIMESTAMP  
* consent\_verification\_notes \= reviewer\_notes  
* consent\_final \= true 

Audit Log: { action: "consent\_verified", entity:"Lead", entity\_id: "IT-2026-0000123", performed\_by: "ADMIN-001", timestamp: "2026-07-26T11:00:00Z", details: {previous\_status: "admin\_review\_pending", new\_status: "admin\_verified" } } 

Notifications:

* Email to dealer: "Consent verified for Lead \#{leadId}, ready for next step"  
* SMS to customer: "Your consent has been verified. Next: Product selection"  
* Update lead workflow\_step gating

**Backend \- Reject Action:**

POST /api/kyc/:leadId/consent/admin/reject

Request Body:  
{  
  leadId: "IT-2026-0000123",  
  decision: "rejected",  
  rejectionReason: "mandatory" dropdown:

* "Signature mismatch"  
* "Name mismatch with Aadhaar"  
* "Incomplete consent text"  
* "Expired certificate"  
* "Fraudulent document suspected"  
* "Other (specify in notes)",

  reviewerNotes: "Customer name in PDF does not match lead record",  
  reviewerId: "ADMIN-001"  
}

Database Updates:

* consent\_status \= 'admin\_rejected'   
* consent\_rejected\_by \= 'ADMIN-001'  
* consent\_rejected\_at \= CURRENT\_TIMESTAMP  
* consent\_rejection\_reason \= rejection\_reason  
* consent\_rejection\_notes \= reviewer\_notes

Trigger Re\-Consent Flow:

* Send email to dealer: "Consent rejected for Lead \#{leadId}. Reason: {reason}"  
* SMS to customer: "Your consent could not be verified. Please re-sign: {new\_link}"  
* Generate new consent link with extended expiry (48 hours)  
* Reset consent\_status \= 'link\_sent'  
* Increment consent\_attempt\_count  
* If consent\_attempt\_count \> 3:  
  * Escalate to senior admin for manual handling

**MANUAL CONSENT WORKFLOW (OFFLINE SIGNED PDF)**

This is the fallback when digital consent fails or is unavailable.  
Generate Consent PDF (Preview Only)

**Frontend:**

* Click button: `Generate Consent PDF`  
* Disable `Send SMS/WhatsApp Consent` button (mutually exclusive)  
* Show loading spinner  
* Call API

**Backend:**

POST /api/kyc/:leadId/consent/manual/generate\-pdf   
Processing: 

* Fetch lead data:  
* Customer name, father name, DOB,address  
* Product details  
* Generate PDF using template engine (pdfkit/Puppeteer):  
  * Header: iTarang logo,"Customer Consent Form"  
  * Body: [CUSTOMER LOAN CONSENT FORM](https://www.dpdpa.com/templates/consentformfordataprocessingtemplate.html) (Link)  
  * Footer: "This is a digitally generated document"  
* Store PDF temporarily:  
  * /tmp/consent\_preview\_{leadId}\_{timestamp}.pdf   
  * Auto\-delete after 24 hour  
*  Set consent\_status \= 'manual\_pdf\_generated'


Response: { success: true, pdfUrl: "https://itarang.com/tmp/consent\_preview\_123.pdf", expiresIn: 24\*3600, // 24 hour  
downloadLink: "Download opens automatically" }

\*\*Frontend After Success:\*\*

* Download PDF automatically to the user's device  
* Show toast: \`Consent PDF downloaded.Please print, sign, and upload scanned copy.\`  
* Enable \`Upload Signed Consent PDF\` button

Show instructions:

Next Steps: 

* Print the downloaded PDF  
* Customer must sign in designated box  
* Customer thumb impression required  
* Witness signature required  
* Scan or photo (clear, legible)  
* Upload

**Upload Signed Consent PDF**  
**Frontend:**

* Click button: `Upload Signed Consent PDF`  
* Enabled only after `Generate Consent PDF` is clicked  
* Open file picker  
* Validation:  
  * Format: PDF only  
  * Max size: 10MB  
  * Min resolution: 300 DPI (if image-based PDF)  
* Show upload progress bar  
* On success:  
  * Show PDF thumbnail preview  
  * Display upload timestamp  
  * Update status indicator

**Backend:**  
POST /api/kyc/:leadId/consent/manual/upload   
Request:   
FormData  
{ file: File (PDF), uploadedBy: "dealer\_user\_id" }  
Processing:

* Validate file:  
  * Check magic bytes (PDF signature)  
  * Virus scan (ClamAV or similar)  
  * Extract PDFmetadata  
* OCR scan (optional):  
  * Detect signature presence  
  * Verify checkboxes marked  
  * Flag for quality review  
* Store permanently: \- S3/Azure: /kyc/{leadId}/consent/manual\_signed\_{timestamp}.pdf  
* Update database:  
  * consent\_status \= 'manual\_review\_pending' 🔶  
  * pdf\_consent\_uploaded\_at \= CURRENT\_TIMESTAMP  
  * pdf\_consent\_uploaded\_by \= Sales Manager\_id \- signed\_pdf\_url \= storage\_url  
  * sign\_method \= 'manual'  
* Create admin task:  
  * Same as digital consent review queue  
* Send notifications:  
  * Admin: "Manual consent uploaded for Lead \#{leadId}"  
  * Dealer: "Consent uploaded, awaiting admin verification"

Response: { success: true, fileUrl:"https://cdn.itarang.com/kyc/123/manual\_signed.pdf", uploadedAt: "2026-07-26T12:00:00Z", status:"manual\_review\_pending" } \`\`\` \--- \#\#\#\#\# 

\*\*Admin Reviews Manual Consent\*\*   
\*\*Same Review Queue as Digital Consent\*\*  
\*\*Additional Manual Checks:\*\*

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

* consent\_status \= 'manual\_verified'   
* (same fields as digital approval)

**Rejection:**  
POST /api/kyc/:leadId/consent/manual/admin/reject   
Rejection Reasons (Manual Specific):

* "Signature missing" \-"Thumb impression missing"  
* "Witness signature missing"  
* "PDF not legible"  
* "Date missing or invalid"  
* "Suspected forgery" 

Updates:

* consent\_status \= 'manual\_rejected'  
* Dealer notified to re-upload

### **Consent Status Display**

**Overview:** iTarang requires explicit customer consent for KYC data processing, credit checks, and loan facilitation. Consent can be obtained via:

1. **Digital Consent** (Aadhaar eSign) \- Preferred  
2. **Manual Consent** (Signed PDF upload) \- Fallback

**Critical Compliance Rule:**

* All consents (digital or manual) MUST be reviewed and approved by iTarang Admin before lead can proceed to next step  
* This ensures regulatory compliance and fraud prevention  
  ---

#### **CONSENT STATUS STATE MACHINE**

Replace the simple status field with this comprehensive state machine:

* **Digital consent Path**  
  * Awaiting\_signature (default)  
  * link\_sent (SMS/WhatsApp delivered)  
  * Link\_opened (customer clicked link)  
  * E-sign\_in\_progress (OTP stage active)  
  * E-sign\_completed (Aadhaar OTP verified)  
  * Admin\_review\_pending  (awaiting approval)  
  * Admin\_verified (FINAL \- can proceed)  
  * Admin\_rejected (must re-consent)  
  * Expired (link timeout \- 24hrs)   
* **Manual consent Path**  
  * Consent\_generated (preview downloaded)  
  * Consent\_uploaded (scanned copy received)  
  * Admin\_review\_pending  
  * Admin\_verified (FINAL \- can proceed)  
  * Admin\_rejected  (reupload required) 

**Consent Gating Rule** 

Save & Next button enabled ONLY IF: consent\_status IN ('admin\_verified', 'manual\_verified')

**DOCUMENT UPLOAD CARDS**

* (Only visible if payment\_method \<\> ‘Cash’)  
* Sales Manager

## 

## **WORKFLOW: Two-Stage Process**

## **Stage 1 \- Dealer Upload (Dealer-facing)**

* ## Dealer uploads required documents

* ## System stores files

* ## No API verification at this stage

* ## Status: `uploaded` → `pending_admin_review`

## **Stage 2 \- Admin Verification (iTarang internal)**

* ## Admin reviews uploaded documents

* ## System runs OCR \+ API verification

* ## Admin approves/rejects with reasons

* ## Status: `admin_review_pending` → `verified` | `rejected`

## Critical Rule: Dealer cannot proceed to Step 3 until Admin marks verification as complete.

## **STAGE 1: DEALER DOCUMENT UPLOAD (Dealer-Facing)**

This section covers what the **dealer sees and does**

**Logic:**  
**If payment\_method \=== 'Other finance' or ‘Dealer finance’: Required documents \= 11 (full list below)**

## **Document Upload Cards (Simple Upload Only)**

## Available Document Types:

Always Required:

* Aadhaar Front  
* Aadhaar Back  
* PAN Card  
* Passport Size Photo   
* Address Proof (Electricity Bill / Rent Agreement)  
* Bank Statement (last 3 months)  
* 4 Undated Cheques  
* 🔶 RC Copy (conditional: only if Asset Category \= 2W/3W/4W)

Common Upload Flow (All Documents)  
**Frontend (Dealer View):**

| 📄 Aadhaar Front  \[📤\] |
| :---- |
| **Status: Not UploadedMax size: 5MB  Format: PNG, JPEG, PDF** |

Upload Steps:

* Click card → Open file picker  
* Select file  
* \*\*Frontend validations:\*\* \- File size \< 5MB  
  * File type: PNG, JPEG, PDF  
  * Image resolution \> 300 DPI (recommended)  
* Show upload progress bar  
* On success: \- Show green checkmark  
  * Display thumbnail preview  
  * Show uploaded timestamp  
  * Update document counter  
* Status changes to: Uploaded \- Pending Review

Upload Card After Success:

| 📄 Aadhaar Front  \[✅\] |
| :---- |
| **✅ Uploaded \- Pending ReviewUploaded: 26\-Jul 10:45 AM \[View\] \[Replace\]** |

Actions Available:

* **View**: Opens document in lightbox/modal  
* **Replace**: Upload new version (replaces old file)

Backend API \- Upload Endpoint  
POST /api/kyc/:leadId/upload\-document   
Request: FormData { leadId: "IT-2026-0000123", documentType:"aadhaar\_front" | "aadhaar\_back" | "pan\_card" | "passport\_photo" | "address\_proof" | "bank\_statement" | "cheque\_1" |"cheque\_2" | "cheque\_3" | "cheque\_4" | "rc\_copy", file: File, uploadedBy: "dealer\_user\_id" }   
Processing:

* Validate file:  
  * Check file size \< 5MB  
  * Verify file type (magic bytes check)  
  * Virus scan (optional but recommended)   
* Generateunique filename:  
  * {leadId}\_{documentType}\_{timestamp}.{ext}  
* Upload to cloud storage:  
  * S3/Azure:/kyc/{leadId}/{documentType}/  
*  Store metadata in database:  
  * File\_url  
  * File\_size  
  * File\_type  
  * Uploaded\_at  
  * Uploaded\_by  
  * Doc\_status \= 'uploaded'  
  * verification\_status \= 'pending' (internal field, not shown to dealer)  
* Do NOTrun OCR or API verification here

Response: { success: true, documentId: "DOC-123456", fileUrl:"https://cdn.itarang.com/kyc/123/aadhaar\_front.jpg", uploadedAt: "2026-07-26T10:45:00Z", status: "uploaded", message:"Document uploaded successfully. Awaiting admin verification." }

Database Schema Update:  
Kyc\_documents:

* id (PK)  
* lead\_id (FK)  
* document\_type (ENUM)  
* file\_url (VARCHAR)  
* file\_size (INT)  
* file\_type (VARCHAR)  
* uploaded\_at (TIMESTAMP)  
* uploaded\_by (FK: users)  
* doc\_status (ENUM: 'not\_uploaded', 'uploaded','verified', 'rejected', 'reupload\_requested')  
* verification\_status (ENUM: 'pending', 'in\_progress', 'success', 'failed') \-- Admin-only  
* verified\_at (TIMESTAMP)  
* verified\_by (FK: admin\_users)  
* rejection\_reason (TEXT)  
* extracted\_data (JSON) \-- OCR results stored here  
* api\_verification\_results (JSON) \-- API responses stored here

Document Status Counter (Dealer View)  
​​Display Component (Top of Document Section)

| 📊 Document Upload Progress  |
| :---- |
| ✅ Uploaded: 9/11 ⏳ Pending Upload: 2 📝 Missing: PAN Card, Passport Photo Auto-updates as user uploads documents |

Backend API:  
GET /api/kyc/:leadId/document\-status   
Response: { totalRequired: 11, uploaded: 9, pending: 2, missingDocuments:\['pan\_card', 'passport\_photo'\], allUploaded: false, adminVerificationStatus: 'pending' | 'in\_progress' | 'completed' | 'failed',canProceedToNextStep: false // Controlled by admin verification, not upload count }

Dealer-Side Status States (Simplified)  
Dealer sees only these statuses:

| Status | Display | Meaning |
| :---- | :---- | :---- |
| not\_uploaded | Not Uploaded  | Dealer hasn't uploaded yet |
| uploaded | Uploaded \- Pending Review | File stored, awaiting admin |
| reupload\_request | Reupload Required | Admin rejected, reason shown |
| verified | Verified | Admin approved |

Important: Dealer does NOT see:

* \`in\_progress\` (that's admin-side only)  
* \`failed\` (converted to \`reupload\_requested\` for dealer)  
* API error codes (those are internal)

Reupload APIs:  
POST /api/kyc/:leadId/reupload  
document Same as upload, but:

* Replaces previous file  
* Clears rejection reason  
* Resets verification\_status to 'pending'  
* Notifies admin queue: "Document reuploaded for Lead \#{leadId}"

STAGE 2: ADMIN VERIFICATION (iTarang Internal)  
This section covers what \*\*iTarang admin does\*\* (not visible to the dealer).

**VERIFICATION ACTION**

**Coupon Engine**

Purpose: Coupons act as verification tokens that control access to KYC verification services. Each coupon represents one verification credit.

Core Principles:

* 1 Coupon \= 1 KYC Verification  
* Coupons are dealer-specific (cannot be shared across dealers)   
* Coupons are single-use (cannot be reused)   
* Coupons can have different face values (₹0, ₹50, ₹100)   
* Settlement/billing is outside system scope (Phase 1\)

Lifecycle:  
Admin Creates Batch   
    ↓  
Distributed to Dealer (Manual \- Email/Excel)  
    ↓  
Dealer Enters Coupon Code  
    ↓  
System Validates & Reserves Coupon  
    ↓  
Coupon Locked to Lead  
    ↓  
Admin Kyc Runs Verification  
    ↓  
Coupon Consumed (Status: Used)

Key Rules:

* **One-to-One Binding**: One coupon can only be used for exactly one lead (prevents duplicate usage)  
* **Reservation Lock**: Once a coupon is entered and validated, it's reserved for that lead and cannot be used elsewhere  
* **Consumption Trigger**: Coupon is consumed only when admin successfully runs verification (not on upload)  
* **Failure Handling**: If verification fails or is cancelled before completion, coupon can be released back to available pool (admin decision)

COUPON LIFECYCLE STATES:                                     

| COUPON STATUS FLOW |
| :---- |
| \[Created\] (Admin generates batch)         ↓                                                   \[Available\] (Allocated to dealer, ready to use)         ↓   \[Reserved\] (Dealer entered code, locked to lead)         ↓                                                    \[Used\] (Verification completed) ✅ FINAL Alternative Paths:    \[Available\] → \[Expired\] (Past expiry date) ❌ FINAL \[Available\] → \[Revoked\] (Admin cancelled) ❌ FINAL \[Reserved\] → \[Released\] (Verification cancelled)                   → \[Available\] (Back to pool) |

Status Definitions:

| Status | Description | Can Be Used? | Actions Allowed |
| ----- | ----- | ----- | ----- |
| created | Just generated, not yet allocated | ❌ | Allocate to dealer |
| available | Allocated to dealer, ready to use | ✅ | Enter code, expire, revoke |
| reserved | Entered by dealer, locked to lead | ⏳ | Wait for verification, release |
| used | Verification completed | ❌ | View history only |
| expired | Past expiry date | ❌ | None (permanent) |
| revoked | Admin cancelled | ❌ | None (permanent) |
| released | Released from reservation | → available | Enter code again |

    
**ADMIN \- COUPON BATCH CREATION:**  
Navigation:  
Admin Dashboard → Coupon Management → Create Batch  
                                                            
Create Batch Form:

| Create Coupon Batch |
| :---- |
| Batch Name\* │ ABC Motors \- January 2026 │ Select Dealer\* │ \[Dropdown: ABC Motors \- Delhi\] ▼ │ Coupon Value\* ◉ ₹0 (Free) ○ ₹50 ○ ₹100 ○ Custom: \[\_\_\_\_\] Quantity\* │ 500 │ Coupon Prefix (Optional) │ABCDEL │ (💡 If blank, auto-generates from dealer code) Expiry Date (Optional) \[📅 31-Dec-2026\] (⚠️ Leave blank for no expiry) \[Cancel\] \[Generate Batch\] |

**Field Validation:**

| Field | Required | Format | Validation |
| ----- | ----- | ----- | ----- |
| Batch Name | ✅ | Text (3-100 chars) | Unique per dealer |
| Dealer | ✅ | Dropdown | Must be active dealer |
| Coupon Value | ✅ | Number (0-10000) | Positive integer or zero |
| Quantity | ✅ | Number (1-10000) | Min: 1, Max: 10,000 per batch |
| Prefix | ❌ | Alphanumeric (2-10 chars) | No special chars except hyphen |
| Expiry Date | ❌ | Date | Must be future date |

**Coupon Code Generation Logic**

**Format:**

{PREFIX}-{SEQUENCE}

Examples:  
ABCDEL-0001  
ABCDEL-0002  
ABCDEL-0003  
...  
ABCDEL-0500

**Prefix Rules:**

* If admin provides custom prefix → Use custom prefix  
* If blank → Auto-generate from dealer code  
    
  Dealer: "ABC Motors Delhi" (Code: DLR-001)  
  Auto-prefix: "DLR001"


**Sequence Rules:**

* Always 4 digits with leading zeros  
* Starts from 0001 for each batch  
* Increments sequentially  
* No gaps in sequence

**Uniqueness Guarantee:**

// Backend validation  
const existingCoupon \= await db.coupons.findOne({  
  coupon\_code: generatedCode  
});

if (existingCoupon) {  
  // Add random suffix  
  generatedCode \= \`${prefix}-${sequence}-${randomString(3)}\`;  
}

**Backend API \- Create Batch:**

POST /api/admin/coupons/create-batch

Request Body:  
{  
  batchName: "ABC Motors \- January 2026",  
  dealerId: "DLR-001",  
  couponValue: 50,  
  quantity: 500,  
  prefix: "ABCDEL", // Optional  
  expiryDate: "2026-12-31" // Optional  
}

Processing:  
1\. Validate inputs:  
   \- Dealer exists and is active  
   \- Quantity within limits (1\-10,000)  
   \- Batch name unique for this dealer  
   \- Expiry date is future (if provided)

2\. Generate prefix if not provided:  
   const prefix \= requestPrefix || generatePrefix(dealer.code);

3\. Generate coupon codes:  
   const codes \= \[\];  
   for (let i \= 1; i \<= quantity; i++) {  
     const sequence \= i.toString().padStart(4, '0');  
     codes.push(\`${prefix}\-${sequence}\`);  
   }

4\. Check for duplicate codes:  
   const existingCodes \= await db.coupons.findAll({  
     where: { coupon\_code: codes }  
   });  
     
   if (existingCodes.length \> 0) {  
     return { error: "Duplicate codes detected, regenerating..." };  
   }

5\. Insert batch record:  
   const batch \= await db.coupon\_batches.create({  
     batch\_name: batchName,  
     dealer\_id: dealerId,  
     coupon\_value: couponValue,  
     total\_quantity: quantity,  
     prefix: prefix,  
     expiry\_date: expiryDate,  
     created\_by: adminUserId,  
     created\_at: NOW,  
     status: 'active'  
   });

6\. Bulk insert coupons:  
   const coupons \= codes.map(code \=\> ({  
     coupon\_code: code,  
     batch\_id: batch.id,  
     dealer\_id: dealerId,  
     value: couponValue,  
     status: 'available',  
     expiry\_date: expiryDate,  
     created\_at: NOW  
   }));  
     
   await db.coupons.bulkCreate(coupons);

7\. Create audit log:  
   await db.audit\_logs.create({  
     action: 'coupon\_batch\_created',  
     entity: 'coupon\_batch',  
     entity\_id: batch.id,  
     performed\_by: adminUserId,  
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

**Database Schema \- Coupons**

Table: coupon\_batches

  id INT PRIMARY KEY AUTO\_INCREMENT,  
  batch\_id VARCHAR(50) UNIQUE NOT NULL, \-- BATCH-20260726-001  
  batch\_name VARCHAR(200) NOT NULL,  
  dealer\_id INT NOT NULL,  
  coupon\_value DECIMAL(10,2) NOT NULL, \-- 0.00, 50.00, 100.00  
  total\_quantity INT NOT NULL,  
  prefix VARCHAR(20) NOT NULL,  
  expiry\_date DATE NULL,  
  status ENUM('active', 'expired', 'revoked') DEFAULT 'active',  
  created\_by INT NOT NULL, \-- FK: admin\_users  
  created\_at TIMESTAMP DEFAULT CURRENT\_TIMESTAMP,  
    
  FOREIGN KEY (dealer\_id) REFERENCES dealers(id),  
  FOREIGN KEY (created\_by) REFERENCES admin\_users(id),  
  INDEX idx\_dealer\_batch (dealer\_id, created\_at),  
  INDEX idx\_batch\_status (status)

Table: `coupons`

id INT PRIMARY KEY AUTO\_INCREMENT,   
coupon\_code VARCHAR(50) UNIQUENOT NULL, \-- ABCDEL-0001   
batch\_id INT NOT NULL, \-- FK: coupon\_batches   
dealer\_id INT NOT NULL, \-- FK: dealers   
value DECIMAL(10,2) NOT NULL,   
status ENUM( 'created', 'available', 'reserved', 'used', 'expired', 'revoked','released' ) DEFAULT 'available',

 \-- Reservation tracking  
reserved\_at TIMESTAMP NULL,   
reserved\_by INT NULL, \-- FK: users (dealer user who entered code) reserved\_for\_lead\_id INT NULL, \-- FK: leads (which lead this is reserved for) 

\-- Usage tracking   
used\_at TIMESTAMP NULL,   
used\_by INT NULL, \-- FK: admin\_users (who ran verification)  
used\_for\_lead\_id INT NULL, \-- FK: leads (final lead verified)   
verification\_job\_id VARCHAR(50) NULL,

 \-- Lifecycle  
expiry\_date DATE NULL,   
revoked\_at TIMESTAMP NULL,   
revoked\_by INT NULL, \-- FK: admin\_users  
revoked\_reason TEXT NULL, 

created\_at TIMESTAMP DEFAULT CURRENT\_TIMESTAMP, 

FOREIGN KEY(batch\_id) REFERENCES coupon\_batches(id),   
FOREIGN KEY (dealer\_id) REFERENCES dealers(id),   
FOREIGN KEY(reserved\_for\_lead\_id) REFERENCES leads(id),   
FOREIGN KEY (used\_for\_lead\_id) REFERENCES leads(id), 

INDEXidx\_coupon\_code (coupon\_code),   
INDEX idx\_dealer\_status (dealer\_id, status),   
INDEX idx\_lead\_coupon (reserved\_for\_lead\_id),   
INDEX idx\_expiry (expiry\_date, status)

Table: `coupon_audit_log`

id INT PRIMARY KEY AUTO\_INCREMENT,   
coupon\_id INT NOT NULL,  
action ENUM( 'created', 'allocated', 'reserved', 'released', 'used', 'expired', 'revoked' ), old\_status VARCHAR(20),  
new\_status VARCHAR(20),  
lead\_id INT NULL,   
performed\_by INT, \-- User/Admin who triggered action   
ip\_address VARCHAR(45), timestamp TIMESTAMP DEFAULT CURRENT\_TIMESTAMP,   
notes TEXT NULL, 

FOREIGN KEY(coupon\_id) REFERENCES coupons(id), 

INDEX idx\_coupon\_audit (coupon\_id, timestamp) );

**Admin Coupon Batch Management:**  
Navigation:  
Admin Dashboard → Coupon Management → View Batches

Batch List View:

| Coupon Batches                                                                  \[\+ Create New Batch\] Filters: \[Dealer ▼\] \[Status ▼\] \[Date Range\]  |  |  |  |  |  |  |  |  |
| :---- | :---- | :---- | :---- | :---- | :---- | :---- | :---- | :---- |
| Batch ID | Dealer | Value | Total | Available | Used | Action | Created | Expiry |
| BATCH\-001 | ABC Motors | ₹50 | 500 | 182 | 318 | View | 15\-Jan\-2026 | 31-Dec-2026 |
| BATCH\-002 | XYZ Motors | ₹0 | 1000 | 856 | 144 | View | 20\-Jan\-2026 | 31-Dec-2026 |

Batch Detail View (click ‘View’):

| Batch Details: BATCH\-001 Batch Name: ABC Motors \- January 2026 │ │ Dealer: ABC Motors (Delhi) │ │ Coupon Value: ₹50 │ │ Created: 15-Jan-2026 by Admin User 1 │ │ Expiry: 31-Dec-2026 Statistics: Total Coupons: 500 │ │ Available: 182 (36.4%) │ │ Reserved: 15 (3%) │ │ Used: 318 (63.6%) │ │ Expired: 0(0%) │ │ Revoked: 0 (0%) \[📥 Download Available Coupons\]       \[📊 Usage Report\]          \[❌ Expire All\] Individual Coupons: \[Search by code\] \[Filter by status ▼\]  |  |  |  |  |
| :---- | :---- | :---- | :---- | :---- |
| Coupon Code | Status | Reserved For | Used For | Action |
| ABCDEL\-0001 | Used | IT-2026-0000115\-Jan 10:30 | IT-2026-00001 15\-Jan 14:45 | View  |
| ABCDEL\-0002 | Reserved | IT-2026-0000120\-Jan 12:30 |  | Release |
| ABCDEL\-0003 | Available |  |  | Revoke |

**Download Coupon Batches:**

**Button:** `📥 Download Available Coupons`

| Coupon Code | Value | Status | Expiry Date |
| ----- | ----- | ----- | ----- |
| ABCDEL-0001 | ₹50 | Available | 31-Dec-2026 |
| ABCDEL-0002 | ₹50 | Available | 31-Dec-2026 |
| ABCDEL-0003 | ₹50 | Available | 31-Dec-2026 |
| ... | ... | ... | ... |
| ABCDEL-0500 | ₹50 | Available | 31-Dec-2026 |

**Admin Actions on Individual Coupons**

##### **Release, Reserved Coupon**

Scenario: Dealer reserved coupon but verification not completed, need to free it up.

Button: Release (only visible for reserved status)

Backend:

**Processing:** 

* Validate:  
  * Coupon status \= 'reserved'   
  * Not yet used  
* Update:  
  * status \= 'released' (temporary state)  
  * Then auto\-transition to 'available'   
  * Clear reserved\_at, reserved\_by, reserved\_for\_lead\_id  
*  Audit log:  
  * action \= 'released'  
  * performed\_by \= admin\_user\_id  
  * notes \= "Manually released by admin"   
* 4\. Notify dealer:   
  * "Coupon {code} released, now available for reuse"  
  * Response: { success: true, couponCode: "ABCDEL-0002", newStatus: "available", message:"Coupon released and now available" }

**Revoke Coupon**

Scenario: Fraud detected, wrong batch, dealer suspended, etc.

Button: Revoke (only visible for reserved status)

Modal:

| Revoke Coupon: ABCDEL\-0003 Reason for Revocation \*  ○ Fraud suspected ○ Wrong batch allocation ○ Dealer suspended ○ Duplicate coupon ○ Other (specify below) Additional Notes: ┌────────────────────────┐  └────────────────────────┘  ⚠️ This action is permanent and cannot be undone.  Revoked coupons cannot be used. \[Cancel\]                                       \[Confirm Revoke\] |
| :---- |

**Backend:**

POST /api/admin/coupons/:couponId/revoke 

Request: { couponId: 123, reason: "Fraud suspected", notes: "Duplicate verification attempt detected", adminUserId: "ADMIN-001" } 

Processing:

* Validate:  
  * Coupon exists \- Not already revoked  
* Update:  
  * status \= 'revoked'  
  * revoked\_at \= NOW (Date and timestamp)  
  * revoked\_by \= admin\_user\_id  
  * revoked\_reason \= reason \+notes  
* If coupon was reserved:  
  * Unlink from lead (set reserved\_for\_lead\_id \= NULL)  
  * Notify dealer of revocation  
* Audit log:  
  * action \= 'revoked'   
  * details \= { reason, notes }   
    

Response: { success: true, message: "Coupon revoked successfully" }

**Expire Batch (Bulk Action)**

Scenario: Batch reached expiry date, or admin wants to force-expire old batch.

Button: Expire All (in Batch Detail view)

Modal:

| Expire Entire Batch? This will expire all coupons in batch: BATCH\-001 (ABC Motors \- January 2026) Affected Coupons: │ │  Available: 182 │ │  Reserved: 15 Used and already\-expired coupons unaffected. \[Cancel\]                       \[Expire All Available Coupons\] |
| :---- |

**Backend:**

POST /api/admin/coupons/batch/:batchId/expire\-all

Processing:

* Update all coupons in batch:

  UPDATE coupons 

  SETstatus \= 'expired' 

  WHERE batch\_id \= :batchId AND status IN ('available', 'reserved');

* Update batch: 

  UPDATEcoupon\_batches 

  SET status \= 'expired' 

  WHERE id \= :batchId;

* Notify dealers:

  If any reserved coupons expired,notify dealer 


  Response: { success: true, expiredCount: 197, message: "197 coupons expired successfully" }

**COUPON DISTRIBUTION (Manual \- Phase 1\)**

1\. Admin downloads coupon file  
2\. Admin sends file to dealer via:

* Email attachment  
* WhatsApp file

 3.Dealer receives and stores coupons locally 

Future Enhancement (Not in Scope Now):

* In-app coupon delivery  
* Dealer dashboard showing assigned coupons  
* Auto-notification on new batch allocation

**DEALER \- COUPON ENTRY & VALIDATION**

This is where the coupon enters the KYC workflow.   
When: After all documents uploaded, before admin verification.

**Coupon Code Field**  
**Frontend:**

* Text input field  
* Placeholder: 'Enter verification coupon code'  
* Max length: 20 characters  
* Alphanumeric only  
* Required

**Backend:**

* Validates coupon code against dealer specific assigned coupon codes API  
* If valid: strike off and enable verification  
* If invalid: Show error 'Invalid coupon code'  
* Store: coupon\_code, coupon\_applied\_at, coupon\_status change to used

### **Validate Button**

**Frontend:**

* Check if coupon code entered  
* If empty: Show error 'Please enter coupon code’  
* If filled:  
  * Disable button  
  * show spinner  
  * Call validation API  
* On success:  
  * Show toast: 'Coupon validated  
  * Enable 'Submit for Verification' button  
* On failure:  
  * Show error: 'Invalid coupon or expired'  
  * Keep 'Submit for Verification' disabled

**Backend:**  
POST /api/coupons/validate   
Request: { couponCode: "ABCDEL-0001", leadId: "IT-2026-0000123", dealerUserId: "USR-456" }   
Validation Checks:

* Coupon exists:  
    
  const coupon \= await db.coupons.findOne({ where: { coupon\_code:couponCode } }); if (\!coupon) { return { valid: false, error: "Coupon code not found" }  
    
* Coupon belongs to dealer:  
    
  const dealer \= await getCurrentDealer(dealerUserId); if (coupon.dealer\_id \!== dealer.id) { return { valid: false, error:"This coupon is not assigned to your dealership" }  
    
* Coupon status is available:   
    
  if (coupon.status \!== 'available') {return { valid: false, error: \`Coupon already ${coupon.status}\` };  
    
* Coupon not expired:   
    
  if (coupon.expiry\_date &&new Date(coupon.expiry\_date) \< new Date()) { // Auto-expire if not already await coupon.update({ status: 'expired' });return { valid: false, error: "Coupon expired" }  
    
* Lead doesn't already have a reserved coupon: const existingCoupon \=await db.coupons.findOne({ where: { reserved\_for\_lead\_id: leadId, status: 'reserved' } }); if (existingCoupon) { return {valid: false, error: \`Lead already has coupon ${existingCoupon.coupon\_code} reserved\` }; } If All Checks Pass \- ReserveCoupon: await coupon.update({ status: 'reserved', reserved\_at: NOW, reserved\_by: dealerUserId, reserved\_for\_lead\_id:leadId }); await db.coupon\_audit\_log.create({ coupon\_id: coupon.id, action: 'reserved', old\_status: 'available', new\_status:'reserved', lead\_id: leadId, performed\_by: dealerUserId, notes: \`Reserved for Lead \#${leadId}\` });   
    
  Response (Success): {valid: true, coupon: { code: "ABCDEL-0001", value: 50, status: "reserved", reservedAt: "2026-07-26T10:30:00Z",expiryDate: "2026-12-31" }, message: "Coupon validated and reserved successfully" } Response (Failure): { valid: false,error: "Coupon already used", message: "This coupon has already been used for another verification" }

### 

**Frontend Handling**

### **On Success:**

if (response.valid) { setCouponStatus('validated'); toast.success('Coupon validated successfully\!'); // Save to lead stateupdateLead({ coupon\_code: response.coupon.code, coupon\_value: response.coupon.value, coupon\_status: 'reserved' }); // Enable "Submit for Verification" button setCanSubmit(true); }

### **On Failure:**

if (\!response.valid) { setCouponStatus('invalid'); toast.error(response.message || response.error); // Highlight input with error setErrors({ coupon: response.error }); // Keep "Submit for Verification" disabled setCanSubmit(false); }

**Change Coupon (After Validation)**

Scenario: Dealer entered wrong code or wants to use different coupon.  
Button: `[Change Coupon]`  
Action:

1. Release current reserved coupon  
2. Show input field again  
3. Allow entering new code

**Backend**:  
POST /api/coupons/release\-and\-change Request: { leadId: "IT-2026-0000123", currentCouponCode: "ABCDEL-0001" }  
Processing:

* Find reserved coupon: const coupon \= await db.coupons.findOne({ where: { reserved\_for\_lead\_id: leadId,status: 'reserved' } });  
* Release it: await coupon.update({ status: 'available', reserved\_at: NULL, reserved\_by: NULL,reserved\_for\_lead\_id: NULL });  
* Audit log: await db.coupon\_audit\_log.create({ coupon\_id: coupon.id, action:'released', old\_status: 'reserved', new\_status: 'available', lead\_id: leadId, notes: "Dealer changed coupon" });  
* Response: {success: true, message: "Coupon released. You can now enter a new code." }

### **Submit for Verification Button**

**When:** Admin clicks "Run Verification" button (Section 2.3.3)

Critical Rule: Coupon is consumed ONLY when verification successfully starts, NOT when submitted by the dealer.

**Verification Start \- Consume Coupon**

| Stage | Documents Status | Submit for verification | Admin Can See? | Admin Can Run OCR/API? |
| :---- | :---- | :---- | :---- | :---- |
| Documents Uploaded | Uploaded, stored in cloud | Not entered yet | No | NO (cannot run verification) |
| Consent Verified | Uploaded | Not entered yet | YES (can view files) | No |
| Coupon Reserved | Uploaded | Reserved | Yes | No |
| Submitted to Admin | Uploaded | Reserved | Yes | YES (can run verification |
| Verification Running | Uploaded | Consumed | Yes | YES (In progress) |
| Verification Complete | Verified | Used | Yes | Results available |

**Verification Failure Handling:**  
**Scenario 1: Verification job fails to start (API error, system crash)**

// If verification job creation fails BEFORE coupon consumed:  
if (verificationJobFailed) {  
  // Coupon remains 'reserved' (not consumed)  
  // Dealer can try again or admin can retry  
    
  // DO NOT consume coupon  
}

**Scenario 2: Verification completes but all checks fail**

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
if (couponAction \=== "release") {  
  await reservedCoupon.update({  
    status: 'released', // Then auto-transition to 'available'  
    reserved\_for\_lead\_id: NULL,  
    // Clear reservation fields  
  });  
    
  message \= "Verification cancelled. Coupon released back to dealer.";  
} else {  
  await reservedCoupon.update({  
    status: 'used',  
    used\_at: NOW,  
    used\_by: adminUserId  
  });  
    
  message \= "Verification cancelled. Coupon marked as used.";  
}  
\`\`\`

**COUPON INVENTORY TRACKING**

Dealer Dashboard Widget

Display: Dealers see their coupon balance prominently.

| Your Verification Coupons  Available: 182                                 Reserved: 15 Used This Month: 48 Running low\! Request more coupons \[Contact Support\]    |
| :---- |

**Backend API:**

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
  batches: \[  
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
  \],  
  lowStockAlert: true, // Trigger if available \< 50  
  message: "You have 182 coupons remaining"  
}

**\---**

**Low Coupon Alert**

Trigger: When dealer's available coupons fall below threshold (e.g., 50 coupons).

**Alert Banner (Dealer Dashboard):**

| ⚠️ Low Coupon Balance You have only 32 coupons remaining.     \[Request More Coupons\] |
| :---- |

**When Coupons Finish (Zero Available)**

Scenario: Dealer tries to validate coupon but none available.

**Error Message:**

|   ❌ No Coupons Available You have no verification coupons remaining.                                                Please contact iTarang support to request new coupons:   📧 support@itarang.com  📞 1800-XXX-XXXX  \[Contact Support\] |
| :---- |

**Backend:**

// In coupon validation API  
const availableCoupons \= await db.coupons.count({  
  where: {  
    dealer\_id: dealerId,  
    status: 'available'  
  }  
});

if (availableCoupons \=== 0\) {  
  // Send alert to admin  
  await sendAdminNotification({  
    type: 'dealer\_out\_of\_coupons',  
    dealerId: dealerId,  
    dealerName: dealer.name,  
    message: \`Dealer ${dealer.name} has run out of coupons\`  
  });  
    
  return {  
    valid: false,  
    error: "NO\_COUPONS\_AVAILABLE",  
    message: "No verification coupons available. Please contact support.",  
    supportContact: {  
      email: "support@itarang.com",  
      phone: "1800-XXX-XXXX"  
    }  
  };  
}

**COUPON EXPIRY \- AUTO-CLEANUP** (Cron Job: Runs daily at midnight)

// Scheduled task: 0 0 \* \* \* (Daily at 00:00)

async function expireOldCoupons() {  
  const today \= new Date();  
    
  // Find all coupons past expiry date but not yet marked expired  
  const expiredCoupons \= await db.coupons.findAll({  
    where: {  
      expiry\_date: { $lt: today },  
      status: { $in: \['available', 'reserved'\] }  
    }  
  });  
    
  console.log(\`Found ${expiredCoupons.length} coupons to expire\`);  
    
  for (const coupon of expiredCoupons) {  
    // If coupon was reserved, release it first  
    if (coupon.status \=== 'reserved') {  
      // Notify dealer  
      await notifyDealerCouponExpired(coupon);  
    }  
      
    // Mark as expired  
    await coupon.update({ status: 'expired' });  
      
    // Audit log  
    await db.coupon\_audit\_log.create({  
      coupon\_id: coupon.id,  
      action: 'expired',  
      old\_status: coupon.status,  
      new\_status: 'expired',  
      performed\_by: null, // System action  
      notes: 'Auto-expired by system'  
    });  
  }  
    
  console.log(\`Expired ${expiredCoupons.length} coupons\`);  
}

### **GATING RULE UPDATE \- STEP 2 TO ADMIN VERIFICATION**

**Critical Change:** Admin cannot run verification without a valid coupon.

**Updated Admin Verification Button Logic:**

/// Frontend \- Step 2 (KYC Page)

const canSubmitForVerification \= () \=\> {  
  const checks \= {  
    paymentMethodSelected: lead.payment\_method \!== null,  
    allDocsUploaded: uploadedDocs.length \=== requiredDocs.length,  
    consentVerified: lead.consent\_status \=== 'admin\_verified' ||   
                     lead.consent\_status \=== 'manual\_verified',  
    couponValidated: lead.coupon\_status \=== 'reserved' &&   
                     lead.coupon\_code \!== null  
  };  
    
  return Object.values(checks).every(check \=\> check \=== true);  
};

// Button UI  
\<button  
  disabled={\!canSubmitForVerification()}  
  onClick={handleSubmitForVerification}  
  className={canSubmitForVerification() ? "btn-primary" : "btn-disabled"}  
\>  
  {canSubmitForVerification()   
    ? "Submit for Verification"   
    : getBlockingReason()}  
\</button\>

// Helper function  
function getBlockingReason() {  
  if (\!paymentMethodSelected) return "⏳ Select payment method";  
  if (\!allDocsUploaded) return "⏳ Upload all documents";  
  if (\!consentVerified) return "⏳ Awaiting consent verification";  
  if (\!couponValidated) return "⏳ Enter verification coupon";  
  return "⏳ Complete all steps above";  
}

// Tooltip  
{\!canSubmitForVerification() && (  
  \<Tooltip\>  
    \<strong\>Required to submit:\</strong\>  
    \<ul\>  
      \<li\>{paymentMethodSelected ? "✅" : "❌"} Payment method selected\</li\>  
      \<li\>{allDocsUploaded ? "✅" : "❌"} All documents uploaded ({uploadedDocs.length}/{requiredDocs.length})\</li\>  
      \<li\>{consentVerified ? "✅" : "❌"} Consent verified by admin\</li\>  
      \<li\>{couponValidated ? "✅" : "❌"} Verification coupon validated\</li\>  
    \</ul\>  
  \</Tooltip\>  
)}

**COUPON AUDIT & REPORTING**

Admin Reports:

Navigation: Admin → Reports → Coupon Usage Report

Report Filters:  
\- Date Range  
\- Dealer (single or all)  
\- Batch  
\- Coupon Status  
\- Coupon Value

\*\*Report Columns:\*\*  
| Date | Dealer | Batch | Coupon Code | Value | Lead ID | Status | Used By | Used At |  
|------|--------|-------|-------------|-------|---------|--------|---------|---------|  
| 26-Jul | ABC | BATCH-001 | ABCDEL-0001 | ₹50 | \#123 | Used | Admin 1 | 26-Jul 14:30 |  
| 26-Jul | ABC | BATCH-001 | ABCDEL-0002 | ₹50 | \#124 | Used | Admin 2 | 26-Jul 15:15 |

\*\*Export Options:\*\*  
\- Excel  
\- CSV  
\- PDF

Summary Stats:  
Total Coupons Issued: 5,000  
Total Used: 1,850 (37%)  
Total Available: 2,980 (59.6%)  
Total Expired: 120 (2.4%)  
Total Revoked: 50 (1%)

By Dealer:  
\- ABC Motors: 318 used / 500 total (63.6%)  
\- XYZ Autos: 144 used / 1000 total (14.4%)  
...

By Month:  
\- January 2026: 520 used  
\- February 2026: 680 used  
\- March 2026: 650 used

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
│   ├── Status \= available? ✅       
│   ├── Not expired? ✅              
│   └── Lead doesn't have coupon already? ✅           
│   ↓                    
│ ALL CHECKS PASS       
│   ↓                    
│ Coupon status: available → reserved                  
│ Reserved for Lead \#123             
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
│ Verification job starts (OCR \+ APIs)                 
│   ↓                    
│ Results stored        
│   ↓                    
│ Admin approves/rejects KYC       

![][image4]

iTARANG ADMIN KYC VERIFICATION WORKFLOW \- iTarang view  
Add as Section (After Coupon Management)

### **OVERVIEW \- ADMIN VERIFICATION PURPOSE**

**Objective:** After the dealer completes document upload, consent verification, and coupon validation, the lead is handed off to iTarang Admin for comprehensive KYC verification using third-party APIs and manual review.

**Core Principles:**

* Admin has full control over verification execution  
* APIs are triggered manually (not auto-run on upload)  
* Coupon consumed when first verification API executes  
* Admin can request additional documents or co-borrower KYC  
* Cost control: Limited API retry attempts  
* Final decision: Approve, Reject, or Request More Info

**Verification Scope:**

* **API Verifications:** Aadhaar (OTP), PAN, Bank Account, Face Match, CIBIL  
* **OCR Extraction:** Aadhaar, PAN, Bank Statement, Cheques, RC  
* **Manual Reviews:** Document authenticity, data consistency, cross-field matching  
* **Risk Assessment:** CIBIL score interpretation, fraud checks

### **CASE HANDOFF FROM DEALER TO iTARANG**

#### **Trigger Conditions**

The lead automatically moves to iTarang verification queue when ALL of the following are met:

**Checklist:**

* Customer consent completed and admin-verified  
* All required documents uploaded (11/11 for loan, 3/3 for cash)  
* Verification coupon validated and reserved  
* Dealer clicked "Submit for Verification"

**System Actions on Handoff, Backend API: POST /api/kyc/:leadId/submit\-for\-verification**

**Processing:** 

* Lock dealer editing:  
  * Documents become read-only for dealer  
  * Dealer cannot upload new versions  
  * Only admin can request changes  
* Update lead status:  
  * await lead update:  
    * kyc\_status: 'pending\_itarang\_verification'  
    * submitted\_for\_verification\_at: NOW  
    * submitted\_by: dealerUserId  
    * dealer\_edits\_locked: true  
* Add to admin queue:  
  * await db.admin\_verification\_queue.create:  
    * queue\_type: 'kyc\_verification'  
    * lead\_id: leadId  
    * priority: calculatePriority(lead)  
    * assigned\_to: null, // Auto-assigned or manual  
    * created\_at: NOW  
    * status: 'pending\_itarang\_verification’’  
* Store metadata:   
  * await db.kyc\_verification\_metadata.create:  
    * lead\_id: leadId  
    * submission\_timestamp: NOW  
    * coupon\_code: reservedCoupon.coupon\_code  
    * coupon\_status: 'reserved'  
    * documents\_count: uploadedDocs.length  
    * consent\_verified: true'  
* Notify admin:   
  * await sendAdminNotification:  
    * type: 'new\_kyc\_case'  
    * leadId: leadId  
    * customerName: lead.fullName  
    * dealerName: [lead.dealer.name](http://lead.dealer.name)  
    * priority: 'normal'  
* Notify dealer:   
  * await sendDealerNotification:  
    * type: 'kyc\_submitted'  
    * message: 'KYC submitted. Awaiting iTarang verification.'  
    * estimatedTime: '10-12 hours'  
  * Response:  
    * success: true  
    * leadStatus: 'pending\_itarang\_verification'  
    * queuePosition: 8  
    * estimatedReviewTime: '10-12 hours'  
    * message: 'Case submitted to iTarang verification team'

**iTARANG ADMIN VERIFICATION QUEUE:**

Navigation**: Admin Dashboard → KYC Verification Queue**

**Queue Dashboard:**

Queue View:

| KYC Verification Queue                                                                                \[🔄 Refresh\] |  |  |  |  |  |  |  |  |  |
| :---- | :---- | :---- | :---- | :---- | :---- | :---- | :---- | :---- | :---- |
| Filters: \[Status ▼\] \[Dealer ▼\] \[City ▼\] \[Priority ▼\] \[Date Range\] |  |  |  |  |  |  |  |  |  |
| Summary: Pending: 18 | In Progress: 5 | Requested correction: 2 | Rejected: 1 |Approved: 24 |  |  |  |  |  |  |  |  |  |
| Lead ID | Customer | Contact \# | Dealer | Submitted Date | Consent Status | Coupon Code | Status | SLA | Action |
| ABC-2026-0000001 | Vijay Sharma | \+91 9876543210 | ABC Motors Varanasi | 26-Jul 10:30 AM | Verified | ABCVAR-0001 | Pending | 2h 15m  | Review |
| XYZ-2026-0000002 | Rakesh Kumar | \+91 9988776655 | XYZ Auto Delhi | 25\-Jul 04:00 PM | Verified | XYZDEL-0001 | In Progress | 22h 30m | Review |
| BIH-2026-0000002 | Anjali Singh | \+91 9898989898 | Bihar Dealer Patna | 25-Jul 04:01 PM | Verified | BIHPAT-001 | Approved | 5h 20m | View |

Priority Indicators:

🔴 **High Priority**: \<\> Requested or Rejected or Approved \> 12 hours

🟡 **Medium**: \<\> Requested or Rejected or Approved \> 10 hours

🟢 **Normal**: \<\> Requested or Rejected or Approved \< 10 hours

ADMIN CASE REVIEW SCREEN: When admin clicks \*\*"Review"\*\* button, the full KYC case file opens.

Case Review Layout:

| \[← Back to Queue\]                                              Lead \#ABC-2026-0000001 \- Vijay Sharma |
| :---- |
|  Lead info                                                                                                  \[Document Viewer\] Name: Vijay Sharma | Date of Birth: XXXXXX | Phone: \+91 9876543210 | Gender: Male | Husband/Father Name: XXXX Permanent Address: Connaught Place, Delhi | Current Address: Connaught Place, Delhi Product: 3W IOT 51.2V-105AH | Vehicle: DL-3C-A-7889 | Vehicle Ownership: XXXX | Owner Name: XXXX | Owner Contact: XXXX  DOCUMENTS (Quick Access \- Click to View) \[Aadhaar F\] \[Aadhaar B\] \[PAN\] \[Photo\] \[Address\] \[RC\] \[Bank\] \[Cheques\]  VERIFICATION CARDS (Run APIs & See Results) \[Card 1: Aadhaar\] \[Card 2: PAN\] \[Card 3: Face\] \[Card 4: Bank\] \[Card 5: Address\] \[Card 6: RC\] \[Card 7: CIBIL\] \[Card 8: Phone\]... (scroll down for more cards as needed)  Consent Copy \[Download\] \[View\]              \[Approve\] \[Reject\]  COUPON: ABCDEL-0001 (Reserved)  FINAL DECISION ○ Approve ○ Reject \[Submit Decision\]  \[Save\] \[Back\]  |

Key Features:

* All elements visible without scrolling (except verification cards)  
* Document thumbnails clickable (opens lightbox viewer)  
* Coupon status visible at all times  
* Decision panel always visible at bottom

**VERIFICATION CARD SYSTEM:** Card-Based Architecture (NOT Checklist Table)

* **Cost Control**: Admin sees cost BEFORE clicking  
* **Flexibility**: Each verification is independent  
* **Scalability**: Easy to add new verification types  
* **Better UX**: Results shown within same card  
* **Manual Override**: Each card allows admin input if needed

**Standard Verification Card Structure**: 

Every card follows this template:

| \[VERIFICATION NAME\]                                                                   Status: XXXXXXXXXXX |
| :---- |
| 📥 INPUT DATA (Auto-filled from OCR/Lead)                                     **\[[Autofill OCR](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-document-forensics-document-extraction)\]** Field 1: \[Value\] \[✏️ Edit if needed\] Field 2: \[Value\] \[✏️ Edit if needed\] Field 3: \[Value\] \[✏️ Edit if needed\] AVAILABLE VERIFICATIONS **\[Run API\]** Filed Name Input Data Document Data (From API) Match Result 1 Field 1 Field 1 Matched 2 Field 2 Field 1 Not Matched 3 Field 3 Field 1 Not Matched 💬 ADMIN NOTES  \[Text area for remarks\]  ⚡ ACTIONS  \[✓ Accept\] \[✗ Reject\] \[⚠️ Request More Docs \] |

**VERIFICATION CARDS \- COMPLETE LIST (PHASE 1):**

* Aadhaar Verification  
* PAN Verification  
* Bank Account  
* CIBIL Score  
* RC Verification  
* Phone Intelligence

Card Status:

1. Pending  
2. Initiating  
3. Awaiting Consent (in case of Aadhaar)  
4. Consent Failed (in case of Aadhaar)  
5. Awaiting Response  
6. Response Received (200)  
7. Response Failed (400 or server/API error)

**DETAILED VERIFICATION CARDS:**

CARD 1: AADHAAR VERIFICATION ([Adhaar Check Documentation](https://docs.decentro.tech/reference/kyc_api-digilocker-get-e-aadhaar))

| CARD 1: [AADHAAR VERIFICATION](https://docs.decentro.tech/docs/kyc-and-onboarding-identities-digilocker-services)                                                       Status: ⏳ Pending |
| :---- |
| 📥 INPUT DATA                                                                                  **\[[Autofill OCR](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-document-forensics-document-extraction)\]** ├─ Aadhaar Number (From Aadhaar ID): XXXX-XXXX-3456             **\[✏️ Edit if OCR wrong\]** ├─ Name (From Lead): VIJAY SHARMA ├─ DOB (From Lead): 15-01-1985 ├─ Father/Hunband Name (Lead): XXXXX ├─ Address (From Lead): 123 Main St, Delhi-110001 ├─ Gender (From Lead): Male ├─ Mobile (From Lead): \+91 9876543210 └─ Email (From Lead): vijay.sharma@example.com (optional) VERIFICATION  [**\[Initate\]**](https://docs.decentro.tech/reference/kyc_api-digilocker-initiate-session)  |

**Manual Entry Policy:**

* Audit Log: Store **`data_source = "manual" | "ocr"`**

AFTER ADMIN SELECTS "USE DIGILOCKER METHOD"

| AADHAAR VERIFICATION (via Digilocker)                                       Status: 🔵 Initiating |
| :---- |
| STEP 1: SEND DIGILOCKER CONSENT LINK TO CUSTOMER  Customer Mobile: \+91 9876543210                  \[Send Digilocker Link to Customer via SMS\] Link Valid For: ○ 24 hours ○ 48 hours ○ 72 hours What happens next:  Customer receives SMS with secure Digilocker link Customer clicks link → Redirected to Digilocker login Customer logs in with Aadhaar/Mobile OTP Customer authorizes iTarang to fetch Aadhaar XML Document auto-fetched and displayed below |

BACKEND API CALL \- INITIATE DIGILOCKER FLOW

POST /api/admin/kyc/:leadId/aadhaar/digilocker/initiate

Request:  
{  
  leadId: "IT-2026-0000123",  
  customerName: "Vijay Sharma",  
  customerMobile: "+919876543210",  
  customerEmail: "vijay.sharma@example.com", // Optional  
  notificationChannel: "sms"  
  documentsRequested: \["aadhaar"\]  
  linkValidityHours: 24,  
  adminUserId: "ADMIN-001"  
}

Backend Processing:

1\. Generate unique transaction ID:  
   const txnId \= \`DIGI-${leadId}-${Date.now()}\`;  
     
2\. Call Decentro Digilocker SSO Init API:  
   const decentroResponse \= await axios.post(  
     'https://in.decentro.tech/kyc/digilocker/sso/init',  
     {  
       reference\_id: txnId,  
       redirect\_url: \`https://itarang.com/kyc/digilocker/callback/${txnId}\`,  
       purpose\_message: "Aadhaar verification for battery loan application",  
       requested\_documents: \["aadhaar"\],  
       consent\_text: "I authorize iTarang to fetch my Aadhaar from Digilocker",  
       expiry\_hours: 24  
     },  
     {  
       headers: {  
         'client\_id': process.env.DECENTRO\_CLIENT\_ID,  
         'client\_secret': process.env.DECENTRO\_CLIENT\_SECRET,  
         'module\_secret': process.env.DECENTRO\_MODULE\_SECRET,  
         'provider\_secret': process.env.DECENTRO\_PROVIDER\_SECRET  
       }  
     }  
   );

3\. Extract Digilocker consent URL:  
   const digilockerUrl \= decentroResponse.data.data.digilocker\_url;  
   const sessionId \= decentroResponse.data.data.session\_id;

4\. Generate short URL (optional, for SMS):  
   const shortUrl \= await generateShortUrl(digilockerUrl);

5\. Store transaction in database:  
   await db.digilocker\_transactions.create({  
     transaction\_id: txnId,  
     lead\_id: leadId,  
     session\_id: sessionId,  
     digilocker\_url: digilockerUrl,  
     short\_url: shortUrl,  
     requested\_documents: \["aadhaar"\],  
     status: 'link\_sent',  
     link\_sent\_at: NOW,  
     link\_expires\_at: NOW \+ 24 hours,  
     notification\_channel: 'sms',  
     customer\_mobile: customerMobile,  
     customer\_email: customerEmail  
   });

6\. Send SMS to customer:  
   await sendSMS({  
     to: customerMobile,  
     message: \`  
Hi ${customerName},

iTarang needs your Aadhaar for loan verification.

Please click the link below to share from Digilocker:  
${shortUrl}

This is a secure government platform. Your data is safe.  
Link expires in 24 hours.

\- iTarang Team  
     \`.trim()  
   });

7\. If email also requested, send email:  
   if (notificationChannel \=== 'email' || notificationChannel \=== 'both') {  
     await sendEmail({  
       to: customerEmail,  
       subject: 'Aadhaar Verification \- Action Required',  
       html: \`  
         \<h2\>Aadhaar Verification for Loan Application\</h2\>  
         \<p\>Dear ${customerName},\</p\>  
         \<p\>Please share your Aadhaar from Digilocker to complete KYC verification.\</p\>  
         \<p\>\<a href="${digilockerUrl}" style="background: \#007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block;"\>  
           Share Aadhaar from Digilocker  
         \</a\>\</p\>  
         \<p\>Link expires in 24 hours.\</p\>  
         \<p\>This is a secure government platform. Your data is protected.\</p\>  
       \`  
     });  
   }

8\. Update lead status:  
   await lead.update({  
     aadhaar\_digilocker\_status: 'link\_sent',  
     aadhaar\_digilocker\_link\_sent\_at: NOW  
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

#### **API 1: Digilocker SSO Init**

**Endpoint:** `POST /kyc/digilocker/sso/init`

**Request:**

{  
  "reference\_id": "DIGI-IT-2026-123-1722012345678",  
  "redirect\_url": "https://itarang.com/kyc/digilocker/callback/DIGI-IT-2026-123-1722012345678",  
  "purpose\_message": "Aadhaar verification for battery loan application",  
  "requested\_documents": \["aadhaar"\],  
  "consent\_text": "I authorize iTarang Technologies LLP to fetch my Aadhaar document from Digilocker for KYC verification purposes.",  
  "expiry\_hours": 24  
}

**Request:**

{ "status": "SUCCESS", "message": "Digilocker consent link generated successfully", "data": { "session\_id": "SESSION-ABC123XYZ", "digilocker\_url": "https://digilocker.gov.in/authorize?client\_id=XXX\&redirect\_uri=https://decentro.tech/callback\&state=SESSION-ABC123XYZ", "expires\_at": "2026-07-27T11:30:00Z", "requested\_documents": \["aadhaar"\] }, "decentroTxnId": "DCTR1234567890" }

**AFTER LINK SENT \- WAITING STATE**

| AADHAAR VERIFICATION (via Digilocker)                          Status: 🟡 Awaiting Consent |
| :---- |
| STEP 1 COMPLETED: Link Sent to Customer WAITING FOR CUSTOMER ACTION Transaction ID: DIGI-IT\-2026-123-1722012345678 Session ID: SESSION-ABC123XYZ  Link Sent To:  Mobile: \+91 98765XXXXX                      Delivered at 11:30 AM Link Status: ⏳ Not Opened Yet    Link Expires: 26-Jul-2026 11:30 PM (12 hours remaining) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ CUSTOMER PROGRESS TRACKER ○ Link Sent: Completed (11:30 AM) ○ Link Opened: Waiting ○ Digilocker Login:  Waiting ○ Consent Given: Waiting ○ Document Fetched: Waiting  🔄 Auto-refreshing every 10 seconds...  WHAT TO DO IF CUSTOMER HASN'T RESPONDED: If customer hasn't acted within 20 hours admin can: 1. \[Resend Link\] \- Send reminder SMS/Email 2. \[Call Customer\] \- Assist them over phone 3. \[Extend Link Validity\] \- Add 24 more hours ACTIONS  \[Resend Link\] \[Extend Validity\]  \[Cancel\] |

**Auto Refresh Logic:**

// Frontend polling (every 10 seconds) useEffect(() \=\> { const interval \= setInterval(async () \=\> { const status \= awaitcheckDigilockerStatus(transactionId); if (status.linkOpened) { setProgress('link\_opened'); } if(status.digilockerLoginComplete) { setProgress('digilocker\_login'); } if (status.consentGiven) {setProgress('consent\_given'); } if (status.documentFetched) { setProgress('document\_fetched'); clearInterval(interval); // Stop polling } }, 10000); return () \=\> clearInterval(interval); }, \[transactionId\]); // Backend status check API GET/api/admin/kyc/:leadId/aadhaar/digilocker/status/:transactionId Response: { transactionId: "DIGI-IT-2026-123-1722012345678", status: "awaiting\_customer", linkOpened: false, linkOpenedAt: null, digilockerLoginComplete: false,consentGiven: false, documentFetched: false, linkExpiresAt: "2026-07-26T23:30:00Z", timeRemaining: "12 hours 15 minutes" }

**AFTER CUSTOMER AUTHORIZES \- DOCUMENT FETCHED**

**Backend Callback Handler:**

**POST /api/kyc/digilocker/callback/:transactionId // This endpoint is called by Decentro after customer authorizes**

**Processing:** 

1\. Receive callback from Decentro: const callbackData \= req.body; // Callback data structure: { reference\_id:"DIGI-IT-2026-123-1722012345678", session\_id: "SESSION-ABC123XYZ", status: "success", documents: \[ { type:"aadhaar", format: "xml", data: "\<base64-encoded-xml\>", fetched\_at: "2026-07-26T11:45:00Z" } \], consent\_given\_at:"2026-07-26T11:45:00Z", decentroTxnId: "DCTR1234567890" } 

2\. Update transaction status: awaitdb.digilocker\_transactions.update({ status: 'document\_fetched', consent\_given\_at: callbackData.consent\_given\_at,document\_fetched\_at: NOW, decentro\_txn\_id: callbackData.decentroTxnId }, { where: { transaction\_id: transactionId }}); 

3\. Parse Aadhaar XML: const aadhaarXmlBase64 \= callbackData.documents\[0\].data; const aadhaarXmlDecoded \=Buffer.from(aadhaarXmlBase64, 'base64').toString('utf-8'); const aadhaarData \=parseAadhaarXML(aadhaarXmlDecoded); // Parsed data structure: { uid: "123456789012", // Full Aadhaar number name:"Vijay Sharma", gender: "M", dob: "15-01-1985", careof: "S/O Ramesh Sharma", house: "123", street: "Main Street",landmark: "Near Delhi Metro", locality: "Connaught Place", vtc: "New Delhi", subdist: "New Delhi", dist: "New Delhi",state: "Delhi", pincode: "110001", photo\_base64: "\<base64-image\>", mobile: "+919876543210" // If available } 

4\. Storeextracted data: await db.aadhaar\_verification\_digilocker.create({ lead\_id: leadId, transaction\_id: transactionId, // Aadhaar details aadhaar\_number: aadhaarData.uid, aadhaar\_number\_masked: maskAadhaar(aadhaarData.uid), full\_name:aadhaarData.name, gender: aadhaarData.gender, dob: aadhaarData.dob, care\_of: aadhaarData.careof, // Addressaddress\_line1: \`${aadhaarData.house}, ${aadhaarData.street}\`, address\_line2: \`${aadhaarData.landmark}, ${aadhaarData.locality}\`, city: aadhaarData.vtc, district: aadhaarData.dist, state: aadhaarData.state, pincode:aadhaarData.pincode, full\_address: buildFullAddress(aadhaarData), // Photo photo\_base64: aadhaarData.photo\_base64, // XML data aadhaar\_xml: aadhaarXmlDecoded, // Metadata fetched\_at: NOW, source: 'digilocker', verification\_status:'fetched' }); 

5\. Cross\-match with lead data: const lead \= await db.leads.findById(leadId); const nameMatch \=fuzzyMatch(aadhaarData.name, lead.fullName); const dobMatch \= (aadhaarData.dob \=== lead.dob); const phoneMatch \=aadhaarData.mobile ? (aadhaarData.mobile \=== lead.phone) : null; 

6\. Update verification status: const overallStatus \=(nameMatch.score \> 80 && dobMatch) ? 'success' : 'failed'; await db.aadhaar\_verification\_digilocker.update({verification\_status: overallStatus, name\_match\_score: nameMatch.score, dob\_match: dobMatch, phone\_match:phoneMatch, verified\_at: NOW }, { where: { transaction\_id: transactionId } }); 

7\. Notify admin (WebSocket or push notification): await sendAdminNotification({ type: 'digilocker\_document\_received', leadId: leadId, message: 'Aadhaar received from Digilocker', verificationStatus: overallStatus }); 8\. Store photo for face match: awaitdb.kyc\_documents.create({ lead\_id: leadId, document\_type: 'aadhaar\_photo\_digilocker', file\_data\_base64:aadhaarData.photo\_base64, source: 'digilocker', uploaded\_at: NOW });

**Response Status:**

200: Success

400: Invalid DCTL ID, Failure: Invalid Reference ID, Failure: Invalid Consent

**ADMIN VIEW \- AFTER DOCUMENT RECEIVED**

| AADHAAR VERIFICATION (via Digilocker)                     Status: Response Awaited |
| :---- |
| **STEP 2 COMPLETED: Document Received from Digilocker AADHAAR DETAILS (Extracted from Digital XML) Transaction ID: DIGI\-IT\-2026\-123\-1722012345678 Fetched At: 26\-Jul\-2026 11:45 AM  Source:DigiLocker ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━** Field Name Input Data Document Data (From API) Action Match Result **Name** Name (From Lead) "name" **[Run Match Engine](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-data-forensics-match-engine)/Manual Validation** ≥80%: Strong Match \<80%: Weak Match **Gender**  First letter: Gender (From Lead) "gender" **[Run Match Engine](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-data-forensics-match-engine)/Manual Validation** ≥80%: Strong Match \<80%: Weak Match **DOB** DOB (From Lead) "dob" [Run Match Engine](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-data-forensics-match-engine)/Manual Validation ≥80%: Strong Match \<80%: Weak Match **Father/Husband Name** Father/Hunband Name (Lead) S/O RAMESH SHARMA **[Run Match Engine](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-data-forensics-match-engine)/Manual Validation** ≥80%: Strong Match \<80%: Weak Match **Address** Address (From Lead) "proofOfAddress" **[Run Match Engine](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-data-forensics-match-engine)/Manual Validation** ≥80%: Strong Match \<80%: Weak Match **Mobile** Mobile (From Lead): "hashedMobileNumber" **[Run Match Engine](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-data-forensics-match-engine)/Manual Validation** ≥80%: Strong Match \<80%: Weak Match **PHOTOGRAPH**  \[Passport Size Photo\]           (from lead) \[View Full Size\] \[Aadhaar Photo\]           (from XML) \[View Full Size\] [Run Face Match](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-face-forensics-face-match-v3)/Manual Validation ≥90%: Strong Match; 75-89%: Moderate Match; \<75%: Mismatch  ** ADMIN NOTES Aadhaar verified via Digilocker. All details match. High confidence. Photo extracted and available for face match verification. ADMIN DECISION \[✓ Accept Verification\] \[✗ Reject Verification\] \[**⚠️ Request More Docs **\]** |

**CARD 2: PAN VERIFICATION: [DOCUMENT LINK](https://docs.decentro.tech/docs/kyc-and-onboarding-identities-verification-services-customer-verification)**

| PAN VERIFICATION                                                                       Status: Pending |
| :---- |
| **INPUT DATA                                                                                         \[[Autofill OCR](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-document-forensics-document-extraction)\] ├─** PAN Numbe**r (**From PAN): ABCDE1234F                           **\[✏️ Edit if OCR wrong\] ├─** PAN Status (Default): Active **├─** PAN Type (Default): Personal **├─** Name **(**From Lead**):** VIJAY SHARMA **├─** DOB **(**From Lead**):** 15-01-1985 ├─ Aadhaar Number (From Lead): XXXX-XXXX-3456             ├─ Address (From Lead): 123 Main St, Delhi-110001 ├─ Gender (From Lead): Male ├─ Mobile (From Lead): \+91 9876543210 └─ Email (From Lead): vijay.sharma@example.com (optional) **VERIFICATION OPTIONS \[Initiate PAN\]** Field Name Input Data Document Data (From API) Action Match Result **PAN Status** PAN Status (Default) **"idStatus"/"panStatus"  [Run Match Engine](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-data-forensics-match-engine)/Manual Validation**  ≥80%: Strong Match \<80%: Weak Match **PAN Type (Default)** PAN Type (Default) **"category"  [Run Match Engine](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-data-forensics-match-engine)/Manual Validation**  ≥80%: Strong Match \<80%: Weak Match **Name** Name **(**From Lead**) "name"  [Run Match Engine](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-data-forensics-match-engine)/Manual Validation**  ≥80%: Strong Match \<80%: Weak Match **Gender** First Letter: Gender (From Lead) **"gender"  [Run Match Engine](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-data-forensics-match-engine)/Manual Validation** ≥80%: Strong Match \<80%: Weak Match **DOB** DOB (From Lead) **"dateOfBirth"  [Run Match Engine](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-data-forensics-match-engine)/Manual Validation** ≥80%: Strong Match \<80%: Weak Match **Aadhaar Number** Aadhaar Number (From Lead) **"maskedAadhaar" [Run Match Engine](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-data-forensics-match-engine)/Manual Validation** ≥80%: Strong Match \<80%: Weak Match **Address** Address (From Lead) **"full" [Run Match Engine](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-data-forensics-match-engine)/Manual Validation** ≥80%: Strong Match \<80%: Weak Match **Mobile** Mobile (From Lead) **"mobile" [Run Match Engine](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-data-forensics-match-engine)/Manual Validation** ≥80%: Strong Match \<80%: Weak Match ADMIN NOTES  PAN verified successfully  |

| ADMIN DECISION \[✓ Accept\] \[✗ Reject\] \[⚠️ Request More Docs \] |
| :---- |

**Manual Entry Policy:**

* Audit Log: Store **`data_source = "manual" | "ocr"`**

**CARD 3: BANK ACCOUNT VERIFICATION [Document link](https://docs.decentro.tech/reference/validate-bank-account-v3)**

| BANK ACCOUNT VERIFICATION                                                     Status:  Pending |
| :---- |
| **INPUT DATA                                                                                        \[[Autofill OCR](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-document-forensics-document-extraction)\]** ├─ Account Holder Name: Vijay Sharma \[✏️ Edit\] ├─ Account Number: 1234567890123 \[✏️ Edit\] ├─ IFSC Code: HDFC0001234 \[✏️ Edit\] ├─ Bank Name: HDFC Bank \[✏️ Edit\] └─ Branch: Connaught Place, Delhi \[✏️ Edit\]  **VERIFICATION OPTIONS Bank Verification APIs Cost Action** Pennydrop ₹1.50 \+ Pennydrop Amount \[Run API\] Penniless ₹1.50 \[Run API\] Pennydrop (Name Match) ₹1.50 \+ Pennydrop Amount \[Run API\] **VERIFICATION RESULTS (After Penny Drop) Account Status:** Valid/Invalid/Inconclusive/NRE/Blocked/Blacklisted **Account Holder Name (Bank):** VIJAY SHARMA **Name Match:** 95% (if applicable)  **Bank Reference Number: 417110293521 validation\_message:** The account has been successfully verified.  **ADMIN NOTES**  Bank account verified, name matches   **ADMIN DECISION**  \[✓ Accept\]     \[✗ Reject\]     \[⚠️ Request More Docs **\]** |

**Business Rules:**

* Name match threshold: 100%  
* Cross-match with Aadhaar name   
* Retry limit: 3 attempts

**CARD 4: CIBIL CREDIT SCORE: [Document Link1](https://docs.decentro.tech/docs/bytes-credit-bureau) [Document Link2](https://docs.decentro.tech/reference/financial_api-customer-data-pull)**

| CIBIL CREDIT SCORE                                                                       Status:  Pending |
| :---- |
| **INPUT DATA (From Lead)**            ├─ Name: VIJAY SHARMA ├─ PAN: ABCDE1234F ├─ DOB: 15-01-1985 ├─ Mobile: \+91 9876543210 └─ Address: Delhi   **VERIFICATION OPTIONS Report Type Cost Action** Credit Score Only ₹4.00 \[Get Score\] Credit Report Summary ₹20.00 \[Get Report\]  **VERIFICATION RESULTS (Score Only) CIBIL SCORE: 780  Risk Category: LOW Credit Report ID: CIBIL-20260726-ABC123 Generated: 26-Jul-2026 11:30 AM Score Interpretation: 750+ \= Excellent (Low Risk) 700-749 \= Good (Low Risk) 650-699 \= Moderate (Medium Risk) \<650 \= Poor (High Risk) → Co-borrower needed SUMMARY DATA (if Full Report run) Active Loans: 2 Total Outstanding: ₹1,50,000 Credit Utilization: 35% Payment Defaults: 0  Recent Enquiries (30 days): 1 Oldest Account Age: 8 years Credit Mix: 70% Secured, 30% Unsecured  ADMIN NOTES**  Ok  **ADMIN DECISION**  \[✓ Accept\]     \[✗ Reject\]     \[⚠️ Need Co-Borrower KYC **\]** |

**CARD 5: RC to Chassis Check [Document](https://docs.decentro.tech/reference/rc-to-chasis)**

| RC to Chassis (Vehicle)                                                   Status: ⏳ Pending |
| :---- |
| **INPUT DATA ├─ RC Number: DL-3C-A-7889 \[✏️ Edit\]                                                         \[[Autofill OCR](https://docs.decentro.tech/reference/kyc-and-onboarding-api-reference-farsight-document-forensics-document-extraction)\]  \[Initiate Verification\] RC Number Chassis Number** RC Number **"chassisNumber" ADMIN NOTES**  Ok  **ADMIN DECISION**  \[✓ Accept\]     \[✗ Reject\]     \[⚠️ Request More Docs **\]**  |

### **Audit Log Structure**

CREATE TABLE kyc\_data\_audit (  
  id INT PRIMARY KEY,  
  lead\_id INT,  
  field\_name VARCHAR(50),  
  field\_value VARCHAR(200),  
  data\_source ENUM('ocr', 'api', 'manual'),  
  entered\_by INT, \-- Admin user ID  
  entered\_at TIMESTAMP,  
  reason TEXT \-- Why manual entry was needed  
);

**FINAL DECISION PANEL (ALWAYS VISIBLE)**

[image1]: <data:image/png;base64,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>

[image2]: <data:image/png;base64,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>

[image3]: <data:image/png;base64,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>

[image4]: <data:image/png;base64,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>