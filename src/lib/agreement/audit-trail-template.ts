export type AuditSignerDetail = {
  sequence: number;
  displayName: string;
  email?: string | null;
  mobile?: string | null;
  requestedAt?: Date | string | null;
  signedAt?: Date | string | null;
  ip?: string | null;
  esp?: string | null;
  aspId?: string | null;
  browserName?: string | null;
  browserVersion?: string | null;
  osName?: string | null;
  osVersion?: string | null;
  device?: string | null;
  certifiedName?: string | null;
  activity?: string | null;
  documentHash?: string | null;
  photoHash?: string | null;
  signingMethod?: string | null;
  status?: string | null;
};

export type AuditTrailInput = {
  documentName: string;
  documentId: string;
  status: string;
  ownerName: string;
  ownerEmail: string;
  invitationIp?: string | null;
  signers: AuditSignerDetail[];
  completedAt?: Date | string | null;
  completionEmails?: string[];
  generatedAt?: Date;
};

function esc(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  // Digio format: 2026-04-17 14:05:33.0
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.0`;
}

function humanMethodActivity(method?: string | null): string {
  if (!method) return "Electronic Signing";
  const m = method.toLowerCase();
  if (m === "aadhaar_esign" || m === "aadhaar") return "Aadhaar Otp Signing";
  if (m === "dsc_signature" || m === "dsc") return "DSC Signing";
  return "Electronic Signing";
}

function browserSummary(s: AuditSignerDetail): string {
  const parts: string[] = [];
  if (s.browserName) {
    parts.push(`Name: ${s.browserName}${s.browserVersion ? ` /${s.browserVersion}` : ""}`);
  }
  if (s.osName) {
    parts.push(`OS: ${s.osName}${s.osVersion ? ` /${s.osVersion}` : ""}`);
  }
  if (s.device) parts.push(`Device: ${s.device}`);
  return parts.join(" ");
}

function signerCard(s: AuditSignerDetail): string {
  const activity = s.activity || humanMethodActivity(s.signingMethod);
  const isAadhaar = activity.toLowerCase().includes("aadhaar");
  const browser = browserSummary(s);

  const certRows: string[] = [];
  certRows.push(`<div><span class="k">Name:</span> <span class="v">${esc(s.certifiedName || s.displayName)}</span></div>`);
  certRows.push(`<div><span class="k">Activity:</span> <span class="v">${esc(activity)}</span></div>`);
  if (isAadhaar && s.documentHash) {
    certRows.push(`<div><span class="k">Document Hash:</span><div class="hash">${esc(s.documentHash)}</div></div>`);
  }
  if (isAadhaar && s.photoHash) {
    certRows.push(`<div><span class="k">Photo Hash:</span><div class="hash">${esc(s.photoHash)}</div></div>`);
  }

  const actionRows: string[] = [];
  actionRows.push(`<div class="signer-name">${s.sequence} . ${esc(s.displayName)}</div>`);
  if (s.email) actionRows.push(`<div class="muted">(${esc(s.email)})</div>`);
  actionRows.push(`<div><span class="k">Requested Date &amp; Time:</span> <span class="v">${esc(fmtDate(s.requestedAt))}</span></div>`);
  actionRows.push(`<div><span class="k">Signed Date &amp; Time:</span> <span class="v">${esc(fmtDate(s.signedAt))}</span></div>`);
  if (s.ip) actionRows.push(`<div><span class="k">IP:</span> <span class="v">${esc(s.ip)}</span></div>`);
  if (isAadhaar && s.esp) actionRows.push(`<div><span class="k">ESP:</span> <span class="v">${esc(s.esp)}</span></div>`);
  if (s.aspId) actionRows.push(`<div><span class="k">ASP ID:</span> <span class="v">${esc(s.aspId)}</span></div>`);
  if (browser) actionRows.push(`<div><span class="k">Browser Details:</span> <span class="v">${esc(browser)}</span></div>`);

  return `
  <div class="row">
    <div class="col action">
      ${actionRows.join("\n")}
    </div>
    <div class="col cert">
      ${certRows.join("\n")}
    </div>
  </div>`;
}

export function buildAuditTrailHtml(data: AuditTrailInput): string {
  const generatedAt = fmtDate(data.generatedAt || new Date());
  const signerBlocks = data.signers.map(signerCard).join("\n<div class='divider'></div>\n");
  const completionEmails = (data.completionEmails || []).map((e) => `(${esc(e)})`).join(", ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Audit Trail - ${esc(data.documentId)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #000; background: #fff; font-size: 12px; line-height: 1.4; }
  .page { padding: 26px 32px 60px; position: relative; min-height: 100vh; }
  .page + .page { page-break-before: always; }

  /* Header band */
  .header {
    background: #EEF2FA;
    border-radius: 4px;
    padding: 18px 22px;
    margin-bottom: 22px;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  }
  .header .digio-logo {
    color: #2563eb;
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.02em;
    margin-bottom: 4px;
  }
  .header h1 {
    color: #0f172a;
    font-size: 26px;
    margin: 0 0 6px;
    font-weight: 400;
  }
  .header .id {
    color: #64748b;
    font-size: 13px;
    letter-spacing: 0.01em;
  }
  .header .verify {
    text-align: right;
    font-size: 13px;
  }
  .header .verify .vtitle { color: #0f172a; font-size: 18px; margin-bottom: 4px; font-weight: 500; }
  .header .verify .scan { color: #64748b; font-size: 11px; margin-bottom: 6px; }
  .header .verify a { color: #2563eb; font-size: 11px; text-decoration: underline; }
  .qr {
    display: inline-block;
    width: 92px;
    height: 92px;
    background: #fff;
    border: 1px solid #cbd5e1;
    margin-top: 4px;
    position: relative;
    overflow: hidden;
  }
  .qr::before {
    content: "";
    position: absolute;
    inset: 8px;
    background-image:
      repeating-linear-gradient(90deg, #000 0 2px, transparent 2px 4px),
      repeating-linear-gradient(0deg,  #000 0 2px, transparent 2px 4px);
    opacity: 0.78;
  }

  /* Section titles */
  h2 {
    color: #0f172a;
    font-size: 16px;
    margin: 22px 0 12px;
    font-weight: 700;
  }

  /* Document details */
  .doc-details { font-size: 12.5px; margin-bottom: 8px; }
  .doc-details .line { display: flex; gap: 6px; margin-bottom: 4px; }
  .doc-details .lbl { font-weight: 700; min-width: 130px; }
  .doc-details .val { color: #334155; }
  .status-completed { color: #16a34a; font-weight: 700; letter-spacing: 0.02em; }

  /* Document history card */
  .history-card {
    border: 1px dashed #94a3b8;
    border-radius: 4px;
    padding: 14px 18px;
    margin-bottom: 14px;
    display: grid;
    grid-template-columns: 1fr 1.2fr;
    gap: 18px;
  }
  .history-card .owner .name { font-weight: 700; font-size: 13px; color: #0f172a; }
  .history-card .owner .email { color: #64748b; font-size: 11px; margin-top: 4px; }
  .history-card .activity .k { font-weight: 700; color: #0f172a; }
  .history-card .activity .v { color: #334155; }
  .history-card .activity div { margin-bottom: 3px; font-size: 12px; }

  /* Per-signer row */
  .row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 22px;
    padding: 14px 0 16px;
  }
  .row .col .k { font-weight: 700; color: #0f172a; }
  .row .col .v { color: #334155; }
  .row .col div { margin-bottom: 3px; font-size: 12px; word-break: break-word; }
  .row .col.cert {
    background: #F8FAFC;
    border-radius: 4px;
    padding: 14px 18px;
    align-self: flex-start;
  }
  .row .signer-name { font-size: 14px; font-weight: 700; color: #0f172a; margin-bottom: 2px; }
  .row .muted { color: #64748b; font-size: 11px; margin-bottom: 6px; }
  .row .hash { font-family: "Courier New", monospace; font-size: 10.5px; color: #334155; word-break: break-all; margin-top: 2px; }

  .divider { border-top: 1px dashed #cbd5e1; }

  .signers-group {
    border: 1px dashed #94a3b8;
    border-radius: 4px;
    padding: 0 18px;
  }

  .action-label {
    font-size: 14px;
    font-weight: 700;
    color: #0f172a;
    margin-bottom: 4px;
  }

  /* Footer */
  footer {
    position: absolute;
    bottom: 18px;
    left: 32px;
    right: 32px;
    border-top: 1px solid #cbd5e1;
    padding-top: 10px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 10px;
    color: #475569;
    line-height: 1.5;
  }
  footer .left a { color: #2563eb; text-decoration: underline; }
  footer .stamp {
    border: 1px solid #cbd5e1;
    padding: 6px 10px;
    font-size: 9px;
    color: #334155;
    line-height: 1.4;
    max-width: 260px;
  }
  footer .stamp .logo { color: #0f172a; font-weight: 700; font-size: 9px; }
</style>
</head>
<body>

<!-- Page 1: Header + Document Details + Document History + Signers -->
<div class="page">
  <div class="header">
    <div>
      <div class="digio-logo">digio</div>
      <h1>Audit Trail</h1>
      <div class="id">ID:${esc(data.documentId)}</div>
    </div>
    <div class="verify">
      <div class="vtitle">Verify Signature</div>
      <div class="scan">Scan QR<br/>or<br/><a href="#">Click Here</a></div>
      <div class="qr"></div>
    </div>
  </div>

  <h2>Document Details</h2>
  <div class="doc-details">
    <div class="line"><span class="lbl">Document Name:</span><span class="val">${esc(data.documentName)}</span></div>
    <div class="line"><span class="lbl">Status:</span><span class="val ${data.status.toUpperCase() === "COMPLETED" ? "status-completed" : ""}">${esc(data.status.toUpperCase())}</span></div>
  </div>

  <h2>Document History</h2>
  <div class="history-card">
    <div class="owner">
      <div class="name">${esc(data.ownerName)}(Owner)</div>
      <div class="email">(${esc(data.ownerEmail)})</div>
    </div>
    <div class="activity">
      <div><span class="k">Activity:</span> <span class="v">Signing Invitation Sent</span></div>
      ${data.invitationIp ? `<div><span class="k">IP:</span> <span class="v">${esc(data.invitationIp)}</span></div>` : ""}
    </div>
  </div>

  <div class="row" style="padding-bottom:6px;">
    <div class="col">
      <div class="action-label">Action Taken By</div>
    </div>
    <div class="col">
      <div class="action-label">Certification Details</div>
    </div>
  </div>

  <div class="signers-group">
    ${signerBlocks}
  </div>

  <footer>
    <div class="left">
      <div><strong>India's Largest Digital Signing Application</strong> |  <a href="http://www.digio.in">www.digio.in</a></div>
      <div>Digiotech Solutions Private Limited is a Registered Application Services Provider ("ASP") With</div>
      <div>Multiple CA ("Certifying Authority") ESPs ("eSign Provider")</div>
      <div>Under the Controller of Certifying Authorities ("CCA")</div>
      <div>For Queries : <a href="mailto:support@digio.in">support@digio.in</a></div>
    </div>
    <div class="stamp">
      <div>Signed by: <span class="logo">DS DIGIOTECH SOLUTIONS PRIVATE LIMITED 5</span></div>
      <div>Reason: Audit Trail Certification</div>
      <div>Date: ${esc(generatedAt)} IST</div>
    </div>
  </footer>
</div>

<!-- Page 2: Signing Complete -->
<div class="page">
  <div class="header">
    <div>
      <div class="digio-logo">digio</div>
      <h1>Audit Trail</h1>
      <div class="id">ID:${esc(data.documentId)}</div>
    </div>
  </div>

  <div class="history-card">
    <div class="owner">
      <div class="name">${esc(data.ownerName)}</div>
      <div class="email">(${esc(data.ownerEmail)})</div>
    </div>
    <div class="activity">
      <div><span class="k">Activity:</span> <span class="v">Signing Complete</span></div>
      ${data.completedAt ? `<div><span class="k">Date &amp; Time:</span> <span class="v">${esc(fmtDate(data.completedAt))}</span></div>` : ""}
      ${completionEmails ? `<div><span class="k">Email/Sms Sent to:</span> <span class="v">${completionEmails}</span></div>` : ""}
    </div>
  </div>

  <footer>
    <div class="left">
      <div><strong>India's Largest Digital Signing Application</strong> |  <a href="http://www.digio.in">www.digio.in</a></div>
      <div>Digiotech Solutions Private Limited is a Registered Application Services Provider ("ASP") With</div>
      <div>Multiple CA ("Certifying Authority") ESPs ("eSign Provider")</div>
      <div>Under the Controller of Certifying Authorities ("CCA")</div>
      <div>For Queries : <a href="mailto:support@digio.in">support@digio.in</a></div>
    </div>
    <div class="stamp">
      <div>Signed by: <span class="logo">DS DIGIOTECH SOLUTIONS PRIVATE LIMITED 5</span></div>
      <div>Reason: Audit Trail Certification</div>
      <div>Date: ${esc(generatedAt)} IST</div>
    </div>
  </footer>
</div>

</body>
</html>`;
}
