import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { getHostingerConfig, hostingerGet, HostingerApiError } from "../client";

/**
 * The client is the only module that reads HOSTINGER_*, so three things must hold
 * no matter what:
 *
 *   · the token never appears anywhere except the Authorization header — a leak
 *     into a URL would land it in access logs and browser history;
 *   · a Hostinger 401 must NOT surface to the browser as a 401. Our token being
 *     wrong is a server misconfiguration; passing it through would tell the CRM
 *     user they are logged out, sending them to re-auth over a problem no login
 *     can fix;
 *   · array params must serialise as repeated `key[]=` — the documented API's
 *     include / product_ids / status filters are all arrays, and a comma-joined
 *     value is silently ignored rather than rejected.
 */

const ENV = {
  HOSTINGER_STORE_ID: "store_TEST123",
  HOSTINGER_API_TOKEN: "fake-token-for-tests",
  HOSTINGER_SALES_CHANNEL_ID: "scha_TEST",
};

const BASE = "https://developers.hostinger.com/api/ecommerce/v1/stores/store_TEST123";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}
function fail(status: number, body = '{"correlation_id":"abc-123"}') {
  return { ok: false, status, json: async () => JSON.parse(body), text: async () => body };
}

describe("getHostingerConfig", () => {
  it("names the missing variables without revealing any value", () => {
    vi.stubEnv("HOSTINGER_API_TOKEN", "");
    try {
      getHostingerConfig();
      throw new Error("expected a throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("HOSTINGER_API_TOKEN");
      expect(msg).not.toContain(ENV.HOSTINGER_API_TOKEN);
    }
  });

  it("does NOT require HOSTINGER_ECOMMERCE_API_URL", () => {
    // It addressed the old undocumented host and is unused since Phase 4C.
    // Requiring it would fail requests over a value nothing reads.
    vi.stubEnv("HOSTINGER_ECOMMERCE_API_URL", "");
    expect(() => getHostingerConfig()).not.toThrow();
  });

  it("strips surrounding quotes from values", () => {
    vi.stubEnv("HOSTINGER_STORE_ID", '"store_TEST123"');
    expect(getHostingerConfig().storeId).toBe("store_TEST123");
  });
});

describe("hostingerGet", () => {
  it("builds the documented /stores/{id} path and keeps the token out of the URL", async () => {
    fetchMock.mockResolvedValue(ok({ data: [], meta: {} }));
    await hostingerGet("/products", { page: 1 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/products?page=1`);
    expect(url).not.toContain(ENV.HOSTINGER_API_TOKEN);
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe(`Bearer ${ENV.HOSTINGER_API_TOKEN}`);
  });

  it("serialises arrays as repeated key[] params", async () => {
    fetchMock.mockResolvedValue(ok({ data: [], meta: {} }));
    await hostingerGet("/products", { page: 1, include: ["variants", "media"] });

    expect(fetchMock.mock.calls[0][0]).toBe(
      `${BASE}/products?page=1&include%5B%5D=variants&include%5B%5D=media`,
    );
  });

  it("omits undefined params rather than sending the string 'undefined'", async () => {
    fetchMock.mockResolvedValue(ok({}));
    await hostingerGet("/products", { page: 1, q: undefined });

    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/products?page=1`);
  });

  it("maps a Hostinger 401 to 502 so it never reads as a CRM auth failure", async () => {
    fetchMock.mockResolvedValue(fail(401));
    await expect(hostingerGet("/products")).rejects.toMatchObject({ status: 502 });
  });

  it("passes 404 through and keeps 429 as 429", async () => {
    fetchMock.mockResolvedValue(fail(404));
    await expect(hostingerGet("/products")).rejects.toMatchObject({ status: 404 });

    fetchMock.mockResolvedValue(fail(429));
    await expect(hostingerGet("/products")).rejects.toMatchObject({ status: 429 });
  });

  it("captures the correlation id but never forwards the upstream body", async () => {
    fetchMock.mockResolvedValue(fail(500, '{"correlation_id":"abc-123","message":"upstream detail"}'));
    await expect(hostingerGet("/products")).rejects.toSatisfy(
      (e: HostingerApiError) =>
        e.correlationId === "abc-123" && !e.message.includes("upstream detail"),
    );
  });

  it("surfaces a timeout as 504", async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
    await expect(hostingerGet("/products")).rejects.toMatchObject({ status: 504 });
  });
});
