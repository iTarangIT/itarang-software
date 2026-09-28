import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

const M = await import("../media");
const V = await import("../vision");
const G = await import("../geo");
const { docTypeFromKind, countNoun } = await import("../tools/attachments");

const at = new Date("2026-09-28T05:30:00Z"); // 11:00 IST

describe("media refs and the context block", () => {
    it("refs are 'm' + 5 unambiguous characters", () => {
        for (let i = 0; i < 200; i++) expect(M.newMediaRef()).toMatch(/^m[abcdefghjkmnpqrstuvwxyz23456789]{5}$/);
        expect(M.newMediaRef(Buffer.from([0, 1, 2, 3, 4]))).toBe("mabcde");
    });

    it("only JPG / PNG / WEBP / PDF are accepted; codec params and image/jpg are normalised", () => {
        expect(M.normalizeMediaMime("image/jpg")).toBe("image/jpeg");
        expect(M.normalizeMediaMime("application/pdf; charset=binary")).toBe("application/pdf");
        expect(M.isAcceptedMime("image/png")).toBe(true);
        expect(M.isAcceptedMime("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(false);
        expect(M.isAcceptedMime(null)).toBe(false);
    });

    it("files are served through the session-only /api/files documents bucket", () => {
        expect(M.MEDIA_BUCKET).toBe("documents");
        expect(M.mediaUrl("documents", "wa-assistant/u 1/a(1).jpg")).toBe("/api/files/documents/wa-assistant/u%201/a(1).jpg");
    });

    it("the context block lists each attachment with its ref, kind, caption and IST time", () => {
        const base = {
            user_id: "u", byte_size: 1, storage_bucket: "documents", storage_key: "k", latitude: null, longitude: null,
            place_name: null, place_address: null, created_at: at, used_at: null, file_name: null,
        };
        const block = M.pendingMediaContext([
            { ...base, id: "1", ref: "mabcde", kind: "image", mime_type: "image/jpeg", caption: "TIGER ka board" },
            { ...base, id: "2", ref: "mfghjk", kind: "document", mime_type: "application/pdf", caption: null, file_name: "gst.pdf" },
            { ...base, id: "3", ref: "mpqrst", kind: "location", mime_type: null, caption: null, storage_key: null, latitude: 18.508912, longitude: 73.925911, place_name: "Hadapsar" },
        ]);
        expect(block).toBe(
            [
                "[Attachments the user sent in the last 15 minutes, not yet used — pass their ids to tools:",
                '- mabcde: photo caption "TIGER ka board" (11:00)',
                '- mfghjk: PDF file "gst.pdf" no caption (11:00)',
                '- mpqrst: location pin 18.50891,73.92591 "Hadapsar" (11:00)',
                "]",
            ].join("\n"),
        );
        expect(M.pendingMediaContext([])).toBeNull();
    });

    it("doc_kind → filed type; counts read naturally", () => {
        expect(docTypeFromKind("shop_board")).toBe("shop_photo");
        expect(docTypeFromKind("gst_certificate")).toBe("gst_certificate");
        expect(docTypeFromKind("something")).toBe("other");
        expect(countNoun([{ kind: "image", mime_type: "image/jpeg" }, { kind: "image", mime_type: "image/png" }, { kind: "document", mime_type: "application/pdf" }])).toBe("2 photos + 1 PDF");
    });
});

describe("document reader (vision.ts)", () => {
    it("keeps well-formed values, drops malformed ones and names them", () => {
        const { fields, dropped } = V.checkReadFields({
            dealer_name: "  Rakesh   Sharma ", phone: "+91 98765-43210", alt_phone: "12345", email: "Sharma@Gmail.com",
            gstin: "27 abcde1234f1z5", pincode: "411 013", city: "Pune", state: "null",
        });
        expect(fields).toMatchObject({
            dealer_name: "Rakesh Sharma", phone: "9876543210", alt_phone: null, email: "sharma@gmail.com",
            gstin: "27ABCDE1234F1Z5", pincode: "411013", city: "Pune", state: null,
        });
        expect(dropped).toEqual(["alt_phone"]);
        expect(V.checkReadFields({ gstin: "27ABCDE1234" }).dropped).toEqual(["gstin"]);
    });

    it("INV8: there is no PAN field to fill — the schema and the result never carry one", () => {
        expect(Object.keys(V.READ_SCHEMA.properties)).not.toContain("pan");
        expect(Object.keys(V.checkReadFields({ pan: "ABCDE1234F" }).fields)).not.toContain("pan");
        expect(V.READ_PROMPT).toMatch(/Never copy a PAN, Aadhaar/);
    });

    it("OpenRouter first (image as image_url, PDF as file); falls back to the Gemini key on failure", async () => {
        const answer = { doc_kind: "gst_certificate", summary: "GST", gstin: "27ABCDE1234F1Z5" };
        const bodies: { url: string; body: Record<string, unknown> }[] = [];
        const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
            bodies.push({ url, body: JSON.parse(String(init.body)) });
            if (url.includes("openrouter")) return new Response(JSON.stringify({ error: { message: "402 no credits" } }), { status: 402 });
            return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }));
        });
        const env = { OPENROUTER_API_KEY: "or", WA_ASSIST_GEMINI_API_KEY: "g", ASSISTANT_MODEL: "gemini-x" } as unknown as NodeJS.ProcessEnv;
        const r = await V.readDocument({ bytes: Buffer.from("%PDF"), mimeType: "application/pdf", fetchImpl: fetchImpl as never, env });
        expect(r).toMatchObject({ kind: "ok", doc_kind: "gst_certificate", fields: { gstin: "27ABCDE1234F1Z5" } });
        const or = bodies[0].body as { model: string; messages: { content: { type: string }[] }[]; response_format: { json_schema: { strict: boolean } } };
        expect(or.model).toBe("google/gemini-3.5-flash-lite");
        expect(or.messages[0].content[0].type).toBe("file");
        expect(or.response_format.json_schema.strict).toBe(true);
        expect(bodies[1].url).toContain("/gemini-x:generateContent");

        bodies.length = 0;
        await V.readDocument({ bytes: Buffer.from("img"), mimeType: "image/jpeg", fetchImpl: vi.fn(async (url: string, init: RequestInit) => {
            bodies.push({ url, body: JSON.parse(String(init.body)) });
            return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
        }) as never, env });
        expect((bodies[0].body as { messages: { content: { type: string; image_url?: { url: string } }[] }[] }).messages[0].content[0])
            .toEqual({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${Buffer.from("img").toString("base64")}` } });
    });

    it("no key at all → failed, no call", async () => {
        const fetchImpl = vi.fn();
        const r = await V.readDocument({ bytes: Buffer.from("x"), mimeType: "image/png", fetchImpl: fetchImpl as never, env: {} as unknown as NodeJS.ProcessEnv });
        expect(r.kind).toBe("failed");
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe("pin vs shop (geo.ts)", () => {
    it("address query needs a city or pincode", () => {
        expect(G.addressQuery({ area: "Hadapsar", city: "Pune", pincode: "411013", state: "Maharashtra" })).toBe("Hadapsar, Pune, 411013, Maharashtra, India");
        expect(G.addressQuery({ state: "Maharashtra" })).toBeNull();
    });

    it("haversine: Pune station → Hadapsar ≈ 5.9 km", () => {
        expect(G.haversineMeters(18.5286, 73.8743, 18.5089, 73.9259)).toBeGreaterThan(5700);
        expect(G.haversineMeters(18.5286, 73.8743, 18.5089, 73.9259)).toBeLessThan(6000);
        expect(G.fmtDistance(420)).toBe("420 m");
        expect(G.fmtDistance(3240)).toBe("3.2 km");
    });

    it("Google denied (API not enabled) → Nominatim; near / far / city-level tolerance; cached", async () => {
        G.clearGeoCache();
        const fetchImpl = vi.fn(async (url: string) =>
            url.includes("googleapis")
                ? new Response(JSON.stringify({ status: "REQUEST_DENIED" }))
                : new Response(JSON.stringify([{ lat: "18.5089", lon: "73.9259", addresstype: "suburb" }])),
        );
        const env = { GOOGLE_PLACES_API_KEY: "k" } as unknown as NodeJS.ProcessEnv;
        const shop = { area: "Hadapsar", city: "Pune", pincode: "411013", state: "Maharashtra" };
        const near = await G.checkPinAgainstShop({ lat: 18.5095, lng: 73.9262 }, shop, { fetchImpl: fetchImpl as never, env });
        expect(near).toMatchObject({ kind: "near", precision: "area" });
        const far = await G.checkPinAgainstShop({ lat: 18.5286, lng: 73.8743 }, shop, { fetchImpl: fetchImpl as never, env });
        expect(far).toMatchObject({ kind: "far" });
        expect(fetchImpl).toHaveBeenCalledTimes(2); // google + nominatim once; second lookup cached

        G.clearGeoCache();
        const cityOnly = vi.fn(async () => new Response(JSON.stringify([{ lat: "18.52", lon: "73.85", addresstype: "city" }])));
        const r = await G.checkPinAgainstShop({ lat: 18.5286, lng: 73.9259 }, { city: "Pune" }, { fetchImpl: cityOnly as never, env: {} as unknown as NodeJS.ProcessEnv });
        expect(r).toMatchObject({ kind: "near", precision: "city" }); // ~8 km from the city centre is still "in Pune"
    });

    it("a geocoder outage is 'unmapped', never an error", async () => {
        G.clearGeoCache();
        const down = vi.fn(async () => { throw new Error("ECONNRESET"); });
        expect(await G.checkPinAgainstShop({ lat: 1, lng: 1 }, { city: "Pune" }, { fetchImpl: down as never, env: {} as unknown as NodeJS.ProcessEnv })).toEqual({ kind: "unmapped" });
    });
});
