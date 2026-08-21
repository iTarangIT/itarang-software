# Google Drive backup — setup guide (E-255)

Every document the CRM stores in S3 is also copied to Google Drive, filed under
category folders. This is what has to be configured on the Google side, once,
by a Workspace admin of `itarang.com` (the `it@itarang.com` account is one).

Facts you will need:

| | |
|---|---|
| Service account (does the uploading) | `tarang-sheets@itarang.iam.gserviceaccount.com` |
| Its OAuth client ID (for domain-wide delegation) | `116559561386268967227` |
| Google Cloud project | `itarang` (project number `383712038783`) |
| Scope to authorise | `https://www.googleapis.com/auth/drive` |
| CRM settings page | `/admin/settings/gdrive-mirror` (Settings → Drive Backup) |

## Why there is a Google-side step at all

A service account has **no Drive storage of its own**. If you just share a
folder with it and let it upload, Google answers
`Service Accounts do not have storage quota`. So the uploads must be made
*as* a real Workspace user (Option A) or into a Shared Drive (Option B).

## Step 0 — fix the storage warning

Drive shows *"Organization storage full — your organization exceeded its 0 bytes
of Google Workspace storage"*. Until that is resolved, uploads by anyone in the
org fail no matter what. In the Admin console → Billing / Storage: buy or
assign a plan that includes pooled storage (the corpus is ~1.5 GB on sandbox;
production is smaller). The CRM keeps retrying automatically, so this can be
fixed after the rest is configured — the backlog drains once quota exists.

## Option A (recommended) — domain-wide delegation, files owned by it@itarang.com

1. Sign in as `it@itarang.com` → **Admin console** (`admin.google.com`).
2. **Security → Access and data control → API controls → Manage Domain Wide
   Delegation → Add new**.
3. Client ID: `116559561386268967227`
   OAuth scopes: `https://www.googleapis.com/auth/drive`
   → **Authorize**.
4. In Drive (as `it@itarang.com`) → **My Drive → New → New folder** →
   name it `iTarang CRM Backup`. Open it and copy the URL
   (`https://drive.google.com/drive/folders/<id>`).
5. In the CRM: **Settings → Drive Backup**
   - tick *Back up every stored document to Google Drive*
   - Root folder: paste the URL from step 4
   - Act as Workspace user: `it@itarang.com`
   - **Save**, then **Test connection**. Expected:
     `Connected. Uploads will land in "iTarang CRM Backup" as it@itarang.com.`
   If it says `unauthorized_client`, step 3 has not propagated yet (allow up to
   ~10 minutes) or the client ID / scope is wrong.
6. Click **Backfill everything in S3**. The sweep uploads in the background
   (25 files a minute per process; ~1.5 GB / 6,500 files takes a few hours).
   New uploads from now on are mirrored within seconds.

## Option B — Shared Drive (no delegation; needs a Workspace edition with Shared Drives)

1. Drive → **Shared drives → New** → `iTarang CRM Backup`.
2. Open it → **Manage members → add** `tarang-sheets@itarang.iam.gserviceaccount.com`
   as **Content manager**.
3. Copy the Shared Drive URL (`https://drive.google.com/drive/folders/<id>` — a
   Shared Drive root has an id like a folder).
4. CRM → Settings → Drive Backup: root folder = that URL, leave *Act as
   Workspace user* **empty**, Save → Test connection → Backfill.

## What the backup looks like in Drive

Only these categories are backed up (allow-list in
`src/lib/storage/drive-mirror-layout.ts` → `DRIVE_MIRROR_INCLUDED_FOLDERS`,
decided 2026-08-19):

```
iTarang CRM Backup/
├── KYC Documents/            one sub-folder per lead (LEAD-2026…)
├── Lead Documents/           other per-lead files (Step-4 pre-sanction bucket, requested docs)
├── WhatsApp Uploads/
├── Dealer Onboarding/        one sub-folder per document type:
│   ├── Upload GST Certificate/, Upload Company PAN/, 4 Undated Cheques/,
│   ├── Last 3 Years Company Income Tax Returns ITR/, Last 3 Months Company Bank Statement/,
│   ├── Passport Size Photograph/, Udyam Registration Certificate/, MOU…/, AOA…/, …
├── Dealer Agreements/        Digio-signed agreements + audit trails
│   ├── Templates/
│   └── Manually uploaded/
└── NBFC/
    ├── Agreements/
    └── Onboarding & Compliance/<nbfc id>/
```

**Not backed up** (no ledger row is ever created, and anything queued before
the rule is purged on the next sweep): Quotations, Expenses, Battery Auction,
Battery Buyback, Private Documents, Lead autofill scans, Dealer visit photos,
NBFC Field Investigation, NBFC Video KYC, Call Recordings, and any object that
matches no layout rule. The settings page shows the full table with a
"Backed up?" column. To add a category, append its folder path to
`DRIVE_MIRROR_INCLUDED_FOLDERS` and click **Backfill everything in S3**.

Layout rules (which folder an object goes to) live in the same file. Adding a
rule affects files uploaded after the change (existing Drive files are updated
in place, not moved).

## Operating it

- **Status page** shows Backed up / Waiting / Failed counts, the last 10
  failures with Google's reason, and links to recently backed-up files.
- **Retry failed now** resets the backoff clock (failures otherwise retry
  automatically: 1 min → 2 → 4 … capped at 6 h, forever).
- **Backfill everything in S3** is safe to click any time; it only adds rows for
  objects with none. The ticker also re-scans S3 every 6 h on its own.
- Deleting a file from the CRM does **not** delete the Drive copy (it is a
  backup); the ledger marks it *Deleted in S3*.
- Nothing in the CRM reads from Drive. Turning the feature off stops uploads
  and nothing else.

## Environment / migration

- Migration `drizzle/E-255_storage_drive_mirror.sql` (`node scripts/apply-e255.mjs`) —
  applied to sandbox 2026-08-19; apply to production before/with the deploy.
- Optional env fallbacks: `GDRIVE_MIRROR_ENABLED`, `GDRIVE_MIRROR_ROOT_FOLDER_ID`,
  `GDRIVE_MIRROR_IMPERSONATE` (values saved on the settings page win).
- Verifier: `node --import tsx --env-file=.env.local scripts/_verify-e255-gdrive-mirror.ts <folderUrl> it@itarang.com`
