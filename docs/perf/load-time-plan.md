# CRM Page Load-Time Plan

Findings from a full-codebase performance audit (all 176 pages inventoried,
static analysis + production-build bundle measurement), the fixes shipped on
`claude/crm-load-testing-05ewb7`, and the follow-up roadmap.

Measurement tooling lives in `scripts/perf-audit/` — see [Tooling](#tooling).

## Round 2 — `claude/slow-loading-time-vrz3bd`

Picks up the [Follow-up roadmap](#follow-up-roadmap-highest-impact-first) below.
All seven round-1 fixes were verified still present on `main` before starting.

| # | Roadmap item | What shipped | Files |
|---|---|---|---|
| R1 | #1 Local JWT verify | `getUser()` → `getClaims()` in middleware. Was a Supabase **network round-trip on every request** — including every `/api/*` call, since the API early-exit sits *after* it, so a page firing 5 API calls paid the hop 6×. Now an in-process WebCrypto signature check against the cached JWKS. | `src/middleware.ts` |
| R2 | #3 Sidebar fetch | Dealer menu gating (`/api/dealer/stats`) seeded from a session snapshot, revalidated in background — the menu no longer renders incomplete on every hard navigation. | `src/components/layout/sidebar.tsx`, `src/lib/session-snapshot.ts` (new), `src/components/auth/AuthProvider.tsx` |
| R3 | #6 Self-host fonts | Dropped the render-blocking `fonts.googleapis.com` stylesheet + 2 preconnects; 6 woff2 files (104 KB total) now served from `public/fonts/` via `@font-face` in `globals.css`, with `<link rel=preload>` on the DM Sans latin subset only. | `src/app/layout.tsx`, `src/app/globals.css`, `public/fonts/*`, `next.config.ts` |
| R4 | *(not on the roadmap — found while verifying R3)* | **Every `_next/static` chunk was being served `no-store`.** The catch-all header rule overrode the immutable rule above it, so every content-hashed JS/CSS chunk was re-downloaded on **every navigation**. | `next.config.ts` |
| R5 | *(regression fix for R3)* | Excluded `fonts/` from the middleware matcher — moving fonts same-origin meant every woff2 started paying a full auth check it never paid on gstatic.com. | `src/middleware.ts` |

### R4 is probably the biggest single win here

This was not in the audit and was not something static analysis would have
caught — it only showed up under `curl -I` against a real production build:

```
$ curl -sSI localhost:3111/_next/static/chunks/<hash>.js
HTTP/1.1 200 OK
Cache-Control: no-store, must-revalidate     # ← from the /:path* catch-all
```

`next.config.ts` declares `/_next/static/:path*` → `max-age=31536000, immutable`
**first**, then `/:path*` → `no-store`. Next applies *every* matching entry and
the later one wins on a duplicate key, so the immutable rule was dead and the
config's own comment ("Static assets are content-hashed so they stay
long-cacheable") described behaviour that wasn't happening. Every repeat visit
and every hard navigation re-downloaded the entire JS bundle.

Both immutable rules are now protected by excluding their paths from the
catch-all (`/((?!fonts/|_next/static/).*)`) rather than relying on rule order.
Content-hashed filenames change whenever content changes, so this cannot serve
stale code — the anti-stale-deploy `no-store` only ever needed to cover HTML,
which it still does.

**Verify after deploy** — this is a one-line check and worth doing:
`curl -sSI https://<host>/_next/static/chunks/<any>.js | grep -i cache-control`
should now report `public, max-age=31536000, immutable`.

### Two things worth knowing

**R1's speedup is conditional.** `getClaims()` only verifies locally when the
Supabase project has **asymmetric JWT signing keys** enabled. On a project still
using the legacy symmetric (HS256) secret, the SDK internally falls back to a
`getUser()` round-trip — identical behaviour, zero speedup. The change is safe to
ship either way, but **the win requires rotating the project to asymmetric keys**
(Supabase Dashboard → Auth → JWT Keys). Verify with the TTFB numbers from
`npm run perf:audit`, not by assumption. There is a deliberate second property:
when there is no session at all, `getClaims()` returns null *without* an error and
we do **not** call `getUser()` — an unauthenticated request must not pay an extra
round-trip.

**R3 required a `next.config.ts` header fix to be a win at all.** The existing
catch-all `Cache-Control: no-store` on `/:path*` also matched `/fonts/*`, which
would have made the browser re-fetch every woff2 on every navigation — strictly
worse than the Google-hosted setup, which at least cached for a year. The
catch-all is now `/((?!fonts/).*)` with an explicit immutable rule for
`/fonts/:path*`, so precedence between overlapping rules never has to be
reasoned about.

### Corrections to the round-1 findings

- **framer-motion (roadmap #4) is not worth doing.** Re-measured: **8** import
  sites in total, and `ui/tabs` + `ui/stat-card` are imported by **3 files each**
  — not the "~75 import sites / lands on nearly every page" the original write-up
  assumed. Dropped from the roadmap.
- **The sidebar fires one badge fetch per user, not four.** All four
  (`/api/dealer/stats`, `/api/admin/nbfc/approvals/count`,
  `/api/it/security/events/count`, `/api/vendor/threads`) are role-gated, so any
  given user hits exactly one. Only the dealer one was worth snapshotting,
  because it gates *which menu items render*; the other three are cosmetic
  badges that can arrive late without the UI looking wrong.
- **`/api/it/security/events/count` polls every 20 s** (`setInterval`, sidebar).
  Intentional for a live-attack badge, but it is the only poll in the chrome and
  is worth knowing about when reading API traffic for the `it` role.

### Still open from the roadmap

#2 (sequential-await sweep on remaining fat API routes), #5 (`public/nbfc-uploads`
→ object storage, still 37 MB of the 39 MB `public/`), #7 (split the three giant
client pages — still 3,832 / 2,973 / 2,176 lines).

## What was shipped in round 1 (`claude/crm-load-testing-05ewb7`)

| # | Fix | Files | Expected effect |
|---|-----|-------|-----------------|
| 1 | CEO dashboard API: ~20 sequential DB round-trips → one `Promise.all` pass (signer counts chained off agreements). `sales_head` branch too. | `src/app/api/dashboard/[role]/route.ts` | `/api/dashboard/ceo` wall-clock ≈ slowest few queries instead of the sum of all 20 — roughly 4-5× faster |
| 2a | Middleware early-exit for `/api/*`, `/_next/*`, `/favicon.ico` right after the session refresh — skips role resolution and up to two Supabase `users` queries on every API call | `src/middleware.ts` | Lower TTFB on all API requests (most pages fire several on mount) |
| 2b | Hot-path `console.log` gated behind `MIDDLEWARE_DEBUG=1` | `src/middleware.ts` | Less log noise + per-request cost in prod |
| 2c | `/api/user/profile`: dropped its duplicate `auth.getUser()` (now shares one via `requireAuthWithSupabaseUser()`), and moved the `app_metadata` role-sync write into `after()` so it no longer blocks the response | `src/app/api/user/profile/route.ts`, `src/lib/auth-utils.ts` | The profile fetch that gates every page's first paint loses one Supabase round-trip + an inline admin write |
| 2d | `AuthProvider` hydrates from a sessionStorage snapshot and revalidates in the background instead of blocking every hard navigation on the profile fetch | `src/components/auth/AuthProvider.tsx` | Dashboard chrome renders immediately on repeat navigations |
| 3a | `xlsx` (~400 KB) moved from top-level imports to `await import()` inside the export/upload handlers | `src/components/inventory/InventoryList.tsx`, `src/app/(dashboard)/admin/upload/_components/UploadWizard.tsx` | Removed from `/inventory` and `/admin/upload` first-load JS |
| 3b | `recharts` chart component split behind `next/dynamic` (`charts.tsx` → wrapper, `charts-impl.tsx` → implementation) | `src/components/shared/charts.tsx` | Removed from the 8 dashboard pages that import `MetricsChart` |
| 3c | `country-state-city` (embedded world dataset) behind a lazy `useIndiaLocationData()` hook; pickers render disabled until it lands | `src/lib/location/useIndiaLocationData.ts`, `src/components/admin/nbfc/StateCityPicker.tsx`, `src/app/(dashboard)/dealer-portal/leads/new/page.tsx` | Removed from the dealer lead-wizard and NBFC-form first loads |
| 4 | Login hero image: 2,040,871-byte PNG → 63,528-byte WebP (resized 1266→1000 px wide) | `public/rickshaw-login.webp`, `src/app/(auth)/login/page.tsx` | −1.98 MB on the first screen every user hits (image optimizer is off: `images.unoptimized: true`) |

### Measured bundle impact (uncompressed route-specific JS, `npm run perf:bundle`)

Zero regressions across all 176 routes; total route-specific JS fell
**100.2 MB → 79.1 MB (−21%)**. Biggest movers:

| Route | Before | After | Δ |
|---|---:|---:|---:|
| /dealer-portal/leads/new | 8,950 KB | 488 KB | **−8,462 KB** (country-state-city) |
| /inside-sales/upload, /sales-insight/upload, /inventory/bulk-upload, /admin/upload, /inventory | ~770-925 KB | ~365-525 KB | −~400 KB each (xlsx) |
| /ceo, /ceo/invoices, /ceo/expenses, /ceo/ai-dialer, /nbfc/batteries, /risk-head/batteries, /sales-head/scraper*, /sales-manager/scraper-leads | ~765-925 KB | ~395-555 KB | −~371 KB each (recharts) |

(Wire size is ~3-4× smaller with gzip/brotli. Regenerate with
`npm run perf:bundle`; reports land in `perf-reports/`.)

## Why pages feel slow — the full diagnosis

### P0 — Auth waterfall on every page load (partially fixed)
Every authenticated page paid for auth **three times in series** before
becoming usable:

1. **Middleware** (`src/middleware.ts`) calls `supabase.auth.getUser()` — a
   network round-trip to Supabase — on essentially every request, plus up to
   two legacy `users`-table lookups when `app_metadata.role` is missing.
2. **AuthProvider** re-fetches `/api/user/profile` (no-store) on every mount.
3. **The profile route** called `auth.getUser()` *again* inside
   `requireAuth()` *and* a third time itself, plus 1-2 RDS reads and a
   possible synchronous Supabase-admin write.

Fixes 2a-2d removed the duplicate getUser, the blocking admin write, the
API-path role resolution, and the blocking profile fetch on repeat
navigations. **Still open:** the middleware getUser round-trip itself is
unavoidable with cookie-based Supabase SSR, but its latency can be cut by
verifying the JWT locally (`supabase.auth.getClaims()` with asymmetric JWT
signing keys) instead of a network call — worth a spike.

### P0 — Dashboard APIs with sequential, unbounded queries (CEO fixed; pattern exists elsewhere)
`/api/dashboard/ceo` ran ~20 queries back-to-back (fixed, Fix 1). The same
sequential-awaits pattern exists in other fat endpoints — grep for routes
with many `await db.select()` in a row. Also several aggregates scan whole
tables with no time bound (`inventory` SUM, `zoho_invoices` scans,
`provisions` scan, unbounded 3-table `leadAssignments` join). As tables grow
these degrade linearly. **Follow-up:** add time windows or materialized
rollups, and covering indexes for `invoice_date`, `status`,
`expense_submissions(status, approved_at)`.

### P1 — Heavy client libraries loaded eagerly (fixed for the top 3)
`next/dynamic` was used in exactly one file before this branch. xlsx,
recharts and country-state-city are now lazy (Fix 3). **Still open:**
- **framer-motion** is imported by the shared `ui/tabs.tsx` and
  `ui/stat-card.tsx` primitives → lands on nearly every page (~75 import
  sites). Replacing those two usages with CSS transitions would drop it from
  the shared bundle.
- Very large fully-client pages ship big JS regardless of libraries:
  `dealer-portal/leads/[id]/product-selection/page.tsx` (~3.6k lines),
  `admin/dealer-verification/[dealerId]/page.tsx` (~2.4k), `leads/page.tsx`
  (~2k). Splitting below-the-fold sections with `next/dynamic` is the lever.

### P1 — Images (login hero fixed; policy still open)
`images.unoptimized: true` disables all next/image resizing/format
conversion (deliberate). The 2 MB login PNG is fixed (Fix 4). **Still
open:** 16 raw `<img>` tags across 12 files get no optimization;
`public/nbfc-uploads/**` holds ~37 MB of runtime-uploaded PDFs committed
into the repo/build — they belong in object storage (S3/Supabase storage),
not the deploy artifact.

### P2 — Per-navigation chrome cost
- The whole `(dashboard)` group is `force-dynamic` and middleware sets
  `no-store` on all HTML — every navigation is a full SSR round-trip
  (deliberate anti-stale-deploy measure; revisit once deploys stamp a
  build-id cookie instead).
- `Sidebar` (~1.2k lines, client) fires its own on-mount fetches
  (`/api/dealer/stats`, `/api/admin/nbfc/approvals/count`) on top of the
  profile fetch on every hard navigation. Same sessionStorage-snapshot
  treatment as Fix 2d would remove the repeat cost.
- Root layout loads DM Sans/DM Mono via a render-blocking Google Fonts
  stylesheet (documented workaround: sandbox can't reach Google at build
  time, so `next/font` is off). Self-hosting the two font files in
  `public/fonts/` would remove the third-party critical-path request.

### P2 — Standalone/deploy size
`public/nbfc-uploads` (37 MB) plus the old 2 MB PNG inflate the standalone
output copied on every deploy. The PNG is gone; the uploads directory move
is the remaining win.

## Tooling

- **`npm run perf:audit`** — headless-Chromium sweep of every page in
  `scripts/perf-audit/pages.json` per role (ceo / dealer / sales_head /
  public), measuring TTFB, FCP, LCP, CLS, network-idle, transfer/JS bytes,
  request counts, 5 slowest `/api/*` calls, and console/JS/HTTP errors.
  Writes `perf-reports/<timestamp>/report.{json,md}` sorted worst-LCP-first.
  Targets `PERF_BASE_URL` (default sandbox). Needs `E2E_TEST_PASSWORD` (and
  optionally `E2E_CEO_EMAIL/PASSWORD`) in `.env.test.local` — same
  credentials as the existing Playwright e2e setup.
- **`npm run perf:inventory`** — regenerates `pages.json` from
  `src/app/**/page.tsx` (hand annotations survive).
- **`npm run perf:bundle`** — offline per-route First-Load-JS report from the
  build manifests; no credentials or network needed
  (`PERF_SKIP_BUILD=1` reuses an existing `.next`).

### Suggested cadence
Run `perf:bundle` in CI on PRs touching `src/` (fail on large regressions);
run `perf:audit` against sandbox weekly and diff the top-10 table.

## Follow-up roadmap (highest impact first)

1. **Verify middleware JWT locally** (`getClaims()` + asymmetric keys) to
   remove the per-request Supabase auth round-trip — biggest remaining TTFB
   lever on every page.
2. **Sweep remaining fat API routes** for the sequential-await pattern and
   apply the Fix-1 treatment; add time bounds/indexes to full-table
   aggregates.
3. **Sidebar badge fetches** → sessionStorage snapshot + background
   revalidate (mirror Fix 2d).
4. **framer-motion out of `ui/tabs`/`ui/stat-card`** → CSS transitions.
5. **Move `public/nbfc-uploads` to object storage**; add a lint/CI guard
   against committing binary uploads.
6. **Self-host the DM Sans/DM Mono fonts.**
7. **Split the 3 giant client pages** (product-selection, dealer-verification,
   leads) with `next/dynamic` below the fold.
