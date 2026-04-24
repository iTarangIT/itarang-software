#!/usr/bin/env node
// Fails the deploy if any chunk referenced by the build manifests is missing
// from .next/static. Catches the failure mode where a build emits a manifest
// that points at chunk files the build (or a subsequent step) didn't actually
// write to disk — which silently succeeds the deploy but 404s every page.
//
// Invoked from .github/workflows/deploy-*.yml. Must not rely on project
// dependencies (runs before any app boot) — stdlib only.

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = ".next";

const MANIFESTS = [
  "build-manifest.json",
  "app-build-manifest.json",
  "react-loadable-manifest.json",
];

const referenced = new Set();

function walk(value) {
  if (!value) return;
  if (typeof value === "string") {
    if (value.startsWith("static/chunks/") || value.startsWith("static/css/")) {
      referenced.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) walk(item);
  }
}

for (const name of MANIFESTS) {
  const p = path.join(ROOT, name);
  if (!fs.existsSync(p)) continue;
  try {
    walk(JSON.parse(fs.readFileSync(p, "utf8")));
  } catch (e) {
    console.error("Could not parse " + p + ": " + e.message);
  }
}

const missing = [];
for (const rel of referenced) {
  if (!fs.existsSync(path.join(ROOT, rel))) missing.push(rel);
}

console.log(
  "Manifest references " +
    referenced.size +
    " static files; " +
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
