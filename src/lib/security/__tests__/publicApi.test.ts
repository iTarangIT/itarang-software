import { describe, expect, it } from "vitest";

import { apiGate, isPublicApiPath, isSignedFileLink } from "../publicApi";

// ID 130 (18 Oct check): the "open file" link from downloads and e-mails, and
// signed NBFC-store links, must reach their routes with the gate on enforce.
const signed = "?exp=1760000000&sig=" + "a".repeat(64);

describe("ID 130 — file links through the gate", () => {
    it("a logged-out click on /api/files/open reaches the route (which redirects to /login)", () => {
        expect(isPublicApiPath("/api/files/open")).toBe(true);
        expect(apiGate({ pathname: "/api/files/open", hasSession: false, mode: "enforce", search: "?u=%2Fapi%2Ffiles%2Fdocuments%2Fa.pdf" })).toBe("allow");
        // Only that exact path — not a look-alike or a sub-path.
        expect(isPublicApiPath("/api/files/open/x")).toBe(false);
        expect(isPublicApiPath("/api/files/opener")).toBe(false);
        expect(isPublicApiPath("/api/files/link")).toBe(false);
    });

    it("a signed NBFC-store link reaches the route, which checks the signature; an unsigned one does not", () => {
        const p = "/api/nbfc-uploads/fi-visits/A-1/photo.jpg";
        expect(isSignedFileLink(p, signed)).toBe(true);
        expect(apiGate({ pathname: p, hasSession: false, mode: "enforce", search: signed })).toBe("allow");
        expect(apiGate({ pathname: p, hasSession: false, mode: "enforce" })).toBe("refuse");
        expect(apiGate({ pathname: p, hasSession: false, mode: "enforce", search: "?exp=1760000000" })).toBe("refuse");
        expect(apiGate({ pathname: p, hasSession: false, mode: "enforce", search: "?sig=x" })).toBe("refuse");
        // The bare prefix and look-alikes are not signed links.
        expect(isSignedFileLink("/api/nbfc-uploads/", signed)).toBe(false);
        expect(isSignedFileLink("/api/nbfc-uploadsx/a.pdf", signed)).toBe(false);
        expect(isPublicApiPath(p)).toBe(false);
    });

    it("the existing /api/files signed links still pass", () => {
        expect(apiGate({ pathname: "/api/files/documents/kyc/L-1/pan.jpg", hasSession: false, mode: "enforce", search: signed })).toBe("allow");
        expect(apiGate({ pathname: "/api/files/other-bucket/a.pdf", hasSession: false, mode: "enforce", search: signed })).toBe("refuse");
    });
});
