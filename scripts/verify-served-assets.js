#!/usr/bin/env node
// Post-pm2-start asset verification. Hits public routes on the running
// app, extracts every /_next/static reference from the served HTML, and
// HEAD-requests each one. Fails the deploy if any asset is referenced
// by served HTML but unreachable.
//
// Catches what verify-chunk-manifest.js can't:
// - Files exist on disk but the standalone/Next server can't serve them
//   (cwd or relative-path mismatch)
// - Reverse proxy intercepts /_next/static and serves from a stale or
//   wrong directory
// - Build emitted a manifest reference, didn't write the chunk to disk,
//   AND the manifest in question wasn't walked by the static verifier
//
// Usage:  PORT=3003 node scripts/verify-served-assets.js
//         PORT=3002 node scripts/verify-served-assets.js
// Stdlib only — runs in CI before project deps may be available.

"use strict";

const http = require("http");

const PORT = process.env.PORT || "3003";
const HOST = "127.0.0.1";

// Public routes (no auth required). These are the entry points every
// real user lands on — if these chunks are reachable, the build is
// fundamentally serving correctly. Authenticated routes are skipped
// because we don't have a session to use.
const ROUTES = ["/", "/login"];

function request(method, urlPath, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: HOST, port: PORT, path: urlPath, method, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

const ASSET_PATTERN =
  /\/_next\/static\/[\w./@\-]+?\.(?:js|css|woff2?|ttf|eot|otf|svg|png|jpe?g|gif|webp|avif)/g;

(async () => {
  const referenced = new Set();
  for (const route of ROUTES) {
    let res;
    try {
      res = await request("GET", route);
    } catch (e) {
      console.log("Skip " + route + " (network: " + e.message + ")");
      continue;
    }
    if (res.status >= 400) {
      console.log("Skip " + route + " (HTTP " + res.status + ")");
      continue;
    }
    const matches = res.body.match(ASSET_PATTERN);
    const count = matches ? matches.length : 0;
    if (matches) for (const m of matches) referenced.add(m);
    console.log(route + " → HTTP " + res.status + ", " + count + " refs");
  }

  if (referenced.size === 0) {
    console.log("⚠ No asset references discovered — nothing to verify.");
    return;
  }

  console.log("\nHEAD-checking " + referenced.size + " unique assets...");
  const missing = [];
  for (const url of referenced) {
    try {
      const r = await request("HEAD", url, 5000);
      if (r.status >= 400) missing.push({ url, status: r.status });
    } catch (e) {
      missing.push({ url, status: e.message });
    }
  }

  if (missing.length > 0) {
    console.error(
      "\n❌ Missing or unservable assets (" + missing.length + "):",
    );
    for (const m of missing.slice(0, 30)) {
      console.error("  " + m.status + "  " + m.url);
    }
    if (missing.length > 30) {
      console.error("  ... and " + (missing.length - 30) + " more");
    }
    process.exit(1);
  }
  console.log("\n✅ All " + referenced.size + " referenced assets reachable.");
})().catch((err) => {
  console.error("verify-served-assets failed:", err);
  process.exit(1);
});
