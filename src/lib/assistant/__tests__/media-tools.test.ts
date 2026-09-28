import { beforeEach, describe, expect, it, vi } from "vitest";

// E-311 — the media tools: read_document, attach_document, update_lead, and the
// photo / location additions to log_visit and create_lead. DB, storage, the
// document reader and geocoding are all faked: what is tested is what each tool
// proposes and what each applier writes.

const leadRow: Record<string, unknown> = {};
const limit = vi.fn(async () => [leadRow]);
const select = vi.fn(() => ({ from: () => ({ where: () => ({ limit }) }) }));
const execute = vi.fn(async () => [{ area: "Hadapsar", pincode: "411013" }]);
vi.mock("@/lib/db", () => ({ db: { select, execute } }));
const findLeadInScope = vi.fn();
vi.mock("../scope", async (orig) => ({ ...(await orig<typeof import("../scope")>()), findLeadInScope }));
const createPending = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ id: "act-1", expiresAt: new Date() }));
vi.mock("../actions", async (orig) => ({ ...(await orig<typeof import("../actions")>()), createPending }));
const recordVisit = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ visitId: "v-1", scheduledVisitId: null }));
vi.mock("@/lib/asm/recordVisit", () => ({ recordVisit, scheduleVisit: vi.fn() }));
const createInsideSalesLead = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ id: "DL-NEW", afterCommit: undefined }));
vi.mock("@/lib/inside-sales/createLead", async (orig) => ({
    ...(await orig<typeof import("@/lib/inside-sales/createLead")>()),
    createInsideSalesLead,
    findLeadIdByPhone: vi.fn(async () => null),
}));

type Media = import("../media").MediaRow;
const media = new Map<string, Media>();
const findMedia = vi.fn(async (_userId: string, ref: string) => media.get(ref) ?? null);
const mediaBytes = vi.fn(async () => Buffer.from("img"));
const consumeMedia = vi.fn(async () => {});
vi.mock("../media", async (orig) => ({ ...(await orig<typeof import("../media")>()), findMedia, mediaBytes, consumeMedia }));
const readDocument = vi.fn();
vi.mock("../vision", async (orig) => ({ ...(await orig<typeof import("../vision")>()), readDocument }));
const checkPinAgainstShop = vi.fn();
vi.mock("../geo", async (orig) => ({ ...(await orig<typeof import("../geo")>()), checkPinAgainstShop }));

const { toolsFor } = await import("../registry");
const { APPLIERS } = await import("../appliers");
import type { AssistantUser, Preview, ToolContext } from "../types";

const ISR: AssistantUser = { id: "isr-1", name: "Priya", role: "inside_sales_rep" };
const ASM: AssistantUser = { id: "asm-1", name: "Rahul", role: "asm" };
const NOW = new Date("2026-09-28T06:30:00Z");
const ctx = (user: AssistantUser): ToolContext => ({ user, messageId: "11111111-1111-4111-8111-111111111111", now: NOW, writesEnabled: true });
const lead = (over: Record<string, unknown> = {}) => ({
    id: "DL-1042", shop_name: "ABC Traders", dealer_name: "Ramesh", phone: "9876543210", city: "Pune", state: "Maharashtra",
    current_owner_id: "asm-1", asm_id: "asm-1", lead_status: "Under_Discussion", interest_level: "warm",
    next_follow_up_at: null, updated_at: new Date("2026-09-28T05:00:00Z"), owned: true, ...over,
});
const run = async (user: AssistantUser, name: string, input: Record<string, unknown>) => {
    const t = toolsFor(user.role, true).find((x) => x.name === name)!;
    return t.run(ctx(user), t.schema.parse(input));
};
const stored = () => createPending.mock.calls.at(-1)![0] as { plan: Record<string, unknown>; preview: Preview; tool: string; leadVersion: Date | null };

