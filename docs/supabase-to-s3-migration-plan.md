# Supabase Storage → AWS S3 Migration Plan

Status: PLAN ONLY (no code changed). Target: move all object storage off Supabase
Storage onto AWS S3, with the AWS SDK (`@aws-sdk/client-s3`).

---

## 1. Bucket inventory (what's actually in use)

| Bucket | Visibility | What's stored in the DB | Served via | Code |
|---|---|---|---|---|
| `documents` | **public** | **Full public URL** (`https://<proj>.supabase.co/storage/v1/object/public/documents/...`) | direct URL | `src/lib/storage.ts`, `whatsapp/storage.ts` (default), dealer/coborrower/expenses/kyc upload routes |
| `private-documents` | **private** | relative `storage_path` | `createSignedUrl` (15 min) on demand | `documents/signed-url`, `cron/cleanup-leads` |
| `nbfc-documents` | **private** | `/nbfc-uploads/<key>` path | authenticated app route `/api/nbfc-uploads/[...path]` | `src/lib/nbfc/nbfc-storage.ts` |
| `call-recordings` | **public** | **Full public URL** | direct URL | `src/lib/ai/storage/recordingStore.ts` |

Plus env overrides already present: `WHATSAPP_DOCS_BUCKET` (→ `documents`),
`CONSENT_STORAGE_BUCKET` (→ `documents`), `CALL_RECORDINGS_PREFIX`.

**Key takeaway:** the two *private* buckets store **relative keys** → easy to migrate.
The two *public* buckets store **absolute Supabase URLs baked into DB rows** → these
are the real work (URL rewrite or proxy).

---

## 2. Operations to port (Supabase API → S3 SDK)

Every storage call in the codebase reduces to one of these. Build ONE abstraction
that covers them, then refactor callers to it.

| Supabase | AWS SDK v3 |
|---|---|
| `.from(b).upload(key, buf, {contentType, upsert})` | `PutObjectCommand` (S3 is upsert by default) |
| `.from(b).download(key)` → Blob | `GetObjectCommand` → stream → Buffer |
| `.from(b).getPublicUrl(key)` | construct `https://<bucket>.s3.<region>.amazonaws.com/<key>` or CloudFront URL |
| `.from(b).createSignedUrl(key, secs)` | `getSignedUrl(s3, new GetObjectCommand(...), {expiresIn})` from `@aws-sdk/s3-request-presigner` |
| `.from(b).remove([keys])` | `DeleteObjectsCommand` (or `DeleteObjectCommand` for one) |
| `.from(b).list(prefix)` | `ListObjectsV2Command` |
| `.listBuckets()` / `.createBucket()` | **drop** — provision buckets once via console/IaC, not at runtime (see `dealer/upload` which auto-creates) |

---

## 3. Recommended code structure

Create `src/lib/storage/s3.ts` — a single, server-only S3 client + helpers:

```
putObject(bucket, key, body, contentType, {cacheControl}) -> {key}
getObject(bucket, key) -> Buffer | null
signObject(bucket, key, expiresSec) -> string | null
removeObjects(bucket, keys) -> void
listObjects(bucket, prefix) -> string[]
publicUrl(bucket, key) -> string          // CloudFront or s3 URL
```

Backed by one `S3Client({ region: AWS_REGION, credentials })`. Use the same AWS
creds already in `.env.local` (you have `AWS_REGION`, the commented `AWS_S3_BUCKET`).

Then refactor in this order (smallest blast radius first):

1. **`src/lib/nbfc/nbfc-storage.ts`** — already a clean abstraction over `supabaseAdmin.storage`. Swap its 4 internals (`upload`/`download`/`createSignedUrl`) to call `s3.ts`. DB scheme (`/nbfc-uploads/<key>`) and the `/api/nbfc-uploads` route are **unchanged**. ← do this first as the proof-of-concept.
2. **`src/lib/storage.ts`** (`uploadFileToStorage`) — swap internals; change `getPublicUrl` → `publicUrl()`.
3. **`src/lib/whatsapp/storage.ts`** (`saveMedia`/`removeMedia`) — swap internals.
4. **`src/lib/ai/storage/recordingStore.ts`** — swap upload + getPublicUrl.
5. **~18 API routes calling `supabase.storage.from(...)` directly** — point them at `s3.ts`. Notable ones:
   - `documents/signed-url`, `cron/cleanup-leads` (private bucket: sign / remove)
   - `dealer/upload` — **delete the runtime `listBuckets`/`createBucket` block**
   - kyc/coborrower/expenses upload + `getPublicUrl` routes
   - `debug/storage` — rewrite or delete (uses `listBuckets`)

