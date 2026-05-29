// One-shot: expand the Supabase `documents` bucket allowed_mime_types to
// include video formats so Video KYC recordings can upload. Idempotent.
// Run: node scripts/update-documents-bucket-for-vkyc.mjs

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

if (!url || !key) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
    process.exit(1);
}

const admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
});

const BUCKET = 'documents';
const VIDEO_TYPES = ['video/webm', 'video/mp4', 'video/quicktime', 'video/x-matroska'];
const FILE_LIMIT = 26214400; // 25 MiB

const before = await admin.storage.getBucket(BUCKET);
if (before.error) {
    console.error('getBucket failed:', before.error);
    process.exit(2);
}
console.log('Before:');
console.log('  public:', before.data.public);
console.log('  file_size_limit:', before.data.file_size_limit);
console.log('  allowed_mime_types:', before.data.allowed_mime_types);

const existing = Array.isArray(before.data.allowed_mime_types) ? before.data.allowed_mime_types : [];
const merged = Array.from(new Set([...existing, ...VIDEO_TYPES]));
const limit = Math.max(Number(before.data.file_size_limit) || 0, FILE_LIMIT);

const update = await admin.storage.updateBucket(BUCKET, {
    allowedMimeTypes: merged,
    fileSizeLimit: limit,
    public: before.data.public ?? true,
});

if (update.error) {
    console.error('updateBucket failed:', update.error);
    process.exit(3);
}
console.log('updateBucket OK');

const after = await admin.storage.getBucket(BUCKET);
if (after.error) {
    console.error('getBucket (after) failed:', after.error);
    process.exit(4);
}
console.log('After:');
console.log('  public:', after.data.public);
console.log('  file_size_limit:', after.data.file_size_limit);
console.log('  allowed_mime_types:', after.data.allowed_mime_types);

const ok = VIDEO_TYPES.every((t) => after.data.allowed_mime_types?.includes(t));
console.log(ok ? 'Bucket now allows all video MIME types.' : 'Bucket update did not contain all expected video MIME types.');
process.exit(ok ? 0 : 5);