function file(ref: string, over: Partial<Media> = {}): Media {
    return {
        // A valid v4 uuid derived from the ref (the plan schemas check uuids).
        id: `00000000-0000-4000-8000-${Buffer.from(ref).toString("hex").padStart(12, "0").slice(-12)}`,
        ref, user_id: "isr-1", kind: "image", mime_type: "image/jpeg", byte_size: 1000, file_name: null,
        storage_bucket: "documents", storage_key: `wa-assistant/isr-1/2026-09/${ref}.jpg`, caption: null,
        latitude: null, longitude: null, place_name: null, place_address: null, created_at: NOW, used_at: null, ...over,
    };
}

// A fake transaction: records inserts and updates.
function fakeTx() {
    const inserts: unknown[] = [];
    const updates: Record<string, unknown>[] = [];
    const tx = {
        insert: () => ({
            values: (v: unknown) => {
                inserts.push(v);
                return { returning: async () => (v as unknown[]).map((_, i) => ({ id: `doc-${i + 1}` })) };
            },
        }),
        update: () => ({ set: (s: Record<string, unknown>) => (updates.push(s), { where: async () => {} }) }),
    };
    return { tx: tx as never, inserts, updates };
}

beforeEach(() => {
    vi.clearAllMocks();
    media.clear();
    for (const k of Object.keys(leadRow)) delete leadRow[k];
    findLeadInScope.mockResolvedValue(lead({ current_owner_id: "isr-1", owned: true }));
});

describe("registry", () => {
    it("both roles read, attach and update; only the ASM logs visits", () => {
        for (const role of ["asm", "inside_sales_rep"] as const) {
            const names = toolsFor(role, true).map((t) => t.name);
            expect(names).toEqual(expect.arrayContaining(["read_document", "attach_document", "update_lead"]));
        }
        expect(toolsFor("inside_sales_rep", false).map((t) => t.name)).toContain("read_document");
        expect(toolsFor("inside_sales_rep", false).map((t) => t.name)).not.toContain("attach_document");
    });
});

describe("read_document", () => {
    it("returns what the reader found for the user's OWN attachment", async () => {
        media.set("mcard1", file("mcard1"));
        readDocument.mockResolvedValue({
            kind: "ok", doc_kind: "visiting_card", summary: "Visiting card of Sharma Battery House",
            fields: { dealer_name: "Rakesh Sharma", phone: "9876543210", gstin: null }, dropped: ["email"],
        });
        const r = await run(ISR, "read_document", { attachment_id: "mcard1" });
        expect(findMedia).toHaveBeenCalledWith("isr-1", "mcard1");
        expect(r).toEqual({
            kind: "document", attachment_id: "mcard1", doc_kind: "visiting_card", summary: "Visiting card of Sharma Battery House",
            fields: { dealer_name: "Rakesh Sharma", phone: "9876543210", gstin: null }, unreadable: ["email"],
        });
    });

    it("someone else's ref is simply not found; a location pin is not a document", async () => {
        expect((await run(ISR, "read_document", { attachment_id: "mnope1" })).kind).toBe("question");
        media.set("mpin01", file("mpin01", { kind: "location", storage_key: null, storage_bucket: null, latitude: 18.5, longitude: 73.8 }));
        expect((await run(ISR, "read_document", { attachment_id: "mpin01" })).kind).toBe("declined");
        expect(readDocument).not.toHaveBeenCalled();
    });

    it("a reader failure is 'unavailable', never an invented field", async () => {
        media.set("mcard1", file("mcard1"));
        readDocument.mockResolvedValue({ kind: "failed", error: "timeout" });
        expect((await run(ISR, "read_document", { attachment_id: "mcard1" })).kind).toBe("unavailable");
    });
});

