#!/usr/bin/env node
// Post-pm2-start asset verification. Hits public routes on the running
// app, extracts every /_next/static reference from the served HTML, and
// requests each one. Fails the deploy if any asset is referenced
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
// Strategy: try HEAD first (cheap), and on 5xx fall back to a Range-GET
// for the first byte. Some Next.js 16 standalone builds return 500 on
// HEAD for specific turbopack chunks while serving GET correctly — we
// only treat the asset as broken when BOTH HEAD and GET fail, which
// matches real-user behavior (browsers issue GET).
//
// On failure, prints whether each broken asset is present on disk
// (.next/standalone/.next/static/...) with its mode + size so the deploy
// log surfaces the root cause without a second iteration.
//
// Usage:  PORT=3003 node scripts/verify-served-assets.js
//         PORT=3002 node scripts/verify-served-assets.js
// Stdlib only — runs in CI before project deps may be available.

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || "3003";
const HOST = "127.0.0.1";

// Public routes (no auth required). These are the entry points every
// real user lands on — if these chunks are reachable, the build is
// fundamentally serving correctly. Authenticated routes are skipped
// because we don't have a session to use.
const ROUTES = ["/", "/login"];

function request(method, urlPath, timeoutMs = 10000, extraHeaders) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path: urlPath,
        method,
        timeout: timeoutMs,
        headers: extraHeaders || {},
      },
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

// Probes whether the running server can actually serve `urlPath` the way
// a browser would. HEAD is cheap; on 5xx we retry with a single-byte GET
// because Next.js standalone has known cases where HEAD on certain
// turbopack-emitted chunks returns 500 while GET works. Browsers issue
// GET, so GET is the source of truth.
async function probe(urlPath) {
  try {
    const head = await request("HEAD", urlPath, 5000);
    if (head.status < 400) return { ok: true, status: head.status, method: "HEAD" };
    if (head.status >= 500) {
      try {
        const get = await request(
          "GET",
          urlPath,
          8000,
          { Range: "bytes=0-0" },
        );
        if (get.status < 400 || get.status === 416) {
          return { ok: true, status: get.status, method: "GET" };
        }
        return { ok: false, status: get.status, method: "GET", headStatus: head.status };
      } catch (e) {
        return { ok: false, status: "GET-err:" + e.message, method: "GET", headStatus: head.status };
      }
    }
    return { ok: false, status: head.status, method: "HEAD" };
  } catch (e) {
    return { ok: false, status: "HEAD-err:" + e.message, method: "HEAD" };
  }
}

// Maps a served URL like /_next/static/chunks/x.js back to the on-disk
// location the standalone server reads from, so failure output can say
// "file is/isn't there" without a second SSH round-trip.
function diskInfo(urlPath) {
  // urlPath always starts with /_next/static/... — strip leading slash
  const rel = urlPath.replace(/^\//, "");
  // Resolution order matches what Next.js standalone actually serves:
  //   1. .next/standalone/.next/static/... (production runtime root)
  //   2. .next/static/... (source the static-copy step copies from)
  // If standalone is missing it but source has it, the cp -r dropped it.
  const candidates = [
    path.join(".next", "standalone", rel.replace(/^_next\//, ".next/")),
    rel.replace(/^_next\//, ".next/"),
  ];
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      return {
        path: candidate,
        exists: true,
        mode: "0" + (stat.mode & 0o777).toString(8),
        size: stat.size,
      };
    } catch {
      // not at this candidate; try next
    }
  }
  return { path: candidates[0], exists: false };
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

  console.log("\nProbing " + referenced.size + " unique assets (HEAD, GET fallback on 5xx)...");
  const missing = [];
  for (const url of referenced) {
    const result = await probe(url);
    if (!result.ok) missing.push({ url, ...result });
  }

  if (missing.length > 0) {
    console.error(
      "\n❌ Missing or unservable assets (" + missing.length + "):",
    );
    for (const m of missing.slice(0, 30)) {
      const disk = diskInfo(m.url);
      const diskLabel = disk.exists
        ? "ON-DISK " + disk.path + " mode=" + disk.mode + " size=" + disk.size
        : "NOT-ON-DISK (looked at " + disk.path + ")";
      const headHint = m.headStatus ? " (HEAD=" + m.headStatus + ")" : "";
      console.error(
        "  " + m.method + "=" + m.status + headHint + "  " + m.url + "\n      " + diskLabel,
      );
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
