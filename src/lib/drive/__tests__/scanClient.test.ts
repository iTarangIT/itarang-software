/**
 * E-280 — the regression this file exists for:
 *
 *   Unexpected token '<', "<html> <h"... is not valid JSON
 *
 * That is what the CEO saw after pressing Scan Drive, because the app was
 * restarted under the open request and nginx answered with its own HTML error
 * page, which the page then handed to `.json()`. The message named neither the
 * cause nor the fact that two invoices had already been imported.
 *
 * No I/O: `fetch` is stubbed and the poll interval is driven by fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readJsonBody, readJsonData, startScanAndWait } from "../scanClient";

/** nginx's own error page, byte-for-byte in shape: bare <html>, CRLF endings. */
function nginxErrorPage(status: number): Response {
  return new Response(
    `<html>\r\n<head><title>${status} Bad Gateway</title></head>\r\n<body>\r\n<center><h1>${status}</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n`,
    { status, headers: { "content-type": "text/html" } },
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const summary = (over: Record<string, unknown> = {}) => ({
  run_id: "run-1",
  status: "success",
  folders_scanned: 1,
  files_seen: 148,
  files_new: 25,
  imported: 21,
  skipped_duplicate: 4,
  needs_attention: 0,
  unsupported: 0,
  failed: 0,
  duration_ms: 119_279,
  ...over,
});

describe("readJsonBody", () => {
  it("explains a gateway page instead of quoting its markup", async () => {
    const err = await readJsonBody(nginxErrorPage(502), "Scan failed").catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    // The whole point: no "Unexpected token", and the status is preserved.
    expect((err as Error).message).not.toMatch(/Unexpected token/);
    expect((err as Error).message).toContain("502");
    expect((err as Error).message).toMatch(/restarted/i);
  });

  it("says a timeout may still be working, because it may be", async () => {
    const err = await readJsonBody(nginxErrorPage(504), "Scan failed").catch((e: Error) => e);
    expect((err as Error).message).toMatch(/still be running/i);
  });

  it("prefers the API's own message when there is one", async () => {
    const err = await readJsonBody(
      jsonResponse({ success: false, error: { message: "FORBIDDEN" } }, 403),
      "Scan failed",
    ).catch((e: Error) => e);
    expect((err as Error).message).toBe("FORBIDDEN");
  });

  it("returns the whole envelope, and readJsonData the payload", async () => {
    expect(await readJsonBody(jsonResponse({ success: true, upserted: 3 }), "x")).toEqual({
      success: true,
      upserted: 3,
    });
    expect(await readJsonData(jsonResponse({ success: true, data: { a: 1 } }), "x")).toEqual({
      a: 1,
    });
  });
});

describe("startScanAndWait", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("follows a started scan to its result", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { status: "started", run_id: "run-1" } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: summary({ status: "running" }) }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: summary() }));

    const pending = startScanAndWait({
      scanEndpoint: "/api/scan",
      statusEndpoint: "/api/scan",
    });

    await vi.advanceTimersByTimeAsync(8_000);
    const result = await pending;

    expect(result.status).toBe("success");
    expect(result.imported).toBe(21);
    // Polls carry the run id, or a second scan's result could be reported here.
    expect(String(fetchMock.mock.calls[1][0])).toContain("run_id=run-1");
  });

  it("does not poll an endpoint that answered synchronously", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: summary() }));

    const result = await startScanAndWait({ scanEndpoint: "/api/expense-scan" });

    expect(result.imported).toBe(21);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a refused scan rather than waiting for it", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: summary({ status: "skipped", skipped_reason: "A sales scan is already running." }),
      }),
    );

    const result = await startScanAndWait({
      scanEndpoint: "/api/scan",
      statusEndpoint: "/api/scan",
    });

    expect(result.status).toBe("skipped");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("survives a single failed poll, gives up on a run of them", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { status: "started", run_id: "run-1" } }))
      .mockResolvedValueOnce(nginxErrorPage(502))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: summary({ status: "running" }) }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: summary() }));

    const pending = startScanAndWait({
      scanEndpoint: "/api/scan",
      statusEndpoint: "/api/scan",
    });
    await vi.advanceTimersByTimeAsync(12_000);

    expect((await pending).status).toBe("success");
  });

  it("stops with an actionable message when the server stops answering", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { status: "started", run_id: "run-1" } }),
    );
    fetchMock.mockResolvedValue(nginxErrorPage(502));

    const pending = startScanAndWait({
      scanEndpoint: "/api/scan",
      statusEndpoint: "/api/scan",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/Lost contact/);
    // Whatever it had already imported is not lost, and the message must say so.
    expect(result.error).toMatch(/press the button again/i);
  });
});
