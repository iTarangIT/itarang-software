// Build a single-page Video KYC flow + implementation guide PDF.
// Reads the user's passive-flow screenshots + the active-error screenshot,
// inlines them as base64 data URIs, renders styled HTML, and writes PDF to
// C:\Users\Aniket\Downloads\Video-KYC-Flow.pdf

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SCREENSHOTS_DIR = 'C:\\Users\\Aniket\\OneDrive\\Pictures\\Screenshots';
const PASSIVE_IMAGES = [
    { file: `${SCREENSHOTS_DIR}\\Screenshot 2026-05-25 145828.png`, caption: 'Passive Video KYC — section visible on dealer Step 2 with a "Start Recording" CTA' },
    { file: `${SCREENSHOTS_DIR}\\Screenshot 2026-05-25 145844.png`, caption: 'Passive Video KYC — live in-page recorder using WebRTC (MediaRecorder)' },
    { file: `${SCREENSHOTS_DIR}\\Screenshot 2026-05-25 145908.png`, caption: 'Passive Video KYC — review & submit recorded clip before upload' },
    { file: `${SCREENSHOTS_DIR}\\Screenshot 2026-05-25 150100.png`, caption: 'Passive Video KYC — admin sees the recording + Decentro confidence on case-review' },
];
const ACTIVE_ERROR_IMAGE = {
    file: 'C:\\Users\\Aniket\\.claude\\image-cache\\11f13b2d-3541-411d-8c73-e4975f93c16e\\26.png',
    caption: 'Active Video KYC — current sandbox error after we converted the dealer page',
};

function toDataUri(path) {
    const buf = readFileSync(path);
    return `data:image/png;base64,${buf.toString('base64')}`;
}

const today = new Date().toISOString().slice(0, 10);

const passiveImagesHtml = PASSIVE_IMAGES.map((img, i) => `
<figure>
  <img src="${toDataUri(img.file)}" alt="Passive flow screenshot ${i + 1}" />
  <figcaption>${i + 1}. ${img.caption}</figcaption>
</figure>
`).join('\n');

const activeErrorHtml = `
<figure>
  <img src="${toDataUri(ACTIVE_ERROR_IMAGE.file)}" alt="Active Video Liveness error on sandbox" />
  <figcaption>${ACTIVE_ERROR_IMAGE.caption}</figcaption>
</figure>
`;

