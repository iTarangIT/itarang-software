/**
 * Webhook caller verification (tracker ID 118, gap 4).
 *
 * The rule under test: with a secret configured the proof is required; without
 * one the call is accepted (as it always was) but reported; strict mode refuses
 * whatever cannot be verified.
 */
import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { inboundCallbackAllowed, signBody } from "@/lib/nbfc/handoff";

import {
  bearerProof,
  bolnaCallbackToken,
  bolnaCallbackUrl,
  callbackTokenProof,
  checksumProof,
  guardBolnaCall,
  guardDigioWebhook,
  hmacSha256Hex,
  leegalityMacProof,
  webhookAuthStrict,
  webhookVerdict,
} from "../webhookAuth";

const SECRET = "whsec_test_0123456789";
const BODY = JSON.stringify({ payload: { agreement_id: "DID1", agreement_status: "COMPLETED" } });
const sign = (secret: string, body: string) => createHmac("sha256", secret).update(body, "utf8").digest("hex");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("webhookVerdict", () => {
  it("with a secret, only a valid proof passes", () => {
    expect(webhookVerdict({ secretConfigured: true, proof: "valid", strict: false })).toBe("verified");
    expect(webhookVerdict({ secretConfigured: true, proof: "invalid", strict: false })).toBe("refuse");
    expect(webhookVerdict({ secretConfigured: true, proof: "absent", strict: false })).toBe("refuse");
  });

  it("without a secret the call is accepted but never counted as verified", () => {
    for (const proof of ["valid", "invalid", "absent"] as const) {
      expect(webhookVerdict({ secretConfigured: false, proof, strict: false })).toBe("unverified");
    }
  });

  it("strict mode refuses everything that is not verified", () => {
    expect(webhookVerdict({ secretConfigured: false, proof: "absent", strict: true })).toBe("refuse");
    expect(webhookVerdict({ secretConfigured: true, proof: "absent", strict: true, allowUnsigned: true })).toBe("refuse");
    expect(webhookVerdict({ secretConfigured: true, proof: "valid", strict: true })).toBe("verified");
  });

  it("allowUnsigned lets a MISSING signature through, never a WRONG one", () => {
    const rail = { secretConfigured: true, strict: false, allowUnsigned: true };
    expect(webhookVerdict({ ...rail, proof: "absent" })).toBe("unverified");
    expect(webhookVerdict({ ...rail, proof: "invalid" })).toBe("refuse");
    expect(webhookVerdict({ ...rail, proof: "valid" })).toBe("verified");
  });

  it("strict is off unless explicitly switched on", () => {
    expect(webhookAuthStrict(undefined)).toBe(false);
    expect(webhookAuthStrict("")).toBe(false);
    expect(webhookAuthStrict("0")).toBe(false);
    expect(webhookAuthStrict("1")).toBe(true);
    expect(webhookAuthStrict(" TRUE ")).toBe(true);
  });
});

describe("checksumProof", () => {
  it("accepts the HMAC-SHA256 hex of the exact body", () => {
    expect(hmacSha256Hex(SECRET, BODY)).toBe(sign(SECRET, BODY));
    expect(checksumProof(SECRET, BODY, sign(SECRET, BODY))).toBe("valid");
  });

  it("tolerates upper-case hex and a sha256= prefix", () => {
    expect(checksumProof(SECRET, BODY, sign(SECRET, BODY).toUpperCase())).toBe("valid");
    expect(checksumProof(SECRET, BODY, `sha256=${sign(SECRET, BODY)}`)).toBe("valid");
  });

  it("rejects a checksum made with another secret, or for another body", () => {
    expect(checksumProof(SECRET, BODY, sign("someone-else", BODY))).toBe("invalid");
    expect(checksumProof(SECRET, BODY.replace("COMPLETED", "FAILED"), sign(SECRET, BODY))).toBe("invalid");
    expect(checksumProof(SECRET, BODY, "not-a-checksum")).toBe("invalid");
  });

  it("no header is 'absent', not 'invalid' — the hand-off rails treat the two differently", () => {
    expect(checksumProof(SECRET, BODY, null)).toBe("absent");
    expect(checksumProof(SECRET, BODY, "  ")).toBe("absent");
  });
});

