// One-shot test: upload a synthetic webm payload to the documents bucket and
// verify the public URL fetches back with the right Content-Type. Mirrors what
// the video-liveness route does for the storage portion.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadDotEnv(path) {
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
}

loadDotEnv(join(__dirname, '..', '.env.local'));

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('env missing'); process.exit(1); }

const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

// Smallest valid WebM/EBML header (just enough bytes for Supabase to accept).
// We're not playing it — only verifying upload + Content-Type round-trip.
const webmHeader = new Uint8Array([
    0x1A, 0x45, 0xDF, 0xA3, // EBML magic
    0x9F, // header size
    0x42, 0x86, 0x81, 0x01, // EBMLVersion
    0x42, 0xF7, 0x81, 0x01, // EBMLReadVersion
    0x42, 0xF2, 0x81, 0x04, // EBMLMaxIDLength
    0x42, 0xF3, 0x81, 0x08, // EBMLMaxSizeLength
    0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6D, // DocType "webm"
    0x42, 0x87, 0x81, 0x02, // DocTypeVersion
    0x42, 0x85, 0x81, 0x02, // DocTypeReadVersion
]);

const path = `kyc/_vkyc_storage_probe/${Date.now()}.webm`;
const upload = await admin.storage.from('documents').upload(path, webmHeader, {
    contentType: 'video/webm',
    upsert: true,
});
if (upload.error) {
    console.error('upload failed:', upload.error);
    process.exit(2);
}
console.log('upload OK ->', upload.data?.path);

const { data: pub } = admin.storage.from('documents').getPublicUrl(path);
const publicUrl = pub.publicUrl;
console.log('publicUrl:', publicUrl);

const res = await fetch(publicUrl, { method: 'GET' });
console.log('GET status:', res.status);
console.log('GET content-type:', res.headers.get('content-type'));
console.log('GET content-length:', res.headers.get('content-length'));
const body = new Uint8Array(await res.arrayBuffer());
console.log('GET body bytes:', body.length, '(expected', webmHeader.length, ')');

const ok = res.status === 200 && (res.headers.get('content-type') || '').includes('video/webm') && body.length === webmHeader.length;

// Clean up the probe file
const del = await admin.storage.from('documents').remove([path]);
if (del.error) console.warn('cleanup warn:', del.error.message);
else console.log('cleanup OK');

console.log(ok ? 'PASS — bucket accepts video/webm and serves it publicly.' : 'FAIL — see above.');
process.exit(ok ? 0 : 3);
