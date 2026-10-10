// Reports › Data downloads (tracker ID 13, decided 29 Sep 2026): one catalogue
// of datasets that all download the same way. CLIENT-SAFE: types and pure
// helpers only — the page reads the catalogue shape from here.

export type ColumnKind = "text" | "number" | "money" | "date" | "datetime" | "phone";

export interface DatasetColumn {
    key: string;
    header: string;
    /** One line for the column dictionary and the "About this file" sheet. */
    meaning: string;
    kind?: ColumnKind;
    width?: number;
}

export interface DatasetSheetSpec {
    name: string;
    columns: DatasetColumn[];
}

export interface DatasetSheet extends DatasetSheetSpec {
    rows: Record<string, unknown>[];
}

export interface DatasetFilter {
    key: string;
    label: string;
    /**
     * "multiselect": tick any number of `options`; sent as one param of
     * comma-joined values ("call,visit"). Nothing ticked = all (ID 34).
     */
    type: "select" | "text" | "multiselect";
    options?: { value: string; label: string }[];
}

/** A multiselect param value → the ticked option values. */
export function splitMulti(value: string | null | undefined): string[] {
    return (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** What the catalogue shows before anything is downloaded. */
export interface DatasetInfo {
    id: string;
    label: string;
    description: string;
    /** Roles that get every row. */
    roles: readonly string[];
    /** Roles that may download, but only their own rows (ID 58). */
    ownRowsRoles?: readonly string[];
    /** The dates this dataset can be ranged on; the first is the default. */
    dateFields: { value: string; label: string }[];
    /** With no dates set the dataset returns every row, not this month. */
    allWhenNoDates?: boolean;
    filters: DatasetFilter[];
    /** Which of the shared filters this dataset answers to (params `team`, `person`, `state`). */
    commonFilters?: CommonFilter[];
    /** A file above DOWNLOAD_ROW_CAP can be prepared in the background and emailed as a link. */
    background?: boolean;
    sheets: DatasetSheetSpec[];
}

export type CommonFilter = "team" | "person" | "state";

/** `team` values → the role that team's people hold. */
export const TEAM_ROLES: Record<string, string> = { field: "asm", inside: "inside_sales_rep" };

/** Files above this many rows do not download at once. */
export const DOWNLOAD_ROW_CAP = 50_000;

/** The most a background file may hold; above it the filters must be narrowed. */
export const BACKGROUND_ROW_CAP = 500_000;

/** How long the emailed link to a background file works. */
export const BACKGROUND_LINK_HOURS = 24;

/**
 * The columns of a sheet a download keeps: the ticked ones, in the sheet's own
 * order. Nothing ticked, or nothing recognised, keeps every column — a file is
 * never produced with no columns.
 */
export function pickColumns(columns: DatasetColumn[], keep: readonly string[] | null | undefined): DatasetColumn[] {
    if (!keep || keep.length === 0) return columns;
    const wanted = new Set(keep);
    const picked = columns.filter((c) => wanted.has(c.key));
    return picked.length > 0 ? picked : columns;
}

/** Full phone numbers: these roles only, and only after typing a reason. */
export const FULL_PHONE_ROLES = ["admin", "ceo"] as const;
export const FULL_PHONE_REASON_MIN = 5;

/** Who sees the download log. */
export const DOWNLOAD_LOG_ROLES = ["admin", "ceo"] as const;

/** "9876543210" → "98xxxxx210" — enough to recognise a number, not enough to dial it. */
export function maskPhone(value: string | null | undefined): string | null {
    const raw = (value ?? "").trim();
    if (!raw) return null;
    let d = raw.replace(/\D/g, "");
    if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
    else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
    if (d.length < 6) return "x".repeat(d.length);
    return `${d.slice(0, 2)}${"x".repeat(d.length - 5)}${d.slice(-3)}`;
}

/** "Ramesh Kumar Yadav" → "R. K. Y." — customer loan files carry initials only. */
export function initialsOf(name: string | null | undefined): string | null {
    const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
    return parts.length ? parts.map((p) => `${p[0].toUpperCase()}.`).join(" ") : null;
}
