// One-shot diagnostic for Decentro Active Video Liveness.
// Hits BOTH endpoints (initiate + result) with valid-shape payloads,
// prints HTTP status + full raw body so we can see exactly what
// Decentro is rejecting.
//
// Run on the SAME environment where the real call fails:
//   - Locally:   node scripts/probe-decentro-active-liveness.mjs
//   - On VPS:    ssh -t ... 'cd /home/.../sandbox.itarang.com && node scripts/probe-decentro-active-liveness.mjs'
//
// Reads from .env (or .env.local) so it uses the exact creds the app uses.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadDotEnv(path) {
    if (!existsSync(path)) return false;
    const content = readFileSync(path, 'utf8');
    for (const raw of content.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = val;
    }
    return true;
}

const rootEnv = join(__dirname, '..', '.env');
const localEnv = join(__dirname, '..', '.env.local');
if (loadDotEnv(localEnv)) console.log(`Loaded ${localEnv}`);
else if (loadDotEnv(rootEnv)) console.log(`Loaded ${rootEnv}`);
else console.log('No .env or .env.local found — relying on shell env');

const BASE_URL = process.env.DECENTRO_BASE_URL || (
    process.env.NODE_ENV === 'production'
        ? 'https://in.decentro.tech'
        : 'https://in.staging.decentro.tech'
);
const CLIENT_ID = process.env.DECENTRO_CLIENT_ID;
const CLIENT_SECRET = process.env.DECENTRO_CLIENT_SECRET;
const MODULE_SECRET_FORENSICS = process.env.DECENTRO_MODULE_SECRET_FORENSICS;
const MODULE_SECRET_KYC = process.env.DECENTRO_MODULE_SECRET_KYC;

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('Missing DECENTRO_CLIENT_ID or DECENTRO_CLIENT_SECRET. Aborting.');
    process.exit(1);
}

console.log('\n=== Decentro creds in use ===');
console.log('BASE_URL:                       ', BASE_URL);
console.log('DECENTRO_CLIENT_ID:             ', CLIENT_ID ? `${CLIENT_ID.slice(0,4)}***${CLIENT_ID.slice(-4)}` : '(missing)');
console.log('DECENTRO_CLIENT_SECRET:         ', CLIENT_SECRET ? `${CLIENT_SECRET.slice(0,4)}***${CLIENT_SECRET.slice(-4)}` : '(missing)');
console.log('DECENTRO_MODULE_SECRET_FORENSICS:', MODULE_SECRET_FORENSICS ? 'set' : '(not set)');
console.log('DECENTRO_MODULE_SECRET_KYC:     ', MODULE_SECRET_KYC ? 'set' : '(not set)');

function genRef() {
    const ts = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
    return `PROBE-${ts}-${rand}`;
}

// 1x1 PNG transparent pixel, base64-encoded (smallest valid face_image_base64
// payload Decentro will accept the shape of — they won't *match* on it, but
// they'll route the request).
const TINY_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function probe(label, headers) {
    const ref = genRef();
    const body = {
        consent: true,
        purpose: 'Identity Verification',
        reference_id: ref,
        redirect_url: 'https://sandbox.itarang.com/api/kyc/decentro/active-video-liveness/return',
        callback_url: 'https://sandbox.itarang.com/api/kyc/decentro/active-video-liveness/callback',
        face_image_base64s: [TINY_PNG_BASE64],
    };
    const url = `${BASE_URL}/v2/kyc/forensics/active_video_liveness/initiate`;
    console.log(`\n=== ${label} ===`);
    console.log('POST', url);
    console.log('Headers (keys only):', Object.keys(headers));
    console.log('Body.reference_id:  ', ref);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', accept: 'application/json', ...headers },
            body: JSON.stringify(body),
        });
        const text = await res.text();
        console.log('HTTP status:', res.status);
        console.log('Response headers:');
        for (const [k, v] of res.headers.entries()) {
            console.log(`  ${k}: ${v}`);
        }
        console.log('Response body (raw, first 2KB):');
        console.log(text.slice(0, 2048));
        try {
            const json = JSON.parse(text);
            const verdict = json?.status === 'SUCCESS' && json?.videoLivenessUrl
                ? 'OK — Active Liveness is enabled on this account.'
                : json?.message
                    ? `Decentro rejected: ${json.message}${json.responseCode ? ` [responseCode=${json.responseCode}]` : ''}`
                    : 'Unexpected shape — no SUCCESS and no message field.';
            console.log('Verdict:', verdict);
        } catch {
            console.log('Verdict: Body was not JSON.');
        }
    } catch (err) {
        console.error('Network/fetch error:', err);
    }
}

