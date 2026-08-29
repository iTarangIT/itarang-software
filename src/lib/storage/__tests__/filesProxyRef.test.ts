// parseFilesProxyRef — the inverse of filesProxyPath/filesProxyUrl.
//
// This is load-bearing rather than cosmetic. /api/files/[bucket]/[...path]
// requires a Supabase session for `call-recordings`, so any SERVER that fetches
// one of these URLs over HTTP gets 401 — it has no cookie. The re-analysis route
// uses this function to notice that a "URL" is really our own object and read it
// out of S3 instead. A regression here does not throw; it produces
// "could not be downloaded (HTTP 401)" on every re-hosted recording and reads
// like an outage.

import { describe, it, expect } from "vitest";

import { filesProxyPath, parseFilesProxyRef } from "../s3";

describe("parseFilesProxyRef", () => {
  it("round-trips a path produced by filesProxyPath", () => {
    const bucket = "call-recordings";
    const key = "attached/DL-mqow8iwc-764ad6f4/0f8c1b2e-1111-2222-3333-444455556666.mp3";

    expect(parseFilesProxyRef(filesProxyPath(bucket, key))).toEqual({ bucket, key });
  });

  it("round-trips a key whose segments needed encoding", () => {
    // Provider filenames really do arrive like this; filesProxyPath encodes each
    // segment, so the parse has to decode per-segment or the S3 lookup misses.
    const bucket = "call-recordings";
    const key = "elevenlabs/call recording (final) +91.mp3";

    expect(parseFilesProxyRef(filesProxyPath(bucket, key))).toEqual({ bucket, key });
  });

  it("accepts an absolute URL, not just a path", () => {
    // filesProxyUrl prefixes NEXT_PUBLIC_APP_URL when it is set, and that is the
    // form written into ai_call_logs.recording_url by the re-host.
    expect(
      parseFilesProxyRef("https://sandbox.itarang.com/api/files/call-recordings/x/y.mp3"),
    ).toEqual({ bucket: "call-recordings", key: "x/y.mp3" });
  });

  it("preserves nested key depth", () => {
    expect(parseFilesProxyRef("/api/files/documents/a/b/c/d.pdf")).toEqual({
      bucket: "documents",
      key: "a/b/c/d.pdf",
    });
  });

  it("returns null for a provider URL, which must be fetched normally", () => {
    expect(
      parseFilesProxyRef("https://storage.bolna.ai/recordings/abc123.wav"),
    ).toBeNull();
    expect(
      parseFilesProxyRef(
        "https://zziynfmqfvchkheqnqqr.supabase.co/storage/v1/object/public/call-recordings/x.mp3",
      ),
    ).toBeNull();
  });

  it("returns null for a bucket with no key", () => {
    expect(parseFilesProxyRef("/api/files/call-recordings")).toBeNull();
    expect(parseFilesProxyRef("/api/files/call-recordings/")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseFilesProxyRef(null)).toBeNull();
    expect(parseFilesProxyRef(undefined)).toBeNull();
    expect(parseFilesProxyRef("")).toBeNull();
  });

  it("returns null for an unrelated app route", () => {
    expect(parseFilesProxyRef("/api/ai-dialer/recording/conv_123")).toBeNull();
  });
});