describe("bearerProof", () => {
  it("accepts the exact secret as a bearer token", () => {
    expect(bearerProof(SECRET, `Bearer ${SECRET}`)).toBe("valid");
    expect(bearerProof(SECRET, `bearer ${SECRET}`)).toBe("valid");
  });

  it("rejects a wrong or malformed token", () => {
    expect(bearerProof(SECRET, "Bearer nope")).toBe("invalid");
    expect(bearerProof(SECRET, SECRET)).toBe("invalid");
    expect(bearerProof(SECRET, `Basic ${SECRET}`)).toBe("invalid");
    expect(bearerProof(SECRET, `Bearer ${SECRET}x`)).toBe("invalid");
  });

  it("no header is 'absent'", () => {
    expect(bearerProof(SECRET, null)).toBe("absent");
  });
});

describe("guardDigioWebhook", () => {
  const headers = (checksum?: string) => new Headers(checksum ? { "x-digio-checksum": checksum } : {});

  it("no secret configured: the webhook still lands (nothing breaks on deploy), and says so in the log", () => {
    vi.stubEnv("DIGIO_WEBHOOK_SECRET", "");
    vi.stubEnv("WEBHOOK_AUTH_STRICT", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(guardDigioWebhook(headers(), BODY, "/test/digio-unconfigured")).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("UNVERIFIED /test/digio-unconfigured"));
  });

  it("secret configured: a forged event with no checksum is refused with 401", () => {
    vi.stubEnv("DIGIO_WEBHOOK_SECRET", SECRET);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(guardDigioWebhook(headers(), BODY, "/test/digio-forged")?.status).toBe(401);
    expect(guardDigioWebhook(headers(sign("guess", BODY)), BODY, "/test/digio-forged")?.status).toBe(401);
  });

  it("secret configured: Digio's own checksum passes", () => {
    vi.stubEnv("DIGIO_WEBHOOK_SECRET", SECRET);
    expect(guardDigioWebhook(headers(sign(SECRET, BODY)), BODY, "/test/digio-genuine")).toBeNull();
  });

  it("strict mode refuses an unconfigured webhook", () => {
    vi.stubEnv("DIGIO_WEBHOOK_SECRET", "");
    vi.stubEnv("WEBHOOK_AUTH_STRICT", "1");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(guardDigioWebhook(headers(), BODY, "/test/digio-strict")?.status).toBe(401);
  });
});

describe("inboundCallbackAllowed — NBFC result callbacks (E-NACH, video KYC, own e-sign)", () => {
  const call = (signatureHeader: string | null, secret: string | null = SECRET) =>
    inboundCallbackAllowed({ route: "/test/nbfc-callback", secret, rawBody: BODY, signatureHeader });

  it("a correctly signed callback is allowed", () => {
    vi.stubEnv("WEBHOOK_AUTH_STRICT", "");
    expect(call(signBody(SECRET, BODY))).toBe(true);
  });

  it("a wrong signature is refused — forging one must not be easier than sending none", () => {
    vi.stubEnv("WEBHOOK_AUTH_STRICT", "");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(call(signBody("someone-else", BODY))).toBe(false);
    expect(call("sha256=00")).toBe(false);
  });

  it("an unsigned callback is still accepted (NBFCs integrated before signing) but reported", () => {
    vi.stubEnv("WEBHOOK_AUTH_STRICT", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      inboundCallbackAllowed({ route: "/test/nbfc-unsigned", secret: SECRET, rawBody: BODY, signatureHeader: null }),
    ).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("UNVERIFIED /test/nbfc-unsigned"));
  });

  it("strict mode closes the unsigned path, and the no-secret path", () => {
    vi.stubEnv("WEBHOOK_AUTH_STRICT", "1");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(call(null)).toBe(false);
    expect(call(null, null)).toBe(false);
    expect(call(signBody(SECRET, BODY))).toBe(true);
  });
});