// Try 3 header combinations to isolate where the rejection comes from:
//   1. client_id + client_secret only (what our route currently sends)
//   2. + module_secret = MODULE_SECRET_FORENSICS (if set)
//   3. + module_secret = MODULE_SECRET_KYC (won't work, but proves the
//      response wording differs from "endpoint not found")

await probe('Attempt 1: client_id + client_secret only', {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
});

if (MODULE_SECRET_FORENSICS) {
    await probe('Attempt 2: + DECENTRO_MODULE_SECRET_FORENSICS', {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        module_secret: MODULE_SECRET_FORENSICS,
    });
} else {
    console.log('\n=== Attempt 2: skipped (DECENTRO_MODULE_SECRET_FORENSICS not set) ===');
}

if (MODULE_SECRET_KYC) {
    await probe('Attempt 3 (control): + DECENTRO_MODULE_SECRET_KYC (expected to fail differently)', {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        module_secret: MODULE_SECRET_KYC,
    });
} else {
    console.log('\n=== Attempt 3 (control): skipped (DECENTRO_MODULE_SECRET_KYC not set) ===');
}

// ─── Probe the RESULTS endpoint too ────────────────────────────────────────
// /v2/kyc/forensics/active_video_liveness/:decentro_transaction_id
// Use an obviously fake txn id. If the SKU is provisioned, Decentro will say
// "transaction not found" or similar. If the SKU is unprovisioned, we'll get
// the same E00000 / "Requested endpoint not found" we got on initiate —
// proving the entire Active Liveness product line is not on this account.
async function probeResults(label, headers) {
    const fakeTxnId = 'PROBE000000000000000000000000FAKE';
    const ref = genRef();
    const body = {
        consent: true,
        purpose: 'Identity Verification Results',
        reference_id: ref,
    };
    const url = `${BASE_URL}/v2/kyc/forensics/active_video_liveness/${fakeTxnId}`;
    console.log(`\n=== ${label} ===`);
    console.log('POST', url);
    console.log('Headers (keys only):', Object.keys(headers));
    console.log('Body.reference_id:  ', ref);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', accept: 'application/json', ...headers },
            body: JSON.stringify(body),
        });
        const text = await res.text();
        console.log('HTTP status:', res.status);
        console.log('Response headers:');
        for (const [k, v] of res.headers.entries()) {
            if (/^(x-decentro|kong|x-ratelimit|content-type|content-length)/i.test(k)) {
                console.log(`  ${k}: ${v}`);
            }
        }
        console.log('Response body (raw, first 2KB):');
        console.log(text.slice(0, 2048));
        try {
            const json = JSON.parse(text);
            const code = json?.responseCode || '';
            const msg = (json?.message || '').toLowerCase();
            if (code === 'E00000' || msg.includes('requested endpoint not found')) {
                console.log('Verdict: SAME error as initiate — SKU is not provisioned account-wide.');
            } else if (msg.includes('not found') || msg.includes('invalid') || msg.includes('transaction')) {
                console.log('Verdict: DIFFERENT error — SKU is routed; "transaction not found" or similar is the expected response for a fake txn id, which means initiate failing with E00000 may be a separate, surprising bug.');
            } else {
                console.log(`Verdict: Other rejection — responseCode=${code} message="${json?.message}"`);
            }
        } catch {
            console.log('Verdict: Body was not JSON.');
        }
    } catch (err) {
        console.error('Network/fetch error:', err);
    }
}

await probeResults('Attempt 4: results-fetch endpoint with fake txn id', {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
});

console.log('\nDone.');
