// Pure definitions for the Ecofy leads list (tabs, row shape, URL params).
// No DB / env imports: shared by the API routes, the CSV export and the client
// components, so the sheet, the badges and the screen read the same params.

import { z } from "zod";
import type { EcofyViewerKind } from "./access";

export const ECOFY_LIST_TABS = ["open", "queue", "follow_ups", "meetings_today", "closed", "all"] as const;
export type EcofyListTab = (typeof ECOFY_LIST_TABS)[number];

/** Tabs per viewer kind. The pickup queue is the Sales Head's alone. */
export function ecofyTabsFor(kind: EcofyViewerKind): EcofyListTab[] {
    return kind === "manager" ? [...ECOFY_LIST_TABS] : ECOFY_LIST_TABS.filter((t) => t !== "queue");
}

export const ECOFY_TAB_LABELS: Record<EcofyViewerKind, Record<EcofyListTab, string>> = {
    worker: {
        open: "My Open",
        queue: "Pickup Queue",
        follow_ups: "Follow-ups Due",
        meetings_today: "Meetings Today",
        closed: "Returned & Closed",
        all: "All",
    },
    manager: {
        open: "Open",
        queue: "Pickup Queue",
        follow_ups: "Follow-ups Due",
        meetings_today: "Meetings Today",
        closed: "Returned & Closed",
        all: "All Leads",
    },
};

export const ECOFY_TAB_EMPTY: Record<EcofyListTab, string> = {
    open: "No open Ecofy leads.",
    queue: "The pickup queue is empty.",
    follow_ups: "No follow-ups are due.",
    meetings_today: "No meetings today.",
    closed: "No returned or closed leads.",
    all: "No Ecofy leads yet.",
};

export const ECOFY_SEGMENTS = ["RESI", "ESS", "CI"] as const;

export const ECOFY_LIST_PAGE_SIZE = 25;

/** One row of the list, dates as ISO strings (server → client). */
export interface EcofyListRow {
    id: string;
    caseNo: string | null;
    customerName: string | null;
    customerMobile: string | null;
    city: string | null;
    state: string | null;
    productInterest: string | null;
    segment: string | null;
    temperature: string | null;
    stage: string | null;
    subStatus: string | null;
    queueEnteredAt: string | null;
    assignedTo: string | null;
    assigneeName: string | null;
    assignedRole: string | null;
    nextFollowUpAt: string | null;
    nextAppointmentAt: string | null;
}

export type EcofyListCounts = Record<EcofyListTab, number>;

export interface EcofyListResponse {
    rows: EcofyListRow[];
    total: number;
    page: number;
    limit: number;
}

const uuid = z.string().regex(/^[0-9a-f-]{36}$/i);

export const ecofyListParamsSchema = z.object({
    tab: z.enum(ECOFY_LIST_TABS).default("open"),
    q: z.string().trim().max(120).optional(),
    stage: z.string().trim().max(10).optional(),
    temperature: z.enum(["HOT", "WARM"]).optional(),
    segment: z.enum(ECOFY_SEGMENTS).optional(),
    /** Managers only: a user id, or "none" for unassigned. */
    assignee: z.union([uuid, z.literal("none")]).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(ECOFY_LIST_PAGE_SIZE),
});
export type EcofyListParams = z.infer<typeof ecofyListParamsSchema>;

/** Reads the list params off a query string; empty strings count as absent. */
export function readEcofyListParams(sp: URLSearchParams): EcofyListParams {
    const pick = (k: string) => {
        const v = sp.get(k);
        return v === null || v === "" ? undefined : v;
    };
    return ecofyListParamsSchema.parse({
        tab: pick("tab"),
        q: pick("q"),
        stage: pick("stage"),
        temperature: pick("temperature"),
        segment: pick("segment"),
        assignee: pick("assignee"),
        page: pick("page"),
        limit: pick("limit"),
    });
}

/** The filter keys (not tab / page / q) — for the badge count and the "clear" button. */
export const ECOFY_FILTER_KEYS = ["stage", "temperature", "segment", "assignee"] as const;
export type EcofyFilterKey = (typeof ECOFY_FILTER_KEYS)[number];