describe("guardBolnaCall", () => {
  it("the tool endpoint and the call webhook use separate secrets", () => {
    vi.stubEnv("BOLNA_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("BOLNA_TOOL_SECRET", "");
    vi.stubEnv("WEBHOOK_AUTH_STRICT", "");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const none = new Headers();
    // The webhook secret being set must not start refusing the agent's tool calls.
    expect(guardBolnaCall(none, "/test/bolna-tool", "BOLNA_TOOL_SECRET")).toBeNull();
    expect(guardBolnaCall(none, "/test/bolna-hook", "BOLNA_WEBHOOK_SECRET")?.status).toBe(401);
    expect(
      guardBolnaCall(new Headers({ authorization: `Bearer ${SECRET}` }), "/test/bolna-hook", "BOLNA_WEBHOOK_SECRET"),
    ).toBeNull();
  });
});

describe("Bolna per-call callback token (ID 118 item 8)", () => {
  const HOOK = "https://crm.example/api/ceo/ai-dialer/webhook/bolna";

  it("never puts the raw secret in the URL, and is stable per secret", () => {
    const url = bolnaCallbackUrl(HOOK, SECRET);
    expect(url).not.toContain(SECRET);
    expect(new URL(url).searchParams.get("cb")).toBe(bolnaCallbackToken(SECRET));
    expect(bolnaCallbackToken(SECRET)).not.toBe(bolnaCallbackToken("other"));
  });

  it("leaves the URL alone when no secret is configured", () => {
    expect(bolnaCallbackUrl(HOOK, undefined)).toBe(HOOK);
    expect(bolnaCallbackUrl(HOOK, "")).toBe(HOOK);
  });

  it("proof: valid / invalid / absent", () => {
    expect(callbackTokenProof(SECRET, bolnaCallbackUrl(HOOK, SECRET))).toBe("valid");
    expect(callbackTokenProof(SECRET, bolnaCallbackUrl(HOOK, "rotated"))).toBe("invalid");
    expect(callbackTokenProof(SECRET, `${HOOK}?cb=nope`)).toBe("invalid");
    expect(callbackTokenProof(SECRET, HOOK)).toBe("absent");
    expect(callbackTokenProof(SECRET, undefined)).toBe("absent");
    expect(callbackTokenProof(undefined, bolnaCallbackUrl(HOOK, SECRET))).toBe("invalid");
  });

  it("guardBolnaCall admits the token OR the bearer once the secret is set", () => {
    vi.stubEnv("BOLNA_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("WEBHOOK_AUTH_STRICT", "");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const none = new Headers();
    expect(guardBolnaCall(none, "/t", "BOLNA_WEBHOOK_SECRET", bolnaCallbackUrl(HOOK, SECRET))).toBeNull();
    expect(guardBolnaCall(none, "/t", "BOLNA_WEBHOOK_SECRET", `${HOOK}?cb=forged`)?.status).toBe(401);
    expect(guardBolnaCall(none, "/t", "BOLNA_WEBHOOK_SECRET", HOOK)?.status).toBe(401);
    // A valid bearer is enough even if the query carries junk.
    expect(
      guardBolnaCall(new Headers({ authorization: `Bearer ${SECRET}` }), "/t", "BOLNA_WEBHOOK_SECRET", `${HOOK}?cb=junk`),
    ).toBeNull();
  });
});

describe("leegalityMacProof (ID 130)", () => {
  const SALT = "salt_abc";
  const DOC = "01KC8ZWZ7ZWNAFTZRYMYMWV84B";
  const mac = (salt: string) => createHmac("sha1", salt).update(DOC, "utf8").digest("hex");
  const body = (m?: string) => JSON.stringify({ documentId: DOC, documentStatus: "Completed", ...(m ? { mac: m } : {}) });

  it("accepts HMAC-SHA1(documentId, privateSalt), any case", () => {
    expect(leegalityMacProof(SALT, body(mac(SALT)))).toBe("valid");
    expect(leegalityMacProof(SALT, body(mac(SALT).toUpperCase()))).toBe("valid");
  });

  it("refuses a wrong mac, a missing salt, or a mac with no documentId", () => {
    expect(leegalityMacProof(SALT, body(mac("other")))).toBe("invalid");
    expect(leegalityMacProof(undefined, body(mac(SALT)))).toBe("invalid");
    expect(leegalityMacProof(SALT, JSON.stringify({ mac: mac(SALT) }))).toBe("invalid");
  });

  it("no mac or unparsable body is absent", () => {
    expect(leegalityMacProof(SALT, body())).toBe("absent");
    expect(leegalityMacProof(SALT, "not json")).toBe("absent");
  });
});
