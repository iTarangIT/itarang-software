// Shape GET /assets/{assetId} for display. OpenAPI declares the response only
// as `data: object`, so nothing is assumed beyond what the list already shows
// (caseId, caseNo, customerName, city, systemSnapshot, commissionedOn, status,
// emiStatus, events): scalar fields become key/value rows, nested objects a
// section of rows, arrays a table over the union of their keys. Pure.

export type AssetCell = string;
export interface AssetSection {
    title: string;
    rows?: Array<[string, AssetCell]>;
    table?: { columns: string[]; rows: AssetCell[][] };
}

const LABELS: Record<string, string> = {
    caseNo: "Case",
    customerName: "Customer",
    city: "City",
    commissionedOn: "Commissioned on",
    status: "Lifecycle",
    systemSnapshot: "Installed system (snapshot at disbursement)",
    emiStatus: "Latest EMI status",
    events: "Buyback / redeployment events",
};

// Internal ids are not useful on screen; the case link carries the case id.
const HIDDEN = new Set(["id", "caseId", "tenantId"]);

export function labelFor(key: string): string {
    if (LABELS[key]) return LABELS[key];
    const spaced = key.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function formatAssetValue(v: unknown): AssetCell {
    if (v === null || v === undefined || v === "") return "—";
    if (typeof v === "boolean") return v ? "yes" : "no";
    if (typeof v === "number") return Number.isFinite(v) ? v.toLocaleString("en-IN") : "—";
    if (typeof v === "string") return /^[A-Z0-9_]+$/.test(v) && v.includes("_") ? v.replace(/_/g, " ") : v;
    if (Array.isArray(v)) return v.map(formatAssetValue).join(", ");
    return JSON.stringify(v);
}

export function assetDetailSections(asset: Record<string, unknown>): AssetSection[] {
    const summary: Array<[string, AssetCell]> = [];
    const nested: AssetSection[] = [];
    for (const [k, v] of Object.entries(asset)) {
        if (HIDDEN.has(k)) continue;
        if (Array.isArray(v)) {
            const objs = v.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object" && !Array.isArray(x));
            if (objs.length === v.length && objs.length > 0) {
                const columns = [...new Set(objs.flatMap((o) => Object.keys(o)))].filter((c) => !HIDDEN.has(c));
                nested.push({
                    title: labelFor(k),
                    table: { columns: columns.map(labelFor), rows: objs.map((o) => columns.map((c) => formatAssetValue(o[c]))) },
                });
            } else if (v.length === 0) {
                nested.push({ title: labelFor(k), rows: [] });
            } else {
                summary.push([labelFor(k), formatAssetValue(v)]);
            }
        } else if (v && typeof v === "object") {
            nested.push({
                title: labelFor(k),
                rows: Object.entries(v as Record<string, unknown>)
                    .filter(([kk]) => !HIDDEN.has(kk))
                    .map(([kk, vv]) => [labelFor(kk), formatAssetValue(vv)]),
            });
        } else {
            summary.push([labelFor(k), formatAssetValue(v)]);
        }
    }
    return [{ title: "Asset", rows: summary }, ...nested];
}