describe("attach_document", () => {
    it("proposes filing the files as one type; nothing is written until Confirm", async () => {
        media.set("mgst01", file("mgst01", { kind: "document", mime_type: "application/pdf", file_name: "gst.pdf" }));
        const r = await run(ISR, "attach_document", { lead_id: "DL-1042", attachment_ids: ["mgst01"], doc_type: "gst_certificate", note: "from owner" });
        expect(r.kind).toBe("preview");
        expect(stored().tool).toBe("attach_document");
        expect(stored().leadVersion).toBeNull();
        expect(stored().preview.lines).toEqual([
            { label: "Save", value: "1 PDF as GST certificate" },
            { label: "Note", value: "from owner" },
        ]);
        expect(stored().plan).toMatchObject({ lead_id: "DL-1042", doc_type: "gst_certificate", files: [{ ref: "mgst01", storage_key: expect.stringContaining("mgst01") }] });
    });

    it("an attachment already used by a confirmed change is refused", async () => {
        media.set("mold01", file("mold01", { used_at: new Date() }));
        const r = await run(ISR, "attach_document", { lead_id: "DL-1042", attachment_ids: ["mold01"], doc_type: "other" });
        expect(r.kind).toBe("declined");
        expect(createPending).not.toHaveBeenCalled();
    });

    it("a lead the user doesn't own is read-only", async () => {
        findLeadInScope.mockResolvedValue(lead({ current_owner_id: "isr-9", owned: false }));
        media.set("mgst01", file("mgst01"));
        expect((await run(ISR, "attach_document", { lead_id: "DL-1042", attachment_ids: ["mgst01"], doc_type: "other" })).kind).toBe("declined");
    });

    it("applier: consumes the attachments for THIS action, then one document row per file", async () => {
        media.set("ma0001", file("ma0001"));
        media.set("ma0002", file("ma0002"));
        await run(ISR, "attach_document", { lead_id: "DL-1042", attachment_ids: ["ma0001", "ma0002"], doc_type: "shop_photo" });
        const plan = APPLIERS.attach_document.schema.parse(stored().plan);
        const { tx, inserts } = fakeTx();
        const out = await APPLIERS.attach_document.apply({ tx, user: ISR, step: 1, actionId: "act-9" }, plan);
        expect(consumeMedia).toHaveBeenCalledWith(tx, [file("ma0001").id, file("ma0002").id], "act-9");
        expect(inserts[0]).toEqual([
            expect.objectContaining({ dealer_lead_id: "DL-1042", doc_type: "shop_photo", source: "whatsapp_assistant", uploaded_by: "isr-1", media_id: file("ma0001").id }),
            expect.objectContaining({ media_id: file("ma0002").id }),
        ]);
        expect(out).toEqual({ document_ids: ["doc-1", "doc-2"] });
    });
});