const html = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Video KYC — Flow & Implementation Guide</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  html, body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1f2937; line-height: 1.5; font-size: 11pt; }
  body { max-width: 100%; }
  h1 { font-size: 22pt; color: #0f172a; margin: 0 0 4pt; }
  h2 { font-size: 15pt; color: #0f172a; margin-top: 22pt; border-bottom: 2px solid #0047AB; padding-bottom: 4pt; }
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
  .callout strong { color: inherit; }
  figure { margin: 10pt 0 16pt; page-break-inside: avoid; }
  figure img { max-width: 100%; border: 1px solid #e5e7eb; border-radius: 6pt; }
  figcaption { font-size: 9pt; color: #64748b; margin-top: 4pt; font-style: italic; }
  .keyval { display: grid; grid-template-columns: 220px 1fr; gap: 4pt 10pt; font-size: 10pt; margin: 6pt 0 12pt; }
  .keyval dt { font-weight: 700; color: #475569; }
  .keyval dd { margin: 0; color: #0f172a; word-break: break-all; }
  hr { border: 0; border-top: 1px solid #e5e7eb; margin: 18pt 0; }
  .toc { background: #f8fafc; padding: 10pt 16pt; border-radius: 6pt; border: 1px solid #e5e7eb; }
  .toc ol { margin: 0; padding-left: 18pt; }
  .toc a { color: #1e40af; text-decoration: none; }
  .small { font-size: 9pt; color: #64748b; }
  .page-break { page-break-before: always; }
</style>
</head>
<body>

<h1>Video KYC — Flow &amp; Implementation Guide</h1>
<div class="subtitle">
  iTarang CRM &middot; Decentro Forensics integration &middot; Generated ${today}
</div>

<div class="toc">
  <strong>Contents</strong>
  <ol>
    <li>Two types of Video KYC at Decentro (passive vs active)</li>
    <li>Decentro Passive Video Liveness — spec &amp; our implementation</li>
    <li>Decentro Active Video Liveness — spec &amp; our implementation</li>
    <li>Differences between Passive and Active</li>
    <li>Current status of each in our system</li>
    <li>Active Liveness blocker &amp; Decentro support ticket</li>
    <li>How to check the endpoint yourself</li>
    <li>iTarang code references (files &amp; routes)</li>
  </ol>
</div>

<h2>1. Two Types of Video KYC at Decentro</h2>

<p>
  Decentro&rsquo;s <strong>Forensics</strong> module offers two distinct Video KYC products under the same
  <code>/v2/kyc/forensics/</code> URL family. They are <em>different SKUs</em> &mdash; an account can have one,
  both, or neither enabled.
</p>

<table>
  <thead>
    <tr>
      <th style="width: 18%">Aspect</th>
      <th style="width: 41%">Passive Video Liveness</th>
      <th style="width: 41%">Active Video Liveness</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Endpoint</td>
      <td><code>POST /v2/kyc/forensics/video_liveness</code></td>
      <td>
        <code>POST /v2/kyc/forensics/active_video_liveness/initiate</code><br/>
        <code>POST /v2/kyc/forensics/active_video_liveness/:decentro_transaction_id</code>
      </td>
    </tr>
    <tr>
      <td>Who captures the video</td>
      <td>We do, on the dealer&rsquo;s device (WebRTC + MediaRecorder), then upload the .webm file to Decentro</td>
      <td>Decentro hosts an interactive session on their own URL. The customer opens it on their phone &amp; follows on-screen prompts (blink, head turn, OTP utterance)</td>
    </tr>
    <tr>
      <td>Inputs we send</td>
      <td>Single short video file (multipart/form-data)</td>
      <td>JSON body with reference URLs (Aadhaar photo, passport photo as URLs/base64) &amp; redirect/callback URLs</td>
    </tr>
    <tr>
      <td>What Decentro returns</td>
      <td>Liveliness confidence (0.0&ndash;1.0)</td>
      <td>Per-image face match scores + audio match + liveliness + staticRisk + prerecordedRisk + geolocation</td>
    </tr>
    <tr>
      <td>Compliance grade</td>
      <td>Detects spoofing in the recorded clip</td>
      <td>Stronger; meets RBI V-CIP expectations &mdash; matches face against authoritative ID photos</td>
    </tr>
    <tr>
      <td>Cost per call</td>
      <td>Lower</td>
      <td>Higher</td>
    </tr>
    <tr>
      <td>Customer-facing UX</td>
      <td>Customer stands in front of dealer&rsquo;s camera; quick (3&ndash;8s)</td>
      <td>Customer receives SMS, opens link on own phone, completes ~30&ndash;60s guided session</td>
    </tr>
  </tbody>
</table>

<hr/>

<h2>2. Decentro Passive Video Liveness</h2>

<h3>2.1 API specification (from <code>docs.decentro.tech</code>)</h3>

<dl class="keyval">
  <dt>Endpoint</dt><dd><code>POST https://in.staging.decentro.tech/v2/kyc/forensics/video_liveness</code> (staging)<br/><code>POST https://in.decentro.tech/v2/kyc/forensics/video_liveness</code> (prod)</dd>
  <dt>Content-Type</dt><dd><code>multipart/form-data</code></dd>
  <dt>Auth headers</dt><dd><code>client_id</code>, <code>client_secret</code>, optional <code>module_secret</code> (Forensics module on our tier accepts without)</dd>
  <dt>Supported video formats</dt><dd><code>.mp4</code>, <code>.webm</code></dd>
  <dt>Max video size</dt><dd>20 MB</dd>
  <dt>Max video duration</dt><dd>10 seconds</dd>
  <dt>Min video resolution</dt><dd>800 &times; 600</dd>
</dl>

<h4>Request body parameters</h4>
<table>
  <thead>
    <tr><th>Field</th><th>Type</th><th>Required</th><th>Notes</th></tr>
  </thead>
  <tbody>
    <tr><td><code>reference_id</code></td><td>string</td><td>Yes</td><td>Unique per session, our own ID</td></tr>
    <tr><td><code>consent</code></td><td>boolean (string)</td><td>Yes</td><td>Send as <code>"true"</code></td></tr>
    <tr><td><code>consent_purpose</code></td><td>string</td><td>Yes</td><td>Free text purpose statement</td></tr>
    <tr><td><code>video</code></td><td>file</td><td>Conditional</td><td>multipart file upload OR&hellip;</td></tr>
    <tr><td><code>video_url</code></td><td>string</td><td>Conditional</td><td>&hellip;an HTTP URL to fetch</td></tr>
  </tbody>
</table>

<h4>Sample request (cURL)</h4>
<pre><code>curl --location --request POST 'https://in.staging.decentro.tech/v2/kyc/forensics/video_liveness' \\
--header 'client_id: &lt;your_client_id&gt;' \\
--header 'client_secret: &lt;your_client_secret&gt;' \\
--header 'module_secret: &lt;your_module_secret&gt;' \\
--form 'reference_id="02a05f79-4d10-47d6-89a9-6e5b54160e3e"' \\
--form 'consent="true"' \\
--form 'consent_purpose="for bank account purpose only"' \\
--form 'video=@"/path/to/file"' \\
--form 'video_url=""'</code></pre>

<h4>Sample response (SUCCESS)</h4>
<pre><code>{
  "decentroTxnId": "DECXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "status": "SUCCESS",
  "responseCode": "S00000",
  "message": "Liveliness check performed successfully",
  "data": {
    "status": "SUCCESS",
    "confidence": "1.0"
  },
  "responseKey": "success_liveness_check"
}</code></pre>

<h3>2.2 Our implementation in iTarang (passive — working)</h3>
<p>
  We shipped this first. End-to-end:
</p>
<ol>
  <li>Dealer hits <strong>Start Recording</strong> on the Step 2 KYC page.</li>
  <li>Browser opens camera+mic via <code>navigator.mediaDevices.getUserMedia()</code>, records a 3&ndash;8 s clip at 1280&times;720 (800&times;600 minimum) using <code>MediaRecorder</code>.</li>
  <li>Dealer reviews + submits. Front-end POSTs the blob to our server route.</li>
  <li>Server uploads to Supabase storage (<code>documents</code> bucket, video MIME types whitelisted via storage SQL).</li>
  <li>Server forwards the video to Decentro, persists a <code>kyc_verifications</code> row with <code>verification_type='video_kyc'</code>, <code>status='admin_review_pending'</code>, <code>match_score</code>, <code>api_response.video_url</code>.</li>
  <li>Admin opens <code>/admin/kyc-review/[leadId]</code> &rarr; <code>VideoKYCCard</code> plays the recording + shows Decentro confidence + Accept/Reject.</li>
</ol>

<h4>Required environment variables</h4>
<ul>
  <li><code>DECENTRO_BASE_URL</code> &mdash; e.g. <code>https://in.decentro.tech</code></li>
  <li><code>DECENTRO_CLIENT_ID</code></li>
  <li><code>DECENTRO_CLIENT_SECRET</code></li>
  <li><code>DECENTRO_MODULE_SECRET_FORENSICS</code> &mdash; optional, only if your Decentro tier requires it for Forensics. Our prod tier accepts without it.</li>
  <li><code>NEXT_PUBLIC_APP_URL</code> &mdash; public origin (e.g. <code>https://sandbox.itarang.com</code>) so storage URLs resolve.</li>
  <li>Supabase bucket <code>documents</code> with <code>allowed_mime_types</code> including <code>video/webm</code>, <code>video/mp4</code>, <code>video/quicktime</code>, <code>video/x-matroska</code> and <code>file_size_limit</code> &ge; 25 MiB. (One-time SQL ran via <code>scripts/update-documents-bucket-for-vkyc.mjs</code>.)</li>
</ul>

<h4>Screenshots of the live passive flow</h4>
${passiveImagesHtml}

<hr/>

<h2>3. Decentro Active Video Liveness</h2>

<h3>3.1 API specification (from Decentro docs)</h3>

<h4>Endpoint 1 &mdash; Initiate Session</h4>
<dl class="keyval">
  <dt>URL</dt><dd><code>POST /v2/kyc/forensics/active_video_liveness/initiate</code></dd>
  <dt>Content-Type</dt><dd><code>application/json</code></dd>
  <dt>Auth headers</dt><dd><code>client_id</code>, <code>client_secret</code></dd>
</dl>

<table>
  <thead>
    <tr><th>Field</th><th>Type</th><th>Notes</th></tr>
  </thead>
  <tbody>
    <tr><td><code>consent</code></td><td>boolean</td><td>Must be <code>true</code></td></tr>
    <tr><td><code>purpose</code></td><td>string</td><td>Free-form purpose</td></tr>
    <tr><td><code>reference_id</code></td><td>string</td><td>Unique per session</td></tr>
    <tr><td><code>redirect_url</code></td><td>string</td><td>Where Decentro redirects the customer&rsquo;s browser after the session</td></tr>
    <tr><td><code>callback_url</code></td><td>string</td><td>Server-to-server callback Decentro POSTs when results are ready</td></tr>
    <tr><td><code>face_image_urls</code></td><td>array&lt;string&gt;</td><td>Up to 4 image URLs to match against</td></tr>
    <tr><td><code>face_image_base64s</code></td><td>array&lt;string&gt;</td><td>Up to 4 base64-encoded images. Total of (urls + base64s) &le; 4.</td></tr>
  </tbody>
</table>

<h4>Sample initiate request</h4>
<pre><code>{
  "consent": true,
  "purpose": "Identity Verification",
  "reference_id": "UNIQUE_ID_12345",
  "redirect_url": "https://yourapp.com/redirect",
  "callback_url": "https://yourapp.com/callback",
  "face_image_urls": ["https://example.com/image1.jpg"],
  "face_image_base64s": ["base64_encoded_image1"]
}</code></pre>

<h4>Sample initiate response (SUCCESS)</h4>
<pre><code>{
  "decentroTxnId": "BC5CD047DB924564AD2B378F5B876963",
  "status": "SUCCESS",
  "responseCode": "S00000",
  "videoLivenessUrl": "https://yourapp.com/verify-video/BC5CD047DB924564AD2B378F5B876963"
}</code></pre>

<h4>Endpoint 2 &mdash; Get Video Liveness Data</h4>
<dl class="keyval">
  <dt>URL</dt><dd><code>POST /v2/kyc/forensics/active_video_liveness/:decentro_transaction_id</code></dd>
  <dt>Auth headers</dt><dd><code>client_id</code>, <code>client_secret</code></dd>
</dl>

<table>
  <thead>
    <tr><th>Field</th><th>Type</th><th>Notes</th></tr>
  </thead>
  <tbody>
    <tr><td><code>consent</code></td><td>boolean</td><td>Must be <code>true</code></td></tr>
    <tr><td><code>purpose</code></td><td>string</td><td>Same purpose string as initiate</td></tr>
    <tr><td><code>reference_id</code></td><td>string</td><td>Same reference_id as initiate</td></tr>
  </tbody>
</table>

<h4>Sample results response</h4>
<pre><code>{
  "decentroTxnId": "BC5CD047DB924564AD2B378F5B876963",
  "status": "SUCCESS",
  "responseCode": "S00000",
  "data": {
    "videoFaceMatchResults": [
      {
        "originalImage": "https://example.com/original_image1.jpg",
        "results": { "matchScore": 90, "covariance": 95 },
        "finalMatchImage": "https://example.com/matched_image1.jpg"
      }
    ],
    "audioMatchResults": { "matchScore": 80 },
    "staticRisk": "false",
    "prerecordedRisk": "false",
    "liveliness": "yes",
    "geoLocation": { "latitude": "12.9789808", "longitude": "77.6438327" }
  }
}</code></pre>

<h4>Response codes</h4>
<table>
  <thead>
    <tr><th>Response Key</th><th>Status</th><th>Meaning</th></tr>
  </thead>
  <tbody>
    <tr><td><code>success_liveness_check</code></td><td>SUCCESS</td><td>Image liveliness check successful</td></tr>
    <tr><td><code>error_invalid_image_source</code></td><td>FAILURE</td><td>Image may have been downloaded from another source</td></tr>
    <tr><td><code>error_empty_image</code></td><td>FAILURE</td><td>Empty image field</td></tr>
    <tr><td><code>error_consent_false</code></td><td>FAILURE</td><td>User consent required</td></tr>
    <tr><td><code>error_invalid_request</code> (<code>E00000</code>)</td><td>FAILURE</td><td><strong>Endpoint not provisioned on the account</strong> &mdash; this is the error we&rsquo;re currently getting</td></tr>
  </tbody>
</table>

<h3>3.2 Our implementation in iTarang (active &mdash; built, blocked at Decentro)</h3>
<ol>
  <li>Dealer hits <strong>Send Video KYC Link via SMS</strong> on the Step 2 KYC page.</li>
  <li>Server collects 1&ndash;4 face images: Aadhaar photo (<code>digilocker_transactions.aadhaar_extracted_data.photo_base64</code>) + passport photo URL (<code>kyc_documents.file_url</code> where <code>doc_type='passport_photo'</code>).</li>
  <li>Server calls Decentro Initiate &rarr; gets <code>videoLivenessUrl</code>.</li>
  <li>Server SMSes the URL to <code>lead.phone</code> via <code>sendKycSms()</code>.</li>
  <li>Customer opens the link on their phone, completes the interactive session (blink, head turn, OTP utterance).</li>
  <li>Decentro POSTs our <code>/callback</code> route &rarr; <code>kyc_verifications.status = 'admin_review_pending'</code>.</li>
  <li>Dealer page polls <code>/status</code> every 6 s &rarr; fetches full results from Decentro &rarr; persists per-image scores, risk flags, geolocation.</li>
  <li>Admin opens case-review &rarr; <code>ActiveVideoKYCCard</code> shows match table + risk chips + geolocation + Accept/Reject.</li>
</ol>

<h4>Required environment variables (additional to passive)</h4>
<ul>
  <li><code>NEXT_PUBLIC_APP_URL</code> must be the <strong>public origin</strong> Decentro can reach (e.g. <code>https://sandbox.itarang.com</code>). Otherwise the <code>callback_url</code> never resolves.</li>
  <li><code>SMS_PROVIDER</code> &mdash; <code>gupshup</code> (default) or <code>decentro</code>.</li>
  <li><code>DECENTRO_MODULE_SECRET_FORENSICS</code> &mdash; optional. Set only if Decentro support says your tier needs it for the Active SKU.</li>
</ul>

<h4>Current sandbox error</h4>
${activeErrorHtml}

<hr/>

<h2>4. Passive vs Active &mdash; Differences at a Glance</h2>
<table>
  <thead>
    <tr><th>&nbsp;</th><th>Passive</th><th>Active</th></tr>
  </thead>
  <tbody>
    <tr><td>Decentro SKU</td><td><code>video_liveness</code></td><td><code>active_video_liveness</code></td></tr>
    <tr><td>Who hosts the capture UI</td><td>iTarang (in-browser MediaRecorder)</td><td>Decentro (hosted page at <code>videoLivenessUrl</code>)</td></tr>
    <tr><td>Network calls (happy path)</td><td>1 server-to-server upload</td><td>1 initiate + 1 results-fetch + 1 inbound callback</td></tr>
    <tr><td>Customer device</td><td>Dealer&rsquo;s device (point-of-sale)</td><td>Customer&rsquo;s own phone (SMS link)</td></tr>
    <tr><td>Anti-spoof detection</td><td>Liveliness flag only</td><td>Liveliness + staticRisk + prerecordedRisk + audio match</td></tr>
    <tr><td>Face matching</td><td>No (only liveliness)</td><td>Yes &mdash; matches against Aadhaar / passport photos</td></tr>
    <tr><td>Result depth</td><td><code>confidence</code> (0&ndash;1)</td><td>Per-image scores + covariance + audio + risk flags + geolocation</td></tr>
    <tr><td>Submit-gate behaviour</td><td>Required for finance leads (working)</td><td>Required for finance leads (blocked &mdash; see &sect; 6)</td></tr>
  </tbody>
</table>

<hr/>

<h2>5. Current Status (sandbox.itarang.com, prod Decentro)</h2>

<table>
  <thead>
    <tr><th>Flow</th><th>Status</th><th>Notes</th></tr>
  </thead>
  <tbody>
    <tr>
      <td>Passive Video Liveness</td>
      <td><span class="pill pill-ok">Working</span></td>
      <td>Recording + upload + admin review verified end-to-end on sandbox. Decentro returns <code>confidence: 1.0</code> on good clips.</td>
    </tr>
    <tr>
      <td>Active Video Liveness</td>
      <td><span class="pill pill-bad">Blocked at Decentro</span></td>
      <td>Code is shipped and correct. Decentro returns <code>E00000 / error_invalid_request</code> because the Active SKU is not provisioned on our <code>client_id</code>.</td>
    </tr>
  </tbody>
</table>

<hr/>

<h2>6. Active Liveness Blocker &amp; Decentro Support Ticket</h2>

<div class="callout callout-bad">
  <strong>What we&rsquo;re seeing.</strong> Every call to
  <code>POST /v2/kyc/forensics/active_video_liveness/initiate</code> from our sandbox VPS (IP-whitelisted on Decentro, same credentials that make passive work) returns:
  <pre><code>HTTP 404
{
  "decentroTxnId": "&lt;assigned&gt;",
  "message": "Requested endpoint not found. Please check the endpoint and try again.",
  "responseCode": "E00000",
  "responseKey": "error_invalid_request",
  "status": "FAILURE"
}</code></pre>
</div>

<h3>6.1 What this means (plain English)</h3>
<ul>
  <li>Our app is calling the URL Decentro&rsquo;s docs say to call &mdash; verified.</li>
  <li>Decentro&rsquo;s gateway routes the request and even mints a <code>decentroTxnId</code> &mdash; proving auth &amp; IP allow-list pass.</li>
  <li>At the SKU layer, Decentro replies: &ldquo;your <code>client_id</code> is not allowed to use this endpoint.&rdquo;</li>
  <li>Analogy: a Netflix Basic account trying to play a 4K title. The site isn&rsquo;t broken &mdash; the plan just doesn&rsquo;t include that feature.</li>
</ul>

<h3>6.2 Who can resolve it</h3>
<ul>
  <li><strong>Only Decentro support</strong>. Nobody on the iTarang side &mdash; no code change, no env var, no permission change &mdash; can flip this on.</li>
  <li>Once they enable the Active SKU on our <code>client_id</code>, the same button in the dealer UI will work with <strong>zero code change</strong>.</li>
</ul>

<h3>6.3 Support ticket we sent to Decentro</h3>
<div class="callout callout-info">
  <strong>Status:</strong> Email sent to Decentro support. Awaiting their reply.<br/>
  <strong>Decentro URNs included for their lookup:</strong>
  <ul>
    <li><code>451A06315A52476A92928761FB623319</code> (sandbox button click)</li>
    <li><code>7FA1839F5C294AE684926E54F9FD60DB</code> (probe Attempt 1)</li>
    <li><code>5398FE945BB14FBFBE116C8A243D6F3F</code> (probe Attempt 3 with KYC module_secret &mdash; control)</li>
  </ul>
  <strong>Ask:</strong> Enable the Active Video Liveness SKU on our prod <code>client_id</code>. If a Forensics-scoped <code>module_secret</code> is needed, send it so we can set <code>DECENTRO_MODULE_SECRET_FORENSICS</code> on the VPS.
</div>

<h3>6.4 Interim options while we wait</h3>
<table>
  <thead>
    <tr><th>Option</th><th>What it does</th><th>When to pick</th></tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>Wait for Decentro</strong></td>
      <td>Leave the Active section in place. Finance leads remain blocked at the submit gate.</td>
      <td>Active Liveness is a non-negotiable RBI compliance requirement and short downtime is acceptable.</td>
    </tr>
    <tr>
      <td><strong>Roll back to passive</strong></td>
      <td>Remount the passive recorder + restore the <code>video_kyc</code> submit gate. Finance leads ship immediately. Swap back to Active when Decentro provisions it.</td>
      <td>Onboarding must keep moving today and passive (<code>video_liveness</code>) meets your current compliance bar.</td>
    </tr>
  </tbody>
</table>

<hr/>

<h2>7. How to check the endpoint yourself</h2>

<h3>7.1 Probe script (committed in repo)</h3>
<pre><code># On sandbox VPS, in the app dir:
git fetch origin Rushikesh-claude
git checkout FETCH_HEAD -- scripts/probe-decentro-active-liveness.mjs
node scripts/probe-decentro-active-liveness.mjs</code></pre>
<p class="small">
  The probe hits both Active endpoints (initiate + results-fetch) with three header combinations and prints HTTP status, headers, and raw body. Output makes it obvious whether Decentro is rejecting at the auth layer, the IP allow-list layer, or the SKU layer.
</p>

<h3>7.2 Single curl (no script)</h3>
<pre><code>source .env && curl -sS -i -X POST \\
  "https://in.decentro.tech/v2/kyc/forensics/active_video_liveness/initiate" \\
  -H "client_id: $DECENTRO_CLIENT_ID" \\
  -H "client_secret: $DECENTRO_CLIENT_SECRET" \\
  -H "Content-Type: application/json" \\
  -d '{"consent":true,"purpose":"test","reference_id":"PROBE-001",
       "redirect_url":"https://sandbox.itarang.com/return",
       "callback_url":"https://sandbox.itarang.com/callback",
       "face_image_base64s":["iVBORw0KGgo="]}'</code></pre>
<p class="small">
  Read the response body: <code>"status":"SUCCESS"</code> means the SKU is on; <code>"responseCode":"E00000"</code> means still not provisioned.
</p>

<h3>7.3 Just click the button</h3>
<p>
  In the dealer UI &mdash; once Decentro enables the SKU on their side, the same <strong>Send Video KYC Link via SMS</strong> button starts working with no further changes from us.
</p>

<hr/>

<h2>8. iTarang Code References</h2>

<h3>8.1 Passive Video Liveness files</h3>
<dl class="keyval">
  <dt>Decentro helper</dt><dd><code>src/lib/decentro.ts</code> &mdash; <code>videoLiveness()</code></dd>
  <dt>Dealer recorder UI</dt><dd><code>src/components/dealer-portal/lead-wizard/VideoKYCSection.tsx</code></dd>
  <dt>Dealer API route</dt><dd><code>src/app/api/kyc/[leadId]/decentro/video-liveness/route.ts</code></dd>
  <dt>Admin card UI</dt><dd><code>src/components/kyc/cards/VideoKYCCard.tsx</code></dd>
  <dt>Storage SQL (one-time)</dt><dd><code>scripts/update-documents-bucket-for-vkyc.mjs</code></dd>
</dl>

<h3>8.2 Active Video Liveness files</h3>
<dl class="keyval">
  <dt>Decentro helpers</dt><dd><code>src/lib/decentro.ts</code> &mdash; <code>activeVideoLivenessInitiate()</code>, <code>activeVideoLivenessResult()</code></dd>
  <dt>Face image collector</dt><dd><code>src/lib/kyc/active-vkyc-images.ts</code></dd>
  <dt>Dealer routes</dt><dd>
    <code>src/app/api/kyc/[leadId]/decentro/active-video-liveness/initiate/route.ts</code><br/>
    <code>src/app/api/kyc/[leadId]/decentro/active-video-liveness/status/route.ts</code><br/>
    <code>src/app/api/kyc/[leadId]/decentro/active-video-liveness/resend-sms/route.ts</code>
  </dd>
  <dt>Public callback &amp; return</dt><dd>
    <code>src/app/api/kyc/decentro/active-video-liveness/callback/route.ts</code><br/>
    <code>src/app/api/kyc/decentro/active-video-liveness/return/route.ts</code>
  </dd>
  <dt>Dealer section UI</dt><dd><code>src/components/dealer-portal/lead-wizard/ActiveVideoKYCSection.tsx</code></dd>
  <dt>Admin card UI</dt><dd><code>src/components/kyc/cards/ActiveVideoKYCCard.tsx</code></dd>
  <dt>Wired into</dt><dd>
    <code>src/app/(dashboard)/dealer-portal/leads/[id]/kyc/page.tsx</code><br/>
    <code>src/components/kyc/CaseReview.tsx</code><br/>
    <code>src/app/api/admin/kyc-reviews/route.ts</code><br/>
    <code>src/app/(dashboard)/admin/kyc-review/page.tsx</code>
  </dd>
  <dt>Diagnostic probe</dt><dd><code>scripts/probe-decentro-active-liveness.mjs</code></dd>
</dl>

<h3>8.3 Shared schema</h3>
<dl class="keyval">
  <dt>Table</dt><dd><code>kyc_verifications</code> (no migration; <code>verification_type</code> is plain varchar)</dd>
  <dt>verification_type values</dt><dd><code>video_kyc</code> (passive) &middot; <code>active_video_kyc</code> (active)</dd>
  <dt>api_response keys</dt><dd>Passive: <code>video_url</code>, <code>decentro</code>. Active: <code>decentro_txn_id</code>, <code>reference_id</code>, <code>video_liveness_url</code>, <code>face_image_sources</code>, <code>sms</code>, <code>callback_received_at</code>, <code>results</code></dd>
</dl>

<hr/>

<div class="small" style="text-align:center; margin-top:20pt; color:#94a3b8;">
  Generated by <code>scripts/build-vkyc-flow-pdf.mjs</code> &middot; ${today}
</div>

</body>
</html>`;

const outDir = 'C:\\Users\\Aniket\\Downloads';
const outPdf = join(outDir, 'Video-KYC-Flow.pdf');
const outHtml = join(outDir, 'Video-KYC-Flow.html');

// Write HTML alongside the PDF for fallback / re-printing
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
