/**
 * Generates a presentation-ready PDF covering the Step 3 and Step 4 design
 * of the lead creation workflow, including flow charts rendered via Mermaid.
 *
 * Run: node scripts/generate-step34-design-pdf.js
 * Output: docs/step3-step4-design.pdf
 */
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const OUTPUT_PATH = path.join(__dirname, '..', 'docs', 'step3-step4-design.pdf');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Lead Creation — Step 3 & Step 4 Design</title>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<style>
  @page { size: A4; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    color: #1a1a1a;
    font-size: 10pt;
    line-height: 1.45;
    margin: 0;
    padding: 0;
  }
  h1 { color: #0b3b8c; font-size: 22pt; margin: 0 0 4pt 0; page-break-after: avoid; }
  h2 { color: #0b3b8c; font-size: 15pt; margin: 18pt 0 6pt 0; border-bottom: 2px solid #0b3b8c; padding-bottom: 3pt; page-break-after: avoid; }
  h3 { color: #22385f; font-size: 12pt; margin: 12pt 0 4pt 0; page-break-after: avoid; }
  h4 { color: #333; font-size: 10.5pt; margin: 8pt 0 3pt 0; page-break-after: avoid; }
  p { margin: 4pt 0; }
  ul, ol { margin: 4pt 0 4pt 18pt; padding: 0; }
  li { margin: 2pt 0; }
  code {
    background: #f0f3f8;
    padding: 1pt 4pt;
    border-radius: 3pt;
    font-family: Consolas, Monaco, monospace;
    font-size: 9pt;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 6pt 0;
    font-size: 9pt;
    page-break-inside: avoid;
  }
  th, td {
    border: 1px solid #c9d1e0;
    padding: 5pt 7pt;
    text-align: left;
    vertical-align: top;
  }
  th { background: #eaf0fa; color: #0b3b8c; font-weight: 600; }
  tr:nth-child(even) td { background: #fafbfd; }
  .cover {
    text-align: center;
    padding: 90pt 0 40pt 0;
  }
  .cover .subtitle { color: #555; font-size: 12pt; margin-top: 6pt; }
  .cover .meta { color: #888; font-size: 9.5pt; margin-top: 36pt; }
  .page-break { page-break-before: always; }
  .callout {
    background: #fff4d6;
    border-left: 4px solid #e5a500;
    padding: 8pt 12pt;
    margin: 8pt 0;
    font-size: 9.5pt;
    border-radius: 3pt;
  }
  .callout.blue {
    background: #e8f0fc;
    border-left-color: #0b3b8c;
  }
  .callout.green {
    background: #e6f7ec;
    border-left-color: #2a8d4a;
  }
  .callout.red {
    background: #fde8e8;
    border-left-color: #c0392b;
  }
  .badge {
    display: inline-block;
    padding: 1pt 6pt;
    border-radius: 9pt;
    font-size: 8pt;
    font-weight: 600;
    margin-right: 3pt;
  }
  .badge.done { background: #cdf0d8; color: #1b5e2a; }
  .badge.todo { background: #fde1d3; color: #803b1a; }
  .badge.partial { background: #fff0bf; color: #7a5a00; }
  .mermaid {
    text-align: center;
    margin: 10pt 0;
    page-break-inside: avoid;
    background: #ffffff;
  }
  .two-col {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12pt;
  }
  footer.pagefoot {
    position: fixed;
    bottom: 6mm;
    right: 12mm;
    color: #888;
    font-size: 8pt;
  }
</style>
</head>
<body>

<div class="cover">
  <h1>Lead Creation Workflow</h1>
  <div style="font-size: 16pt; color: #22385f; margin-top: 4pt;">Step 3 &amp; Step 4 — Design &amp; Implementation Guide</div>
  <div class="subtitle">iTarang — Dealer Management CRM</div>
  <div class="meta">
    Prepared for internal engineering review<br>
    Source of truth: <code>docs/superpowers/plans/lead creationworkflow.md</code>
  </div>
</div>

<div class="page-break"></div>

<h2>1. Where Step 3 &amp; Step 4 fit in the full lead flow</h2>
<p>Step 3 is a <strong>conditional</strong> re-verification loop, shown only when the admin needs more from the dealer after Step 2. Step 4 is where <strong>payment mode (Cash vs Finance) splits the workflow</strong> — Finance routes through an admin loan sanction and a Step 5 OTP confirmation; Cash is a one-shot dealer-authorised sale.</p>

<div class="mermaid">
flowchart LR
  S1[Step 1<br/>Lead creation<br/>+ payment mode]
  S2[Step 2<br/>Primary KYC]
  S3{Admin asks<br/>for more?}
  S3Loop[Step 3<br/>Supporting docs<br/>+/- co-borrower]
  S4[Step 4<br/>Product Selection]
  Cash([Cash path<br/>Confirm Sale<br/>→ SOLD])
  Fin[Finance path<br/>Loan Sanction]
  S5[Step 5<br/>Customer OTP<br/>→ SOLD]

  S1 --> S2 --> S3
  S3 -- Yes --> S3Loop --> S4
  S3 -- No --> S4
  S4 -- Cash --> Cash
  S4 -- Finance --> Fin --> S5

  style S3Loop fill:#fff4d6,stroke:#e5a500
  style Cash fill:#cdf0d8,stroke:#1b5e2a
  style Fin fill:#e8f0fc,stroke:#0b3b8c
  style S5 fill:#e8f0fc,stroke:#0b3b8c
</div>

<div class="callout blue">
  <strong>Rule:</strong> Step 4 and Step 5 are <em>blocked</em> until Step 3 is cleared by admin — unless Step 3 was never triggered for this lead, in which case Step 2 → Step 4 directly.
</div>

<div class="page-break"></div>

<h2>2. Step 3 — Conditional Re-verification</h2>

<h3>2.1 Purpose</h3>
<p>After Step 2, admin may need (a) more supporting documents from the primary applicant, and/or (b) a co-borrower if the applicant's financials are weak (CIBIL &lt; 650, insufficient income, high DTI). Step 3 handles both without restarting the flow.</p>

<h3>2.2 When Step 3 appears</h3>
<p>Only when <code>lead.kyc_status</code> is one of:</p>
<ul>
  <li><code>awaiting_additional_docs</code> — dealer uploads more supporting docs</li>
  <li><code>awaiting_co_borrower_kyc</code> — dealer does full co-borrower KYC</li>
  <li><code>awaiting_both</code> — both sections</li>
</ul>
<p>Otherwise the progress bar jumps Step 2 → Step 4 directly.</p>

<h3>2.3 Three admin-request scenarios</h3>
<table>
  <thead><tr><th>Scenario</th><th>Trigger</th><th>Dealer screen shows</th></tr></thead>
  <tbody>
    <tr><td>1. Supporting docs only</td><td>PAN unclear, bank stmt incomplete, RC illegible, etc.</td><td>Section A only</td></tr>
    <tr><td>2. Co-borrower only</td><td>CIBIL &lt; 650, income low, high DTI, no credit history</td><td>Section B only</td></tr>
    <tr><td>3. Both</td><td>Both problems simultaneously</td><td>Section A + Section B</td></tr>
  </tbody>
</table>

<h3>2.4 Step 3 status lifecycle</h3>
<div class="mermaid">
flowchart TD
  A[awaiting_additional_docs] --> P[pending_itarang_reverification]
  B[awaiting_co_borrower_kyc] --> P
  C[awaiting_both] --> P
  P --> R[reverification_in_progress]
  R --> Cleared[step_3_cleared<br/>Step 4 unlocks]
  R --> DR[awaiting_doc_reupload]
  R --> CR[awaiting_co_borrower_replacement]
  R --> Rej[kyc_rejected<br/>lead closed]
  DR -->|dealer resubmits| P
  CR -->|new co-borrower| P

  style Cleared fill:#cdf0d8,stroke:#1b5e2a
  style Rej fill:#fde8e8,stroke:#c0392b
  style P fill:#fff4d6,stroke:#e5a500
  style R fill:#e8f0fc,stroke:#0b3b8c
</div>

<h3>2.5 Dealer-side Step 3 screen — sections</h3>
<table>
  <thead><tr><th>Section</th><th>Shown when</th><th>Contains</th></tr></thead>
  <tbody>
    <tr>
      <td>Admin Request Banner</td>
      <td>Always</td>
      <td>Read-only: admin's request reason + deadline</td>
    </tr>
    <tr>
      <td>Section A — Supporting Docs</td>
      <td><code>awaiting_additional_docs</code> or <code>awaiting_both</code></td>
      <td>Dynamic upload cards — one per doc admin requested. No static list. Each card: name, admin reason, upload button, status badge (Pending Review / Verified / Rejected).</td>
    </tr>
    <tr>
      <td>Section B — Co-Borrower KYC</td>
      <td><code>awaiting_co_borrower_kyc</code> or <code>awaiting_both</code></td>
      <td>9-field profile form + 11 document cards + consent block (digital eSign via DigiO, or manual upload) + coupon validation.</td>
    </tr>
    <tr>
      <td>Submit bar</td>
      <td>Always (bottom)</td>
      <td>Back · Save Draft · Preview Profile · Submit for Verification.</td>
    </tr>
  </tbody>
</table>

<div class="callout">
  <strong>Submit gate:</strong> all required docs uploaded <em>+</em> (if co-borrower) form complete <em>+</em> consent captured <em>+</em> coupon validated. Supporting-docs-only case does <strong>not</strong> require a new coupon — the original lead coupon already covers it.
</div>

<div class="page-break"></div>

<h3>2.6 Admin-side Step 3 — appended review panels</h3>
<p>Admin opens the existing Step 2 KYC screen and finds new panels appended below (primary KYC stays read-only):</p>
<table>
  <thead><tr><th>#</th><th>Panel</th><th>When shown</th><th>Per-card actions</th></tr></thead>
  <tbody>
    <tr><td>1</td><td>Primary KYC (existing)</td><td>Always</td><td>Read-only</td></tr>
    <tr><td>2</td><td>Supporting Docs (appended)</td><td>If docs requested</td><td>Approve · Reject · Request More Docs (per doc card, mutually exclusive)</td></tr>
    <tr><td>3</td><td>Co-Borrower KYC (appended)</td><td>If co-borrower requested</td><td>Same 3-button action per verification card (Aadhaar, PAN, Face Match, Bank, Address, CIBIL)</td></tr>
    <tr><td>4</td><td>Final Decision</td><td>Always (pinned bottom)</td><td>Approve Lead · Reject Lead · Dealer Action Required</td></tr>
  </tbody>
</table>

<h3>2.7 Final Decision Panel — gating rules</h3>
<table>
  <thead><tr><th>Card state combo</th><th>Approve Lead</th><th>Dealer Action Required</th><th>Reject Lead</th></tr></thead>
  <tbody>
    <tr><td>All cards green (Approved)</td><td>✅ Enabled</td><td>Available</td><td>Always available</td></tr>
    <tr><td>Any card Rejected or Request Docs</td><td>🔒 Disabled</td><td>✅ Expected action</td><td>Always available</td></tr>
  </tbody>
</table>

<div class="callout red">
  <strong>Co-borrower replacement:</strong> If CIBIL or identity fails on the co-borrower, admin uses <em>Dealer Action Required</em> → status becomes <code>awaiting_co_borrower_replacement</code>. The <code>co_borrower_requests.attempt_number</code> increments so audit logs track how many co-borrowers were tried.
</div>

<h3>2.8 Step 3 — DB tables (schema changes needed)</h3>
<table>
  <thead><tr><th>Table</th><th>Status</th><th>Purpose</th></tr></thead>
  <tbody>
    <tr><td><code>additional_document_requests</code></td><td><span class="badge todo">Build</span></td><td>One row per admin request — request_type, documents_requested[], reason, deadline, status</td></tr>
    <tr><td><code>additional_document_uploads</code></td><td><span class="badge todo">Build</span></td><td>One row per uploaded file against a request</td></tr>
    <tr><td><code>co_borrower_requests</code></td><td><span class="badge todo">Build</span></td><td>One row per co-borrower request — includes <code>attempt_number</code></td></tr>
    <tr><td><code>co_borrowers</code></td><td><span class="badge done">Exists</span></td><td>Full co-borrower profile</td></tr>
    <tr><td><code>co_borrower_documents</code></td><td><span class="badge done">Exists</span></td><td>11 doc slots per co-borrower</td></tr>
    <tr><td><code>co_borrower_consent</code></td><td><span class="badge partial">Partial</span></td><td>Digital eSign / manual upload tracking; consent_type NULL until picked</td></tr>
  </tbody>
</table>

<h3>2.9 Step 3 — API endpoints</h3>
<table>
  <thead><tr><th>Method + Path</th><th>Who</th><th>Effect</th></tr></thead>
  <tbody>
    <tr><td><code>POST /api/admin/lead/:id/request-additional-docs</code></td><td>Admin</td><td>Triggers Scenario 1; writes <code>awaiting_additional_docs</code></td></tr>
    <tr><td><code>POST /api/admin/lead/:id/request-co-borrower</code></td><td>Admin</td><td>Triggers Scenario 2/3</td></tr>
    <tr><td><code>POST /api/lead/:id/step-3/upload-document</code></td><td>Dealer</td><td>Uploads one supporting doc against the request</td></tr>
    <tr><td><code>POST /api/lead/:id/step-3/co-borrower</code></td><td>Dealer</td><td>Submits co-borrower form + docs</td></tr>
    <tr><td><code>POST /api/lead/:id/step-3/submit</code></td><td>Dealer</td><td>Final submit → <code>pending_itarang_reverification</code></td></tr>
    <tr><td><code>POST /api/admin/lead/:id/step-3-decision</code></td><td>Admin</td><td>Per-card Approve/Reject/Request</td></tr>
    <tr><td><code>POST /api/admin/lead/:id/step-3-final-decision</code></td><td>Admin</td><td>Approve Lead / Reject Lead / Dealer Action Required</td></tr>
  </tbody>
</table>

<div class="page-break"></div>

<h2>3. Step 4 — Product Selection (the Cash / Finance split)</h2>

<h3>3.1 Purpose</h3>
<p>Dealer maps the physical product — battery + charger + paraphernalia — to this lead, sets their margin, and submits. <strong>This is where the workflow diverges based on payment mode.</strong></p>

<h3>3.2 Entry gate</h3>
<table>
  <thead><tr><th>Payment mode</th><th>Entry condition</th><th>Admin step after?</th></tr></thead>
  <tbody>
    <tr><td>Finance / Dealer Finance</td><td><code>kyc_status = step_3_cleared</code> or <code>kyc_approved</code></td><td><strong>Yes</strong> — admin loan sanction</td></tr>
    <tr><td>Cash</td><td><code>payment_method = 'Cash'</code></td><td><strong>No</strong> — dealer confirms sale directly</td></tr>
    <tr><td>Anything else</td><td>—</td><td>🔒 Blocked; redirect to last valid step</td></tr>
  </tbody>
</table>
<p>Gated by <code>GET /api/lead/:id/step-4-access</code> <span class="badge done">Exists</span>.</p>

<h3>3.3 Branching diagram — Cash vs Finance at submit</h3>
<div class="mermaid">
flowchart TD
  S4[Dealer Step 4<br/>Battery + Charger + Paraphernalia<br/>+ Margin]
  Check{payment_method?}
  Cash[Confirm Sale modal]
  CashOK([Inventory → SOLD<br/>Warranty created<br/>After-sales opened<br/>lead.status = sold])
  FinSubmit[Submit for Final Approval<br/>Inventory → RESERVED]
  Admin[Admin Product Panel]
  Sanction{Admin decision}
  LoanOK[loan_sanctioned<br/>→ Step 5]
  LoanNo[loan_rejected<br/>Inventory released<br/>→ Step 5 shows reason]
  ProdNo[product_selection_rejected<br/>Inventory released<br/>→ Step 4 re-opens]
  S5[Step 5 — OTP confirmation by customer]
  Sold([Inventory → SOLD<br/>Warranty created])

  S4 --> Check
  Check -- Cash --> Cash --> CashOK
  Check -- Finance --> FinSubmit --> Admin --> Sanction
  Sanction -- Loan Sanctioned --> LoanOK --> S5 --> Sold
  Sanction -- Loan Rejected --> LoanNo
  Sanction -- Product Rejected --> ProdNo

  style CashOK fill:#cdf0d8,stroke:#1b5e2a
  style Sold fill:#cdf0d8,stroke:#1b5e2a
  style LoanNo fill:#fde8e8,stroke:#c0392b
  style ProdNo fill:#fde8e8,stroke:#c0392b
  style LoanOK fill:#e8f0fc,stroke:#0b3b8c
  style S5 fill:#e8f0fc,stroke:#0b3b8c
</div>

<h3>3.4 Cash vs Finance — side-by-side</h3>
<table>
  <thead><tr><th>Aspect</th><th>Finance path</th><th>Cash path</th></tr></thead>
  <tbody>
    <tr><td>Submit button</td><td>"Submit for Final Approval"</td><td>"Confirm Sale"</td></tr>
    <tr><td>Confirmation modal</td><td>—</td><td>Required, with full summary</td></tr>
    <tr><td>Inventory on submit</td><td><code>reserved</code></td><td><code>sold</code> — immediate, skips reserved</td></tr>
    <tr><td>Admin queue</td><td>Yes — admin sanctions loan</td><td>None — dealer is sole authorising party</td></tr>
    <tr><td>Warranty</td><td>Created only after Step 5 OTP</td><td>Created immediately on confirm</td></tr>
    <tr><td>After-sales record</td><td>Opens after Step 5</td><td>Opens immediately on confirm</td></tr>
    <tr><td>Final <code>lead.status</code></td><td><code>sold</code> (via Step 5)</td><td><code>sold</code> (one shot)</td></tr>
  </tbody>
</table>

<div class="page-break"></div>

<h3>3.5 Dealer-side Step 4 screen — 6 sections</h3>
<table>
  <thead><tr><th>Section</th><th>Content</th><th>Key rule</th></tr></thead>
  <tbody>
    <tr><td>A. Category + Sub-category</td><td>Pre-filled from Step 1; editable</td><td>Changing category clears prior battery/charger</td></tr>
    <tr><td>B. Battery Selection</td><td>Filtered by category. Fields: serial, model, invoice date, age, SOC %, status</td><td><strong>Sorted oldest-first.</strong> Ageing badges: 0-90 normal · 91-180 orange (Ageing Stock) · &gt;180 red (Old Stock — Prioritise). Oldest unit flagged "Recommended".</td></tr>
    <tr><td>C. Charger Selection</td><td>Filtered by battery-model compatibility</td><td>Same ageing rules</td></tr>
    <tr><td>D. Paraphernalia</td><td>Digital SOC, Volt SOC, Harness variant, other accessories</td><td>Count-based, not serial-tracked. Checked against dealer stock at submit.</td></tr>
    <tr><td>E. Pricing &amp; Margin</td><td>Base prices system-controlled (read-only). Dealer enters margin.</td><td>Final price auto-calculated.</td></tr>
    <tr><td>F. Submit</td><td>Button label + behaviour split by payment_mode (see 3.4)</td><td>Button gated on: battery selected (available + correct category), charger selected (available + compatible)</td></tr>
  </tbody>
</table>

<h3>3.6 Admin-side — Product Selection Panel (Finance leads only)</h3>
<p>Appended below the KYC screen, following the same append pattern as Step 3. Cash leads never enter this panel.</p>
<table>
  <thead><tr><th>Action</th><th>Lead status after</th><th>Inventory impact</th></tr></thead>
  <tbody>
    <tr><td>Loan Sanctioned (opens 10-field loan form)</td><td><code>loan_sanctioned</code></td><td>Stays <code>reserved</code>. Routes to Step 5.</td></tr>
    <tr><td>Loan Rejected (mandatory reason)</td><td><code>loan_rejected</code></td><td><code>reserved → available</code>. Routes to Step 5 showing reason.</td></tr>
    <tr><td>Product Rejected</td><td><code>product_selection_rejected</code></td><td><code>reserved → available</code>. Step 4 re-opens on dealer side.</td></tr>
    <tr><td>Download Profile</td><td>no change</td><td>Streams ZIP: summary PDF + all KYC + supporting docs + co-borrower docs + product summary.</td></tr>
  </tbody>
</table>

<h3>3.7 Step 4 — Finance path state machine</h3>
<div class="mermaid">
flowchart LR
  Cleared[step_3_cleared<br/>or kyc_approved] --> Progress[product_selection_in_progress]
  Progress --> Pending[pending_final_approval]
  Pending --> Sanct[loan_sanctioned]
  Pending --> LRej[loan_rejected]
  Pending --> PRej[product_selection_rejected]
  Sanct --> S5[Step 5 — OTP]
  LRej --> S5
  S5 --> Sold([sold])
  PRej --> Progress

  style Sold fill:#cdf0d8,stroke:#1b5e2a
  style LRej fill:#fde8e8,stroke:#c0392b
  style PRej fill:#fde8e8,stroke:#c0392b
</div>

<h3>3.8 Step 4 — DB tables</h3>
<table>
  <thead><tr><th>Table</th><th>Status</th><th>Purpose</th></tr></thead>
  <tbody>
    <tr><td><code>product_selections</code></td><td><span class="badge partial">Partial</span></td><td>One row per lead — battery/charger serial, paraphernalia JSON, margin, final price, admin_decision</td></tr>
    <tr><td><code>loan_sanctions</code></td><td><span class="badge partial">Partial</span></td><td>One row per sanctioned loan — 10 loan fields + sanctioned_by/at</td></tr>
    <tr><td><code>loan_rejections</code></td><td><span class="badge partial">Partial</span></td><td>Rejection reason + rejected_by/at</td></tr>
    <tr><td><code>warranties</code></td><td><span class="badge todo">Build</span></td><td>warranty_id, start_date, battery serial</td></tr>
    <tr><td><code>after_sales_records</code></td><td><span class="badge todo">Build</span></td><td>Service lifecycle tracking</td></tr>
    <tr><td><code>inventory</code></td><td><span class="badge done">Exists</span></td><td>status transitions: <code>available → reserved → sold</code> (Finance) or <code>available → sold</code> (Cash)</td></tr>
  </tbody>
</table>

<h3>3.9 Step 4 — API endpoints (current state)</h3>
<table>
  <thead><tr><th>Endpoint</th><th>Status</th></tr></thead>
  <tbody>
    <tr><td><code>GET /api/lead/:id/step-4-access</code></td><td><span class="badge done">Exists</span></td></tr>
    <tr><td><code>GET /api/inventory/dealer/:dealerId/batteries</code></td><td><span class="badge done">Exists</span></td></tr>
    <tr><td><code>GET /api/inventory/dealer/:dealerId/chargers</code></td><td><span class="badge done">Exists</span></td></tr>
    <tr><td><code>GET /api/inventory/dealer/:dealerId/paraphernalia</code></td><td><span class="badge done">Exists</span></td></tr>
    <tr><td><code>POST /api/lead/:id/submit-product-selection</code></td><td><span class="badge done">Exists</span> (Finance)</td></tr>
    <tr><td><code>POST /api/lead/:id/confirm-cash-sale</code></td><td><span class="badge done">Exists</span> (Cash)</td></tr>
    <tr><td><code>POST /api/admin/lead/:id/sanction-loan</code></td><td><span class="badge done">Exists</span></td></tr>
    <tr><td><code>POST /api/admin/lead/:id/reject-loan</code></td><td><span class="badge done">Exists</span></td></tr>
    <tr><td><code>POST /api/admin/lead/:id/product-selection</code></td><td><span class="badge done">Exists</span></td></tr>
    <tr><td><code>GET /api/admin/lead/:id/download-profile</code></td><td><span class="badge done">Exists</span></td></tr>
  </tbody>
</table>

<div class="page-break"></div>

<h2>4. Implementation status &amp; build order</h2>

<h3>4.1 What's already scaffolded in the codebase</h3>
<ul>
  <li>Dealer pages: <code>dealer-portal/leads/[id]/kyc/interim/</code> (Step 3), <code>product-selection/</code> (Step 4), <code>step-5/</code></li>
  <li>Admin page: <code>admin/product-review/[leadId]</code></li>
  <li>Inventory APIs (batteries, chargers, paraphernalia)</li>
  <li>Step 4 submit + cash confirm + loan sanction / reject / product-selection APIs</li>
  <li>Schema: <code>co_borrowers</code>, <code>co_borrower_documents</code></li>
</ul>

<h3>4.2 Step 3 — what's still to build</h3>
<ul>
  <li><code>additional_document_requests</code> + <code>additional_document_uploads</code> tables</li>
  <li><code>co_borrower_requests</code> table (with <code>attempt_number</code>)</li>
  <li>Admin "Request More Docs" and "Request Co-Borrower" modals + POST endpoints</li>
  <li>Per-card 3-button action (Approve / Reject / Request More Docs) on the admin side</li>
  <li>Final Decision Panel — the gating logic (Approve enabled only when all cards green)</li>
  <li>Dealer-side dynamic rendering of Section A vs Section B vs both</li>
  <li>Co-borrower consent flow: digital eSign (reuses existing DigiO consent infra) + manual upload</li>
  <li>Notifications (SMS + email + dashboard push) for the 6 Step 3 events</li>
</ul>

<h3>4.3 Step 4 — what's still to polish</h3>
<ul>
  <li>Inventory ageing badges (0-90 / 91-180 / &gt;180) on the UI</li>
  <li>IoT SOC fetch + stale-data indicator</li>
  <li>Race-condition guard on submit (two dealers picking the same serial)</li>
  <li>Admin "Product Rejected" action wiring (Loan Sanctioned / Rejected already done)</li>
  <li>Warranty + after-sales record creation on cash confirm</li>
  <li>ZIP download assembly for the profile (schema wired, assembly is the work)</li>
</ul>

<h3>4.4 Suggested build order</h3>
<ol>
  <li><strong>Step 3 tables first</strong> — unblocks both dealer and admin sides.</li>
  <li><strong>Admin "Request More Docs" modal + API</strong> — the trigger that opens Step 3.</li>
  <li><strong>Dealer Step 3 dynamic rendering</strong> — Section A + Section B driven by backend-returned request data.</li>
  <li><strong>Admin Step 3 append panels + 3-button per-card logic</strong> — largest UI chunk.</li>
  <li><strong>Final Decision Panel gating logic</strong> — Approve only when all cards green.</li>
  <li><strong>Co-borrower consent flow</strong> — digital first (reuses DigiO), manual is simpler.</li>
  <li><strong>Step 4 polish</strong> — ageing badges, IoT SOC, race-condition guard.</li>
  <li><strong>Product Rejected action + Warranty + After-sales creation</strong> — finance &amp; cash loose ends.</li>
  <li><strong>Notifications + ZIP download</strong> — cross-cutting, can be parallelised.</li>
</ol>

<h2>5. Anticipated team questions</h2>

<div class="callout blue">
  <strong>Q: Why is Step 3 conditional?</strong><br>
  Most leads (~70% per the BRD) pass primary KYC cleanly. Forcing every dealer through Step 3 adds friction and slows throughput. The conditional design keeps the flow short for clean applicants and targets the re-verification loop only when admin genuinely needs more from the dealer.
</div>

<div class="callout blue">
  <strong>Q: What happens if admin changes their mind after requesting?</strong><br>
  Admin can still use "Approve Lead" from the Final Decision Panel if the cards subsequently turn green, or issue a fresh request. There is no "undo" of the original request — it's an audit trail.
</div>

<div class="callout blue">
  <strong>Q: Why is the cash flow one-shot with no admin step?</strong><br>
  In cash the dealer is the sole authorising party. There is no loan to sanction and no lender to align. Forcing admin approval would only slow inventory turns and revenue. Admin still sees the sale retrospectively via the Download Profile action.
</div>

<div class="callout blue">
  <strong>Q: How do we prevent the same battery serial being picked by two dealers simultaneously?</strong><br>
  Server-side race-condition guard on <code>/submit-product-selection</code> and <code>/confirm-cash-sale</code>: a transactional <code>SELECT ... FOR UPDATE</code> + status check before transitioning <code>inventory.status</code>. If another request already transitioned it, return a clear "serial no longer available — please re-select" error.
</div>

<h2>6. References</h2>
<ul>
  <li>Full BRD: <code>docs/superpowers/plans/lead creationworkflow.md</code> — Step 3 at lines 3311–3649, Step 4 at lines 3651–4099</li>
  <li>Existing code: <code>src/app/(dashboard)/dealer-portal/leads/[id]/</code>, <code>src/app/api/admin/lead/[id]/</code>, <code>src/app/api/inventory/</code></li>
  <li>Schema: <code>src/lib/db/schema.ts</code></li>
</ul>

<script>
  if (typeof mermaid !== 'undefined') {
    mermaid.initialize({
      startOnLoad: true,
      theme: 'default',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      flowchart: { htmlLabels: true, curve: 'basis' },
    });
  }
</script>
</body>
</html>`;

(async () => {
  console.log('[generate-pdf] launching Puppeteer...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    console.log('[generate-pdf] loading HTML + Mermaid CDN...');
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60000 });

    // Wait for mermaid to render all diagrams.
    console.log('[generate-pdf] waiting for mermaid diagrams to render...');
    await page.waitForFunction(
      () => {
        const els = document.querySelectorAll('.mermaid');
        if (!els.length) return true;
        return Array.from(els).every((el) => el.querySelector('svg'));
      },
      { timeout: 30000 },
    );

    // Extra settle time for Mermaid font metrics.
    await new Promise((r) => setTimeout(r, 1500));

    console.log('[generate-pdf] rendering PDF to:', OUTPUT_PATH);
    await page.pdf({
      path: OUTPUT_PATH,
      format: 'A4',
      printBackground: true,
      margin: { top: '14mm', right: '12mm', bottom: '14mm', left: '12mm' },
    });

    const stat = fs.statSync(OUTPUT_PATH);
    console.log(`[generate-pdf] done. size=${stat.size} bytes path=${OUTPUT_PATH}`);
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error('[generate-pdf] FAILED:', err);
  process.exitCode = 1;
});