describe("update_lead", () => {
    it("shows only real changes, old → new, and warns when a filled field is replaced", async () => {
        Object.assign(leadRow, { shop_name: "ABC Traders", area: null, city: "Pune", state: "Maharashtra", pincode: null, contact_email: null, gstin: null, location: "Pune" });
        const r = await run(ISR, "update_lead", {
            lead_id: "DL-1042", shop_name: "ABC Battery Traders", city: "pune", gstin: "27abcde1234f1z5", pincode: "411 013",
        });
        expect(r.kind).toBe("preview");
        expect(stored().preview.lines).toEqual([
            { label: "Shop", value: "ABC Traders → ABC Battery Traders" },
            { label: "Pincode", value: "411013 (new)" },
            { label: "GSTIN", value: "27ABCDE1234F1Z5 (new)" },
        ]);
        expect(stored().preview.warning).toBe("Replaces what the lead has now: Shop.");
        expect(stored().plan).toMatchObject({ set: { shop_name: "ABC Battery Traders", pincode: "411013", gstin: "27ABCDE1234F1Z5" } });
        expect((stored().plan.set as Record<string, unknown>).city).toBeUndefined();
    });

    it("from a document, a filled field is KEPT (the wrong dealer's certificate can't move the lead)", async () => {
        Object.assign(leadRow, { shop_name: null, city: "Kanpur", state: "Uttar Pradesh", pincode: null, gstin: null, location: "Kanpur" });
        media.set("mgst01", file("mgst01", { kind: "document", mime_type: "application/pdf" }));
        await run(ISR, "update_lead", {
            lead_id: "DL-1042", city: "Pune", state: "Maharashtra", pincode: "411013", gstin: "27ABCDE1234F1Z5",
            source_attachment_id: "mgst01", source_doc_type: "gst_certificate",
        });
        expect(stored().plan.set).toEqual({ pincode: "411013", gstin: "27ABCDE1234F1Z5" });
        expect(stored().preview.warning).toBe(
            "Kept what the lead has: City Kanpur (document says Pune); State Uttar Pradesh (document says Maharashtra) — check this is the right dealer's document.",
        );
        // Typed by the rep (no document) the same change is proposed, as old → new.
        await run(ISR, "update_lead", { lead_id: "DL-1042", city: "Pune" });
        expect(stored().preview.lines).toEqual([{ label: "City", value: "Kanpur → Pune" }]);
    });

    it("a malformed GSTIN / email / pincode is a question, never saved", async () => {
        Object.assign(leadRow, { location: null });
        expect((await run(ISR, "update_lead", { lead_id: "DL-1042", gstin: "27ABCDE1234" })).kind).toBe("question");
        expect((await run(ISR, "update_lead", { lead_id: "DL-1042", email: "not-an-email" })).kind).toBe("question");
        expect((await run(ISR, "update_lead", { lead_id: "DL-1042", pincode: "4110" })).kind).toBe("question");
        expect(createPending).not.toHaveBeenCalled();
    });

    it("nothing new → declined, no card", async () => {
        Object.assign(leadRow, { shop_name: "ABC Traders", location: "Pune" });
        expect((await run(ISR, "update_lead", { lead_id: "DL-1042", shop_name: "abc traders" })).kind).toBe("declined");
    });

    it("applier: writes only the planned fields and files the source document", async () => {
        Object.assign(leadRow, { gstin: null, location: "Pune" });
        media.set("mgst01", file("mgst01", { kind: "document", mime_type: "application/pdf" }));
        await run(ISR, "update_lead", { lead_id: "DL-1042", gstin: "27ABCDE1234F1Z5", source_attachment_id: "mgst01", source_doc_type: "gst_certificate" });
        expect(stored().preview.lines.at(-1)).toEqual({ label: "📎 Save", value: "GST certificate on the lead" });
        const plan = APPLIERS.update_lead.schema.parse(stored().plan);
        const { tx, inserts, updates } = fakeTx();
        await APPLIERS.update_lead.apply({ tx, user: ISR, step: 1, actionId: "act-2" }, plan);
        expect(updates[0]).toMatchObject({ gstin: "27ABCDE1234F1Z5", updated_at: expect.any(Date) });
        expect(Object.keys(updates[0]).sort()).toEqual(["gstin", "updated_at"]);
        expect(inserts[0]).toEqual([expect.objectContaining({ doc_type: "gst_certificate", dealer_lead_id: "DL-1042" })]);
    });
});