Full file list: see `grep "storage.from"` (21 files) + the 3 helpers.

---

## 4. Provisioning (one-time, AWS side)

- Create buckets. Either mirror names (`documents`, `private-documents`,
  `nbfc-documents`, `call-recordings`) or collapse to **one bucket + key prefixes**
  (`documents/...`, `nbfc/...`) — recommended, simpler IAM. Decide before coding.
- **Block Public Access ON** for everything. For the two formerly-public buckets,
  serve via **CloudFront (OAC)** or convert the app to use signed URLs. Do NOT make
  S3 objects world-readable if they contain KYC PII (the `documents` bucket does).
- IAM user/role with `s3:PutObject/GetObject/DeleteObject/ListBucket` on those ARNs.
- New env: `AWS_S3_BUCKET` (uncomment), optionally `AWS_S3_PUBLIC_BASE_URL`
  (CloudFront domain), reuse `AWS_REGION` + an access key/secret (or instance role on the VPS).
- CORS on the bucket if any browser uploads go direct (currently uploads are
  server-side via routes, so likely not needed).

---

## 5. Data copy strategy (move the bytes)

Two clean ways:

- **A. `rclone`** (recommended, least code): configure a Supabase S3-compat remote
  (Supabase exposes `https://<proj>.supabase.co/storage/v1/s3` with project S3
  access keys) and an AWS remote, then `rclone copy supa:bucket aws:bucket -P` per
  bucket. Re-run before cutover to catch deltas. Idempotent.
- **B. A Node backfill script** (`scripts/migrate-supabase-to-s3.mjs`) mirroring the
  existing `scripts/backfill-nbfc-uploads-to-supabase.mjs`: list each Supabase
  bucket → download → `PutObject` to S3. Slower but no extra tooling and easy to
  scope/log.

Preserve the exact key paths so relative-key buckets (`private-documents`,
`nbfc-documents`) need **zero DB changes**.

---

## 6. DB URL handling (the actual risk)

- `private-documents` + `nbfc-documents`: store relative keys/paths → **no DB change**.
  Just make `signObject` / the `/api/nbfc-uploads` route read from S3.
- `documents` + `call-recordings`: DB rows hold **absolute Supabase URLs**. Options:
  1. **Backfill UPDATE** — rewrite stored URLs from the Supabase prefix to the new
     CloudFront/S3 prefix (one SQL `UPDATE ... replace(url, oldPrefix, newPrefix)`
     per affected column). Need to enumerate every column holding such a URL first
     (lead documents, dealer docs, whatsapp media, expenses, call recordings, etc.).
  2. **Compatibility proxy** — add a `/api/files/[...path]` route that resolves old
     and new URLs, so you can migrate lazily without touching historical rows.
  - Recommendation: **(1) backfill** for a clean break; keep Supabase project
    read-only as a fallback for a grace period.
- Going forward, prefer storing **relative keys** (not absolute URLs) so the next
  backend swap is free. Optional but worth it while you're in here.

---

## 7. Rollout & rollback

1. Provision S3 + CloudFront + IAM; add env vars (don't remove Supabase ones yet).
2. Land `s3.ts` + refactor helpers/routes behind a flag
   (`STORAGE_BACKEND=supabase|s3`) so writes can flip without a redeploy.
3. `rclone` initial sync (bytes now in both places).
4. Deploy with `STORAGE_BACKEND=s3` to **sandbox**; verify upload + view +
   signed-url + nbfc-uploads + call recording playback end-to-end.
5. Final `rclone` delta sync → run DB URL backfill (item 6.1) → flip prod env.
6. **Rollback:** set `STORAGE_BACKEND=supabase` and (if backfill ran) restore the
   pre-backfill URL columns from the snapshot. Keep the Supabase bucket intact for
   N days before deleting.

Note migration drift discipline from CLAUDE.md: any DB URL backfill goes in a
**named idempotent `drizzle/E-XXX_*.sql`**, not `db:push`.

---

## 8. Effort estimate

- `s3.ts` + refactor `nbfc-storage` (PoC): ~0.5 day
- Remaining 2 helpers + ~18 routes: ~1–1.5 days
- Provisioning + rclone sync + verify on sandbox: ~0.5 day
- DB URL audit + backfill migration: ~0.5–1 day (depends how many columns hold absolute URLs)
- **Total: ~3–4 days**, dominated by the public-URL/DB-rewrite work, not the SDK swap.
