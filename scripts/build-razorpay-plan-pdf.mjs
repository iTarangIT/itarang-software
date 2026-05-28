// Build the Razorpay Down-Payment integration plan PDF.
// Writes:
//   C:\Users\Aniket\Downloads\Razorpay-Integration-Plan.pdf
//   C:\Users\Aniket\Downloads\Razorpay-Integration-Plan.html

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer';

const today = new Date().toISOString().slice(0, 10);

const html = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Razorpay Down-Payment Integration Plan</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  html, body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1f2937; line-height: 1.5; font-size: 11pt; }
  h1 { font-size: 22pt; color: #0f172a; margin: 0 0 4pt; }
  h2 { font-size: 15pt; color: #0f172a; margin-top: 22pt; border-bottom: 2px solid #3399cc; padding-bottom: 4pt; }
  h3 { font-size: 12.5pt; color: #0f172a; margin-top: 14pt; }
  h4 { font-size: 11pt; color: #334155; margin-top: 10pt; }
  .subtitle { color: #64748b; font-size: 10pt; margin-bottom: 18pt; }
  table { width: 100%; border-collapse: collapse; margin: 8pt 0 12pt; font-size: 10pt; }
  th, td { border: 1px solid #e5e7eb; padding: 6pt 8pt; text-align: left; vertical-align: top; }
  th { background: #f8fafc; font-weight: 700; color: #0f172a; }
  code, pre { font-family: "SFMono-Regular", Consolas, Menlo, monospace; font-size: 9.5pt; }
  pre { background: #0f172a; color: #e2e8f0; padding: 10pt 12pt; border-radius: 6pt; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
  code { background: #f1f5f9; color: #0f172a; padding: 1pt 5pt; border-radius: 3pt; }
  pre code { background: none; color: inherit; padding: 0; }
  ul, ol { padding-left: 20pt; }
  li { margin-bottom: 4pt; }
  .pill { display: inline-block; padding: 2pt 8pt; border-radius: 999pt; font-weight: 700; font-size: 9pt; }
  .pill-ok { background: #ecfdf5; color: #047857; }
  .pill-bad { background: #fef2f2; color: #b91c1c; }
  .pill-warn { background: #fffbeb; color: #b45309; }
  .pill-info { background: #eff6ff; color: #1e40af; }
  .callout { border-left: 4pt solid; padding: 10pt 12pt; margin: 10pt 0; border-radius: 4pt; }
  .callout-info { background: #eff6ff; border-color: #2563eb; }
  .callout-warn { background: #fffbeb; border-color: #d97706; }
  .callout-bad { background: #fef2f2; border-color: #b91c1c; }
  .callout-ok { background: #ecfdf5; border-color: #047857; }
  .keyval { display: grid; grid-template-columns: 220px 1fr; gap: 4pt 10pt; font-size: 10pt; margin: 6pt 0 12pt; }
  .keyval dt { font-weight: 700; color: #475569; }
  .keyval dd { margin: 0; color: #0f172a; word-break: break-all; }
  hr { border: 0; border-top: 1px solid #e5e7eb; margin: 18pt 0; }
  .toc { background: #f8fafc; padding: 10pt 16pt; border-radius: 6pt; border: 1px solid #e5e7eb; }
  .toc ol { margin: 0; padding-left: 18pt; }
  .small { font-size: 9pt; color: #64748b; }
  .flow {
    display: grid;
    grid-template-columns: 30px 1fr;
    gap: 6pt 10pt;
    margin: 8pt 0;
    font-size: 10pt;
  }
  .flow .step {
    background: #3399cc;
    color: #fff;
    border-radius: 50%;
    width: 24px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 9pt;
  }
  .flow .body { padding-top: 2pt; }
  .flow .body strong { color: #0f172a; }
</style>
</head>
<body>

<h1>Razorpay Down-Payment Integration Plan</h1>
<div class="subtitle">
  iTarang CRM &middot; Step 5 (final step) of new-lead creation &middot; Generated ${today}
</div>

<div class="toc">
  <strong>Contents</strong>
  <ol>
    <li>Goal &amp; scope</li>
    <li>What&rsquo;s already integrated (facilitation fee via UPI QR)</li>
    <li>Where the new payment fits — Step 5 of the dealer flow</li>
    <li>Recommended approach: Razorpay Standard Checkout</li>
    <li>Payment methods we&rsquo;ll support</li>
    <li>End-to-end customer flow</li>
    <li>API endpoints we&rsquo;ll add</li>
    <li>Schema changes</li>
    <li>Razorpay endpoints, credentials, environment variables</li>
    <li>Webhook security &amp; signature verification</li>
    <li>Files to create / modify</li>
    <li>Edge cases &amp; failure modes</li>
    <li>Verification checklist (end-to-end test)</li>
    <li>Out of scope for v1 (deferred)</li>
  </ol>
</div>

<h2>1. Goal &amp; scope</h2>
<p>
  Collect the <strong>customer&rsquo;s down payment</strong> at the last step of new-lead creation (Step 5), so the lead can&rsquo;t hit
  <em>dispatch authorization</em> until the down payment has cleared.
</p>
<ul>
  <li><strong>Who pays:</strong> the end customer (the borrower in finance leads, the buyer in cash leads if applicable).</li>
  <li><strong>How much:</strong> the value already sanctioned by admin in Step 4 &mdash; <code>loan_sanctions.down_payment</code>.</li>
  <li><strong>How:</strong> Razorpay Standard Checkout (modal in the dealer&rsquo;s browser, customer pays from their preferred method).</li>
  <li><strong>When:</strong> after admin sanctions the loan and before dealer can confirm dispatch (OTP step).</li>
  <li><strong>Where:</strong> embedded in the existing Step 5 page <code>dealer-portal/leads/[id]/step-5</code>.</li>
</ul>

<h2>2. What&rsquo;s already integrated</h2>
<div class="callout callout-info">
  <strong>Status:</strong> Razorpay is already wired into the project for <strong>facilitation fees</strong> (a flat
  &#8377;1,500 paid by the dealer at Step 2 KYC, coupon-discountable). This plan does NOT touch that flow &mdash; it
  uses the same Razorpay account but a different product.
</div>
<dl class="keyval">
  <dt>Razorpay helper</dt><dd><code>src/lib/razorpay.ts</code> &mdash; <code>createPaymentQr()</code>, <code>fetchQrStatus()</code>, <code>closeQrCode()</code>, <code>verifyWebhookSignature()</code>. Uses the official <code>razorpay</code> Node SDK.</dd>
  <dt>QR creation route</dt><dd><code>src/app/api/kyc/[leadId]/create-payment-qr/route.ts</code></dd>
  <dt>Status polling route</dt><dd><code>src/app/api/kyc/[leadId]/payment-status/route.ts</code></dd>
  <dt>Regenerate QR route</dt><dd><code>src/app/api/kyc/[leadId]/regenerate-payment-qr/route.ts</code></dd>
  <dt>Manual UTR fallback</dt><dd><code>src/app/api/kyc/[leadId]/facilitation-payment/route.ts</code></dd>
  <dt>Webhook</dt><dd><code>src/app/api/payments/razorpay/webhook/route.ts</code> &mdash; currently handles <code>qr_code.credited</code> only.</dd>
  <dt>DB table</dt><dd><code>facilitation_payments</code> &mdash; already has <code>razorpay_order_id</code>, <code>razorpay_payment_id</code>, <code>razorpay_qr_id</code> columns.</dd>
  <dt>Env vars (already set)</dt><dd><code>RAZORPAY_KEY_ID</code>, <code>RAZORPAY_KEY_SECRET</code>, <code>RAZORPAY_WEBHOOK_SECRET</code></dd>
</dl>

<h2>3. Where the new payment fits</h2>
<p>
  The dealer&rsquo;s new-lead flow has 5 steps. <strong>Step 5</strong> is the last step and is shown only for finance leads
  (cash leads end at Step 4). Currently Step 5 just shows the sanctioned loan summary + an OTP-based dispatch
  confirmation. We&rsquo;re inserting <strong>down-payment collection</strong> between &ldquo;view loan&rdquo; and &ldquo;OTP confirm&rdquo;.
</p>

<table>
  <thead>
    <tr><th>Step</th><th>What happens</th><th>Payment activity (today &rarr; after this plan)</th></tr>
  </thead>
  <tbody>
    <tr><td>1</td><td>Lead creation (name, phone, product, payment_method)</td><td>&mdash;</td></tr>
    <tr><td>2</td><td>KYC (Aadhaar, PAN, consent, Video KYC)</td><td>&#8377;1,500 facilitation fee via UPI QR (existing)</td></tr>
    <tr><td>3</td><td>Supporting docs &amp; co-borrower (conditional)</td><td>&mdash;</td></tr>
    <tr><td>4</td><td>Product selection &amp; admin sanctioning</td><td>Admin sets <code>down_payment</code>, <code>loan_amount</code>, EMI</td></tr>
    <tr><td>5 (<strong>last</strong>)</td><td>Loan review &rarr; <strong>down-payment collection (NEW)</strong> &rarr; OTP dispatch confirmation</td><td><strong>Razorpay Standard Checkout (new)</strong></td></tr>
  </tbody>
</table>

<h2>4. Recommended approach: Razorpay Standard Checkout</h2>
<p>
  The existing facilitation-fee flow uses a <strong>UPI QR code</strong>, which is great for a small fixed amount (&#8377;1,500)
  paid in-person at the dealer&rsquo;s desk. Down payments are typically &#8377;10,000&ndash;&#8377;50,000, paid by the customer from their own
  device. For that we want the <strong>full Razorpay Standard Checkout</strong> &mdash; an embedded modal that offers every payment
  method the customer might want.
</p>

<div class="callout callout-ok">
  <strong>Why Standard Checkout (not just another QR):</strong>
  <ul>
    <li>Customer chooses their preferred method (UPI / Card / Netbanking / Wallet / EMI).</li>
    <li>Hosted by Razorpay &mdash; we don&rsquo;t handle card data (PCI scope stays out).</li>
    <li>Built-in retry, refund, and dispute UX.</li>
    <li>Same Razorpay SDK we already use &mdash; one extra helper function, no new credentials.</li>
  </ul>
</div>

<h2>5. Payment methods to support</h2>
<p>
  Razorpay enables all of these by default for a verified account. We don&rsquo;t need to whitelist each &mdash; just configure
  the checkout&rsquo;s <code>method</code> field to allow them all.
</p>
<table>
  <thead>
    <tr><th>Method</th><th>Coverage</th><th>Notes</th></tr>
  </thead>
  <tbody>
    <tr><td>UPI</td><td>GPay, PhonePe, Paytm, BHIM &hellip;</td><td>Most common &mdash; default on Razorpay checkout</td></tr>
    <tr><td>Cards</td><td>Visa, Mastercard, RuPay, Amex (credit + debit)</td><td>Razorpay-hosted &mdash; PCI compliance handled by them</td></tr>
    <tr><td>Netbanking</td><td>~60 banks (SBI, HDFC, ICICI, Axis &hellip;)</td><td>Direct bank redirect</td></tr>
    <tr><td>Wallets</td><td>Paytm, PhonePe, Mobikwik, Amazon Pay</td><td>Useful for unbanked customers</td></tr>
    <tr><td>EMI</td><td>Credit cards (HDFC, ICICI, Axis, &hellip;)</td><td>Useful when down payment is large; offer at checkout</td></tr>
    <tr><td>Pay Later</td><td>LazyPay, Simpl</td><td>Optional &mdash; toggle later</td></tr>
  </tbody>
</table>

<h2>6. End-to-end customer flow</h2>
<div class="flow">
  <span class="step">1</span><div class="body"><strong>Admin sanctions loan (Step 4).</strong> Sets <code>loan_sanctions.down_payment</code> = &#8377;X. Lead status &rarr; <code>loan_sanctioned</code>.</div>
  <span class="step">2</span><div class="body"><strong>Dealer opens Step 5</strong> for the lead. Page shows the loan summary + a new &ldquo;Down Payment&rdquo; card with the amount and a <strong>&ldquo;Collect Down Payment&rdquo;</strong> button.</div>
  <span class="step">3</span><div class="body"><strong>Dealer clicks the button.</strong> Front-end calls our backend (<code>POST /api/leads/[leadId]/down-payment/create-order</code>) which creates a Razorpay Order via <code>POST https://api.razorpay.com/v1/orders</code>.</div>
  <span class="step">4</span><div class="body">Backend persists <code>razorpay_order_id</code>, returns it to the front-end.</div>
  <span class="step">5</span><div class="body"><strong>Front-end opens Razorpay Checkout modal</strong> using <code>https://checkout.razorpay.com/v1/checkout.js</code> with <code>order_id</code>, <code>amount</code>, customer prefill data.</div>
  <span class="step">6</span><div class="body"><strong>Customer pays</strong> using UPI / Card / Netbanking / Wallet / EMI &mdash; on the same dealer device or scanning a UPI QR from the modal.</div>
  <span class="step">7</span><div class="body">Razorpay returns <code>{ razorpay_payment_id, razorpay_order_id, razorpay_signature }</code> to the front-end callback.</div>
  <span class="step">8</span><div class="body">Front-end calls <code>POST /api/leads/[leadId]/down-payment/verify</code>. Backend verifies the HMAC-SHA256 signature &amp; marks payment <code>captured</code>.</div>
  <span class="step">9</span><div class="body"><strong>Webhook (server-to-server)</strong> from Razorpay (<code>payment.captured</code> / <code>order.paid</code>) confirms the capture even if the front-end callback was missed. Idempotent merge.</div>
  <span class="step">10</span><div class="body"><strong>Down payment status flips to PAID.</strong> Step 5 unlocks the OTP dispatch button.</div>
  <span class="step">11</span><div class="body">Dealer enters the OTP sent to the customer &rarr; inventory moves reserved&rarr;sold, warranty activated, dispatch authorized.</div>
</div>

<h2>7. API endpoints we&rsquo;ll add</h2>
<table>
  <thead>
    <tr><th>Method</th><th>Path</th><th>Job</th></tr>
  </thead>
  <tbody>
    <tr>
      <td>POST</td>
      <td><code>/api/leads/[leadId]/down-payment/create-order</code></td>
      <td>Read <code>loan_sanctions.down_payment</code>, call Razorpay <code>POST /v1/orders</code> with that amount in paise, persist <code>razorpay_order_id</code> + <code>amount_paise</code> + <code>status='ORDER_CREATED'</code>, return <code>{ order_id, amount_paise, key_id, prefill }</code> to the front-end.</td>
    </tr>
    <tr>
      <td>POST</td>
      <td><code>/api/leads/[leadId]/down-payment/verify</code></td>
      <td>Body: <code>{ razorpay_order_id, razorpay_payment_id, razorpay_signature }</code>. Recompute HMAC-SHA256(<code>order_id|payment_id</code>, <code>KEY_SECRET</code>); if it matches, flip <code>status='PAID'</code>, store <code>payment_id</code>, <code>signature</code>, <code>payment_method</code>, <code>paid_at</code>.</td>
    </tr>
    <tr>
      <td>GET</td>
      <td><code>/api/leads/[leadId]/down-payment/status</code></td>
      <td>Polling endpoint for the dealer UI. Returns current status, paid amount, paid_at, payment_method.</td>
    </tr>
    <tr>
      <td>POST</td>
      <td><code>/api/payments/razorpay/webhook</code> (<em>extend existing</em>)</td>
      <td>Add handlers for <code>payment.captured</code>, <code>payment.failed</code>, and <code>order.paid</code>. Match by <code>razorpay_order_id</code> &rarr; flip <code>down_payments</code> row accordingly. Idempotent.</td>
    </tr>
  </tbody>
</table>

<h2>8. Schema changes</h2>
<p>
  Create a dedicated <code>down_payments</code> table (cleaner separation from <code>facilitation_payments</code>; allows different
  amount, method, and lifecycle).
</p>
<pre><code>-- drizzle/E-XXX_down_payments.sql (additive, idempotent)
CREATE TABLE IF NOT EXISTS down_payments (
  id                  varchar(255) PRIMARY KEY,
  lead_id             varchar(255) NOT NULL,
  loan_sanction_id    varchar(255),
  amount_inr          numeric(12, 2) NOT NULL,
  amount_paise        bigint NOT NULL,
  currency            varchar(8) NOT NULL DEFAULT 'INR',
  razorpay_order_id   varchar(255),
  razorpay_payment_id varchar(255),
  razorpay_signature  varchar(255),
  payment_method      varchar(30),         -- upi / card / netbanking / wallet / emi
  status              varchar(30) NOT NULL DEFAULT 'PENDING',
                                            -- PENDING / ORDER_CREATED / PAID / FAILED / REFUNDED
  failed_reason       text,
  paid_at             timestamptz,
  refunded_at         timestamptz,
  webhook_event_ids   jsonb,               -- audit trail of webhook events processed
  created_by          uuid,
  created_at          timestamptz DEFAULT now() NOT NULL,
  updated_at          timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS down_payments_lead_idx ON down_payments(lead_id);
CREATE INDEX IF NOT EXISTS down_payments_status_idx ON down_payments(status);
CREATE UNIQUE INDEX IF NOT EXISTS down_payments_rzp_order_uidx
  ON down_payments(razorpay_order_id)
  WHERE razorpay_order_id IS NOT NULL;</code></pre>

<p>
  Mirror the table in <code>src/lib/db/schema.ts</code> as <code>downPayments = pgTable('down_payments', { ... })</code>.
</p>

<h2>9. Razorpay endpoints, credentials, environment variables</h2>

<h4>Endpoints we&rsquo;ll call (Razorpay)</h4>
<dl class="keyval">
  <dt>Create Order</dt><dd><code>POST https://api.razorpay.com/v1/orders</code></dd>
  <dt>Fetch Order</dt><dd><code>GET https://api.razorpay.com/v1/orders/:order_id</code></dd>
  <dt>Fetch Payment</dt><dd><code>GET https://api.razorpay.com/v1/payments/:payment_id</code></dd>
  <dt>Refund (Step 5 reversal)</dt><dd><code>POST https://api.razorpay.com/v1/payments/:payment_id/refund</code></dd>
  <dt>Checkout SDK (client)</dt><dd><code>https://checkout.razorpay.com/v1/checkout.js</code></dd>
</dl>

<h4>Authentication</h4>
<p>
  Server-to-server calls use HTTP Basic Auth: <code>RAZORPAY_KEY_ID</code>:<code>RAZORPAY_KEY_SECRET</code> in the
  <code>Authorization</code> header. The Razorpay Node SDK (already installed as <code>razorpay</code>) handles this when
  initialised via <code>new Razorpay({ key_id, key_secret })</code>.
</p>

<h4>Environment variables (already set on sandbox + prod)</h4>
<table>
  <thead>
    <tr><th>Variable</th><th>Used by</th><th>Notes</th></tr>
  </thead>
  <tbody>
    <tr><td><code>RAZORPAY_KEY_ID</code></td><td>Server (Order creation) + Client (Checkout modal)</td><td>Public-ish ID, prefixed <code>rzp_test_</code> or <code>rzp_live_</code>. Safe to expose in client bundle.</td></tr>
    <tr><td><code>RAZORPAY_KEY_SECRET</code></td><td>Server only</td><td>Never exposed to client. Used to authenticate Order creation and verify payment signatures.</td></tr>
    <tr><td><code>RAZORPAY_WEBHOOK_SECRET</code></td><td>Server (webhook handler)</td><td>HMAC-SHA256 secret to verify Razorpay-signed webhook payloads. Configured in Razorpay Dashboard &rarr; Webhooks.</td></tr>
  </tbody>
</table>

<div class="callout callout-info">
  <strong>No new env vars needed.</strong> All three are already configured on sandbox and prod because the
  facilitation-fee flow uses them. We&rsquo;re reusing the same Razorpay account, just a different product (Orders +
  Checkout instead of QR codes).
</div>

<h4>Razorpay Dashboard configuration (one-time)</h4>
<ul>
  <li><strong>Webhook URL:</strong> <code>https://sandbox.itarang.com/api/payments/razorpay/webhook</code> (already configured for QR events). Extend the subscribed events to also include <code>payment.captured</code>, <code>payment.failed</code>, <code>order.paid</code>.</li>
  <li><strong>Active events:</strong> <code>qr_code.credited</code> (existing) + <code>payment.captured</code> + <code>payment.failed</code> + <code>order.paid</code> (add).</li>
  <li><strong>Payment methods enabled:</strong> verify in Dashboard &rarr; Settings &rarr; Payment Methods that UPI / Cards / Netbanking / Wallets / EMI are all toggled on for your account.</li>
  <li><strong>Settlement schedule:</strong> usually T+1 to T+3 working days. Confirm in Dashboard &rarr; Settings &rarr; Settlements.</li>
</ul>

<h2>10. Webhook security &amp; signature verification</h2>
<p>
  Razorpay returns two cryptographic checks. Both are HMAC-SHA256.
</p>

<h4>(a) Payment verification (client-callback)</h4>
<pre><code>// In /api/leads/[leadId]/down-payment/verify
import crypto from 'node:crypto';

const generatedSignature = crypto
  .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET!)
  .update(\`\${razorpay_order_id}|\${razorpay_payment_id}\`)
  .digest('hex');

if (generatedSignature !== razorpay_signature) {
  return NextResponse.json({ success: false, error: 'Invalid signature' }, { status: 400 });
}</code></pre>

<h4>(b) Webhook verification (server-to-server callback)</h4>
<pre><code>// In /api/payments/razorpay/webhook
import crypto from 'node:crypto';

const raw = await req.text();              // IMPORTANT: read raw body, not parsed JSON
const signature = req.headers.get('x-razorpay-signature') || '';
const expected = crypto
  .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET!)
  .update(raw)
  .digest('hex');

if (signature !== expected) {
  return new NextResponse('invalid signature', { status: 400 });
}
const payload = JSON.parse(raw);
const event = payload.event;       // e.g. 'payment.captured'
const orderId = payload.payload.payment.entity.order_id;
// &hellip; look up down_payments row, update status idempotently.</code></pre>

<p class="small">
  Razorpay&rsquo;s docs explicitly say: &ldquo;Ensure that the webhook body is passed as an argument in the raw webhook
  request body. Do not parse or cast the webhook request body.&rdquo; That&rsquo;s why we read <code>req.text()</code> before
  any JSON parse.
</p>

<h2>11. Files to create / modify</h2>

<h4>Create</h4>
<dl class="keyval">
  <dt>Order helper</dt><dd><code>src/lib/razorpay.ts</code> &mdash; add <code>createOrder(p)</code> &amp; <code>verifyPaymentSignature(orderId, paymentId, signature)</code>.</dd>
  <dt>Order creation route</dt><dd><code>src/app/api/leads/[leadId]/down-payment/create-order/route.ts</code></dd>
  <dt>Payment verify route</dt><dd><code>src/app/api/leads/[leadId]/down-payment/verify/route.ts</code></dd>
  <dt>Polling status route</dt><dd><code>src/app/api/leads/[leadId]/down-payment/status/route.ts</code></dd>
  <dt>Dealer UI component</dt><dd><code>src/components/dealer-portal/step-5/DownPaymentSection.tsx</code> &mdash; loads <code>checkout.js</code>, mounts the modal, handles success/failure callback.</dd>
  <dt>Schema migration</dt><dd><code>drizzle/E-XXX_down_payments.sql</code> &mdash; per &sect; 8 above.</dd>
  <dt>Schema mirror</dt><dd>Append <code>downPayments</code> to <code>src/lib/db/schema.ts</code>.</dd>
</dl>

<h4>Modify</h4>
<dl class="keyval">
  <dt>Step 5 page</dt><dd><code>src/app/(dashboard)/dealer-portal/leads/[id]/step-5/page.tsx</code> &mdash; mount <code>&lt;DownPaymentSection /&gt;</code> above the OTP card. Gate the OTP card on <code>down_payments.status === 'PAID'</code>.</dd>
  <dt>Webhook handler</dt><dd><code>src/app/api/payments/razorpay/webhook/route.ts</code> &mdash; add <code>payment.captured</code> / <code>payment.failed</code> / <code>order.paid</code> branches. Idempotent merge by <code>razorpay_payment_id</code>.</dd>
</dl>

<h2>12. Edge cases &amp; failure modes</h2>
<table>
  <thead>
    <tr><th>Scenario</th><th>How we handle it</th></tr>
  </thead>
  <tbody>
    <tr><td>Customer closes the Razorpay modal without paying</td><td>Order stays in <code>ORDER_CREATED</code>. Dealer can hit &ldquo;Collect Down Payment&rdquo; again &mdash; we re-use the same order_id if it&rsquo;s still open, else create a new one.</td></tr>
    <tr><td>Network drops between Razorpay and our front-end after payment</td><td>Front-end never receives <code>razorpay_payment_id</code>, but webhook arrives at the server. Status still flips to PAID via webhook. UI polling picks it up.</td></tr>
    <tr><td>Webhook arrives before front-end <code>/verify</code></td><td>Webhook is idempotent &mdash; the verify route just confirms; if status is already PAID, nothing changes.</td></tr>
    <tr><td>Signature mismatch on front-end callback</td><td>Reject the request with 400, leave order pending. Webhook will still arrive (if payment was genuinely captured) and resolve.</td></tr>
    <tr><td>Payment fails (e.g. card declined)</td><td>Webhook <code>payment.failed</code> &rarr; store <code>failed_reason</code> &rarr; UI shows error + lets dealer retry with a fresh order.</td></tr>
    <tr><td>Customer overpays / underpays</td><td>Razorpay only allows exact-amount payment when <code>order_id</code> is used. Underpayment is impossible.</td></tr>
    <tr><td>Refund needed (admin cancel after pay)</td><td>Admin-only action &mdash; call <code>POST /v1/payments/:id/refund</code>. Webhook <code>refund.created</code> flips status to REFUNDED.</td></tr>
    <tr><td>Cash leads (no loan, no Step 5)</td><td>Down payment doesn&rsquo;t apply. Section never renders.</td></tr>
  </tbody>
</table>

<h2>13. Verification checklist (end-to-end test)</h2>
<ol>
  <li>Run the migration on sandbox DB.</li>
  <li>Confirm Razorpay Dashboard &rarr; Webhooks subscribes to <code>payment.captured</code>, <code>payment.failed</code>, <code>order.paid</code>.</li>
  <li>Create a finance lead, get it to <code>loan_sanctioned</code> state with <code>down_payment</code> set.</li>
  <li>Open Step 5 as the dealer &mdash; the <strong>Down Payment</strong> card shows with the sanctioned amount and a working <strong>Collect Down Payment</strong> button.</li>
  <li>Click the button &mdash; Razorpay modal opens. Verify the amount displayed equals <code>loan_sanctions.down_payment</code>.</li>
  <li>Pay with the Razorpay <strong>test UPI</strong> (e.g. <code>success@razorpay</code>). Modal closes with success.</li>
  <li>Within ~5 s the UI shows <strong>PAID</strong>; the OTP dispatch card unlocks below it.</li>
  <li>Inspect <code>down_payments</code> table: row has <code>status='PAID'</code>, <code>razorpay_payment_id</code>, <code>razorpay_signature</code>, <code>payment_method='upi'</code>, <code>paid_at</code>.</li>
  <li>Inspect Razorpay Dashboard &rarr; Payments &mdash; the payment is captured with the receipt referencing our lead id.</li>
  <li>Trigger the negative path: pay with <code>failure@razorpay</code> &rarr; UI shows failure reason &rarr; dealer can retry.</li>
  <li>Idempotency test: replay the same webhook twice (curl with the captured signature) &mdash; second hit must be a no-op (no status flip, no duplicate row).</li>
</ol>

<h2>14. Out of scope for v1 (deferred)</h2>
<ul>
  <li><strong>Partial down payments / instalments.</strong> v1 collects the full <code>down_payment</code> amount in one go. If the customer needs to split, the admin re-sanctions with a smaller amount.</li>
  <li><strong>EMI on the down payment itself.</strong> Razorpay does support card EMI; toggle in checkout config once you confirm with finance.</li>
  <li><strong>Subscription / autopay for EMIs.</strong> Loan EMIs are handled via NBFC bank mandate / e-NACH, not Razorpay. Separate flow.</li>
  <li><strong>Dynamic QR fallback.</strong> If the modal isn&rsquo;t practical (e.g. customer not on the same device), we can add a Razorpay Payment Link or fresh UPI QR mode in v2. v1 ships with Checkout only.</li>
  <li><strong>Multi-currency.</strong> INR only.</li>
</ul>

<hr/>

<div class="small" style="text-align:center; margin-top:20pt; color:#94a3b8;">
  Generated by <code>scripts/build-razorpay-plan-pdf.mjs</code> &middot; ${today} &middot; iTarang engineering
</div>

</body>
</html>`;

const outDir = 'C:\\Users\\Aniket\\Downloads';
const outPdf = join(outDir, 'Razorpay-Integration-Plan.pdf');
const outHtml = join(outDir, 'Razorpay-Integration-Plan.html');

writeFileSync(outHtml, html, 'utf8');
console.log(`Wrote ${outHtml} (${html.length} bytes)`);

console.log('Launching puppeteer...');
const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.pdf({
        path: outPdf,
        format: 'A4',
        printBackground: true,
        margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
    });
    console.log(`Wrote ${outPdf}`);
} finally {
    await browser.close();
}
console.log('Done.');