describe("log_visit with photos and a location pin", () => {
    const VISIT = { lead_id: "DL-1042", visit_status: "visited", outcome: "productive", remarks: "demo diya", next_action: "escalate" };
    beforeEach(() => {
        findLeadInScope.mockResolvedValue(lead());
        media.set("mshop1", file("mshop1", { user_id: "asm-1" }));
        media.set("mpin01", file("mpin01", { kind: "location", storage_key: null, storage_bucket: null, latitude: 18.5089, longitude: 73.9259, user_id: "asm-1" }));
    });

    it("files the photos and pin; a far pin is on the card and in the remarks, never blocking", async () => {
        checkPinAgainstShop.mockResolvedValue({ kind: "far", meters: 3200, precision: "area" });
        const r = await run(ASM, "log_visit", { ...VISIT, photo_ids: ["mshop1"], location_id: "mpin01" });
        expect(r.kind).toBe("preview");
        expect(checkPinAgainstShop).toHaveBeenCalledWith(
            { lat: 18.5089, lng: 73.9259 },
            { area: "Hadapsar", city: "Pune", state: "Maharashtra", pincode: "411013" },
        );
        const lines = stored().preview.lines;
        expect(lines).toContainEqual({ label: "📷 Photos", value: "1" });
        expect(lines).toContainEqual({ label: "📍 Location", value: "⚠ 3.2 km from the shop address" });
        expect(stored().preview.warning).toContain("3.2 km from the shop's address");

        const plan = APPLIERS.log_visit.schema.parse(stored().plan);
        const { tx } = fakeTx();
        await APPLIERS.log_visit.apply({ tx, user: ASM, step: 1, actionId: "act-3" }, plan);
        expect(consumeMedia).toHaveBeenCalledWith(tx, [file("mshop1").id, file("mpin01").id], "act-3");
        expect(recordVisit).toHaveBeenCalledWith(
            expect.objectContaining({
                photos: ["/api/files/documents/wa-assistant/isr-1/2026-09/mshop1.jpg"],
                gps_check_in_lat: 18.5089,
                gps_check_in_lng: 73.9259,
                visit_remarks: "demo diya\n📍 WhatsApp location: ⚠ 3.2 km from the shop address",
            }),
            { tx },
        );
    });

    it("an unmapped shop still saves the pin, and says so", async () => {
        checkPinAgainstShop.mockResolvedValue({ kind: "unmapped" });
        await run(ASM, "log_visit", { ...VISIT, location_id: "mpin01" });
        expect(stored().preview.lines).toContainEqual({ label: "📍 Location", value: "saved (shop address not mapped)" });
        expect(stored().preview.warning ?? "").not.toContain("km");
    });

    it("photos on a visit that didn't happen → a question", async () => {
        const r = await run(ASM, "log_visit", { ...VISIT, visit_status: "postponed", outcome: undefined, photo_ids: ["mshop1"] });
        expect(r.kind).toBe("question");
    });

    it("a photo passed as the location (or a pin as a photo) is refused", async () => {
        expect((await run(ASM, "log_visit", { ...VISIT, location_id: "mshop1" })).kind).toBe("declined");
        expect((await run(ASM, "log_visit", { ...VISIT, photo_ids: ["mpin01"] })).kind).toBe("declined");
    });

    it("a plain visit keeps its old plan shape (no photos, no gps)", async () => {
        await run(ASM, "log_visit", VISIT);
        expect(stored().plan).toMatchObject({ photos: [], gps: null });
    });
});

describe("create_lead from a visiting card", () => {
    it("carries the card's extra details and files the card on the new lead", async () => {
        media.set("mcard1", file("mcard1"));
        const r = await run(ISR, "create_lead", {
            dealer_name: "Rakesh Sharma", phone: "+91 98765 43210", shop_name: "Sharma Battery House", city: "Pune",
            area: "Hadapsar", pincode: "411013", email: "Sharma@Gmail.com", source_attachment_id: "mcard1",
        });
        expect(r.kind).toBe("preview");
        expect(stored().plan).toMatchObject({
            extra: { area: "Hadapsar", pincode: "411013", contact_email: "sharma@gmail.com", gstin: null },
            source_doc_type: "visiting_card",
        });
        expect(stored().preview.lines).toContainEqual({ label: "📎 Save", value: "Visiting card on the lead" });

        const plan = APPLIERS.create_lead.schema.parse(stored().plan);
        const { tx, inserts, updates } = fakeTx();
        const out = await APPLIERS.create_lead.apply({ tx, user: ISR, step: 1, actionId: "act-4" }, plan);
        expect(updates[0]).toEqual({ area: "Hadapsar", pincode: "411013", contact_email: "sharma@gmail.com" });
        expect(inserts[0]).toEqual([expect.objectContaining({ dealer_lead_id: "DL-NEW", doc_type: "visiting_card" })]);
        expect(out).toMatchObject({ lead_id: "DL-NEW", document_ids: ["doc-1"] });
    });

    it("an old stored plan (before E-311) still parses: no extra, no source", () => {
        const old = { dealer_name: "Ramesh", phone: "9876543210", shop_name: null, city: null, state: null, interest_level: null, language: null, business_type: null };
        expect(APPLIERS.create_lead.schema.parse(old)).toMatchObject({ extra: null, source: null, source_doc_type: null });
    });
});
