import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { getHostingerConfig, hostingerGet, HostingerApiError } from "../client";

/**
 * The client is the only module that reads HOSTINGER_*, so two things must hold
 * no matter what:
 *
 *   · the token never appears anywhere except the Authorization header — a leak
 *     into a URL would land it in access logs and browser history;
 *   · a Hostinger 401 must NOT surface to the browser as a 401. Our token being
 *     wrong is a server misconfiguration; passing it through would tell the CRM
 *     user they are logged out, sending them to re-auth over a problem no login
 *     can fix.
 *
 * Path shape is asserted against what the read-only Phase 1 probe confirmed:
 * `{BASE}/store/{storeId}/...` with no version prefix.
 */

const ENV = {
  HOSTINGER_ECOMMERCE_API_URL: "https://api-ecommerce.example.test",
  HOSTINGER_STORE_ID: "store_TEST123",
  HOSTINGER_API_TOKEN: "fake-token-for-tests",
  HOSTINGER_SALES_CHANNEL_ID: "scha_TEST",
};

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
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "x-request-id": "req_1" }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function fail(status: number) {
  return {
    ok: false,
    status,
    headers: new Headers({ "x-request-id": "req_err" }),
    json: async () => ({}),
    text: async () => "upstream detail",
  };
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

  it("strips surrounding quotes and a trailing slash from the base URL", () => {
    vi.stubEnv("HOSTINGER_ECOMMERCE_API_URL", '"https://api-ecommerce.example.test/"');
    expect(getHostingerConfig().baseUrl).toBe("https://api-ecommerce.example.test");
  });
});

describe("hostingerGet", () => {
  it("builds the store-scoped path and keeps the token out of the URL", async () => {
    fetchMock.mockResolvedValue(ok({ products: [] }));
    await hostingerGet("/products", { limit: 25, offset: 0 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://api-ecommerce.example.test/store/store_TEST123/products?limit=25&offset=0",
    );
    expect(url).not.toContain(ENV.HOSTINGER_API_TOKEN);
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe(`Bearer ${ENV.HOSTINGER_API_TOKEN}`);
  });

  it("omits undefined query params rather than sending the string 'undefined'", async () => {
    fetchMock.mockResolvedValue(ok({}));
    await hostingerGet("/products", { limit: 10, offset: undefined });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api-ecommerce.example.test/store/store_TEST123/products?limit=10",
    );
  });

  it("maps a Hostinger 401 to 502 so it never reads as a CRM auth failure", async () => {
    fetchMock.mockResolvedValue(fail(401));
    await expect(hostingerGet("/products")).rejects.toMatchObject({ status: 502 });
  });

  it("passes 404 through and keeps 429 as 429", async () => {
    fetchMock.mockResolvedValue(fail(404));
    await expect(hostingerGet("/products/x")).rejects.toMatchObject({ status: 404 });

    fetchMock.mockResolvedValue(fail(429));
    await expect(hostingerGet("/products")).rejects.toMatchObject({ status: 429 });
  });

  it("never forwards the upstream error body to the caller", async () => {
    fetchMock.mockResolvedValue(fail(500));
    await expect(hostingerGet("/products")).rejects.toSatisfy(
      (e: HostingerApiError) => !e.message.includes("upstream detail"),
    );
  });

  it("surfaces a timeout as 504", async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
    await expect(hostingerGet("/products")).rejects.toMatchObject({ status: 504 });
  });
});
