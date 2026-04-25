#!/usr/bin/env node
// Fails the deploy if any chunk referenced anywhere in .next/ is missing
// from disk. Walks every JSON manifest and every text-format manifest
// (_buildManifest.js, _ssgManifest.js, etc.) — not just the three Next.js
// shipped historically — because Next.js 16 references chunks from many
// places (build-manifest, app-build-manifest, react-loadable-manifest,
// _buildManifest.js, next-font-manifest, route-level manifests, server-side
// manifests, etc.). A chunk can be referenced from any of those, missing
// from disk, and the deploy still appear successful — which 404s the
// browser at runtime and produces ChunkLoadError on real users.
//
// Invoked from .github/workflows/deploy-*.yml. Must not rely on project
// dependencies (runs before any app boot) — stdlib only.

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = ".next";

// Match any reference to a hashed asset under static/chunks, static/css,
// or static/media — no matter what manifest format it appears in (JSON
// values, JS string literals, etc.). Designed to be liberal: false
// positives just check existence of files that already exist; false
// negatives are what we're trying to eliminate.
const ASSET_PATTERN =
  /static\/(?:chunks|css|media)\/[\w./@\-]+?\.(?:js|css|woff2?|ttf|eot|otf|svg|png|jpe?g|gif|webp|avif|mp3|mp4|webm|ogg)/g;

const referenced = new Set();

function recordMatches(text) {
  if (!text) return;
  const matches = text.match(ASSET_PATTERN);
  if (matches) for (const m of matches) referenced.add(m);
}

function walkValue(value) {
  if (!value) return;
  if (typeof value === "string") {
    recordMatches(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkValue(item);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) walkValue(item);
  }
}

function scanFile(filepath) {
  let content;
  try {
    content = fs.readFileSync(filepath, "utf8");
  } catch {
    return;
  }
  // Try strict JSON parse first — covers structured manifests cleanly.
  if (filepath.endsWith(".json")) {
    try {
      walkValue(JSON.parse(content));
      return;
    } catch {
      // Fall through to text scan if JSON parse fails.
    }
  }
  // Text scan for non-JSON manifests (_buildManifest.js, _ssgManifest.js,
  // and any other manifest format that embeds chunk paths as JS strings).
  recordMatches(content);
}

function walkDir(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip the build cache (huge, irrelevant) and standalone (it has
      // its own static dir we don't verify here).
      if (entry.name === "cache") continue;
      if (entry.name === "standalone") continue;
      walkDir(full);
      continue;
    }
    // Scan manifest-shaped files: every .json, every Manifest.js variant,
    // BUILD_ID itself. Skip large chunk files — they're verified by
    // existence, not by parsing.
    if (
      entry.name.endsWith(".json") ||
      /Manifest\.js$/.test(entry.name) ||
      entry.name === "BUILD_ID"
    ) {
      scanFile(full);
    }
  }
}

walkDir(ROOT);

const missing = [];
for (const rel of referenced) {
  if (!fs.existsSync(path.join(ROOT, rel))) missing.push(rel);
}

console.log(
  "Walked .next/ manifests — found " +
    referenced.size +
    " asset references; " +
    missing.length +
    " missing on disk.",
);

if (missing.length > 0) {
  console.error("Missing:");
  const shown = missing.slice(0, 50);
  for (const m of shown) console.error("  " + m);
  if (missing.length > 50) {
    console.error("  ... and " + (missing.length - 50) + " more");
  }
  process.exit(1);
}

console.log("✅ All referenced assets exist on disk.");
