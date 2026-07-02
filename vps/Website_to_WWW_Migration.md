# Migrating `website.itarang.com` → `www.itarang.com`

## 2. What I found first (why it wasn't a simple rename)

- `website.itarang.com` is a **Next.js app** on our VPS (CloudPanel reverse-proxy site → the app on port `3004`, run by PM2).
- `www.itarang.com` was pointing at a **different Hostinger site** (their CDN), not our VPS — so I had to move it, not just rename anything.
- The app was **already written for `www.itarang.com`** (sitemap, robots, canonical links). So no code change, no rebuild — only DNS + web-server + SSL work.

## 3. How I did it

1. **Staged the new site first (no impact yet).** Added a `www.itarang.com` site on the VPS pointing at the *same* running app, so nothing went live until DNS moved. Cleaned out an extra apex/`www1` block CloudPanel auto-added that would have broken the SSL step.
2. **Pointed the domain to us.** In Hostinger's DNS, replaced the old `www` record with an **A record → `72.61.246.37`** (verified it propagated on Hostinger + Google + Cloudflare).
3. **Secured it.** Issued a **Let's Encrypt certificate for `www.itarang.com`** and set it to **auto-renew**.
4. **Redirected the old address.** Turned `website.itarang.com` into a permanent **301 redirect** to `www.itarang.com` (keeping its own certificate valid so the redirect is always served securely).

## 4. Result (verified)

- `https://www.itarang.com` → **live**, valid certificate, our site. ✅
- `https://website.itarang.com` → **301 redirects** to `www` (keeps every old link working). ✅
- App untouched and online; auto-renewal tested and passing. ✅

## 5. Safety & rollback

Nothing was removed — the old site, app, and certificate all remain, and I backed up every config
before changing it. Reverting is just restoring those backups and pointing the `www` DNS record back.

**Out of scope:** the bare `itarang.com` still lives on Hostinger shared hosting — untouched. It can be
pointed to `www` later as a separate small change if we want.

**One follow-up:** update external links, Google Search Console, and ad/social profiles to `www.itarang.com`.
The 301 handles this automatically, but pointing them directly is cleaner for SEO.
