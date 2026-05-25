// Public landing page Decentro browser-redirects the customer to after they
// finish their Active Video Liveness session. No DB writes here — the
// server-to-server /callback endpoint is the source of truth. This route's
// only job is to render a friendly "you're done, head back to the dealer"
// message so the customer's phone doesn't dead-end.

import { NextRequest, NextResponse } from 'next/server';

function htmlPage(opts: { ok: boolean; reason?: string }): string {
    const colour = opts.ok ? '#0a7d3b' : '#a32020';
    const heading = opts.ok ? 'Video Verification Complete' : 'Video Verification Incomplete';
    const detail = opts.ok
        ? 'Thanks! Please return to your dealer to finish the loan KYC.'
        : (opts.reason || 'Please return to your dealer — they\'ll help you re-record.');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Itarang — Video KYC</title>
<style>
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f7f8fb;color:#1f2937;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:20px;box-shadow:0 8px 30px rgba(0,0,0,0.04);padding:32px;max-width:380px;text-align:center}
  .badge{display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;font-size:12px;font-weight:700;background:${opts.ok ? '#ecfdf5' : '#fef2f2'};color:${colour};margin-bottom:18px}
  h1{margin:0 0 8px;font-size:20px;color:#0f172a}
  p{margin:0 0 12px;font-size:14px;color:#475569;line-height:1.5}
  .sub{font-size:12px;color:#94a3b8;margin-top:18px}
</style>
</head>
<body>
  <div class="card">
    <div class="badge">${opts.ok ? '✓ Submitted' : '! Try again'}</div>
    <h1>${heading}</h1>
    <p>${detail}</p>
    <div class="sub">You may close this window.</div>
  </div>
</body>
</html>`;
}

export async function GET(req: NextRequest) {
    const url = new URL(req.url);
    const status = (url.searchParams.get('status') || '').toUpperCase();
    const ok = status === 'SUCCESS' || status === '' || status === 'COMPLETED';
    return new NextResponse(htmlPage({ ok, reason: url.searchParams.get('message') || undefined }), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}
