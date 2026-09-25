"use client";

// Client helpers for the Ecofy workspace (E-307): fetch wrappers over
// /api/ecofy/*, React Query hooks, and the shared types the tabs render.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { EcofyLeadRead, EcofyLookup } from "@/lib/ecofy/actionSchemas";

export class EcofyUiError extends Error {}

async function unwrap<T>(res: Response): Promise<T> {
    let json: { success?: boolean; data?: T; error?: { message?: string; details?: Array<{ path: string; message: string }> } } | null = null;
    try {
        json = await res.json();
    } catch {
        /* non-JSON */
    }
    if (!res.ok || json?.success === false) {
        const details = json?.error?.details?.map((d) => `${d.path}: ${d.message}`).join("; ");
        throw new EcofyUiError([json?.error?.message ?? `Request failed (${res.status})`, details].filter(Boolean).join(" — "));
    }
    return json?.data as T;
}

export async function ecofyGet<T>(url: string): Promise<T> {
    return unwrap<T>(await fetch(url, { cache: "no-store" }));
}

export async function ecofyPost<T>(url: string, body: unknown): Promise<T> {
    return unwrap<T>(
        await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    );
}

export async function ecofyUpload<T>(url: string, form: FormData): Promise<T> {
    return unwrap<T>(await fetch(url, { method: "POST", body: form }));
}

type Part<T> = { data?: T; error?: string };

/** Live Ecofy data for one lead; one query per `what` so tabs load independently. */
export function useLeadData<T>(leadId: string, what: EcofyLeadRead, enabled = true) {
    return useQuery({
        queryKey: ["ecofy-lead", leadId, what],
        enabled,
        queryFn: async () => {
            const r = await ecofyGet<Record<string, Part<T>>>(`/api/ecofy/leads/${leadId}/data?what=${what}`);
            const part = r[what];
            if (part?.error) throw new EcofyUiError(part.error);
            return (part?.data ?? null) as T | null;
        },
    });
}

export interface ListItem {
    code: string;
    label: string;
}
export interface EpcPartner {
    id: string;
    name: string;
    active: boolean;
}
export interface Financier {
    id: string;
    name: string;
    active: boolean;
}

export function useLookup<T>(what: EcofyLookup, enabled = true) {
    return useQuery({
        queryKey: ["ecofy-lookup", what],
        enabled,
        staleTime: 5 * 60_000,
        queryFn: async () => {
            const r = await ecofyGet<Record<string, Part<T[]>>>(`/api/ecofy/lookups?what=${what}`);
            const part = r[what];
            if (part?.error) throw new EcofyUiError(part.error);
            return (part?.data ?? []) as T[];
        },
    });
}

/** Invalidate everything shown for a lead after an action. */
export function useRefreshLead(leadId: string) {
    const qc = useQueryClient();
    return () => qc.invalidateQueries({ queryKey: ["ecofy-lead", leadId] });
}

export function runLeadAction<T = unknown>(leadId: string, body: Record<string, unknown>) {
    return ecofyPost<{ result: T; stage: string | null; version: number | null; savedLocally?: boolean }>(
        `/api/ecofy/leads/${leadId}/actions`,
        body,
    );
}

/** datetime-local value (IST as typed) → ISO with offset, which the API needs. */
export function localToIso(v: string): string | undefined {
    if (!v) return undefined;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function todayIso(): string {
    return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

// --- Shapes Ecofy returns (only the fields the CRM renders) ---

export interface EcofyCase {
    id: string;
    caseNo: string;
    version: number;
    stage: string;
    subStatus: string | null;
    segment: string;
    temperature: string | null;
    source: string | null;
    owner: string;
    assignedUserName: string | null;
    qualifiedByName: string | null;
    financierId: string | null;
    financierName: string | null;
    customer: {
        fullName: string;
        mobile: string | null;
        altMobile: string | null;
        email?: string | null;
        customerType: string | null;
        businessName: string | null;
        address?: string | null;
        city: string | null;
        state: string | null;
        pincode: string | null;
        preferredLanguage: string | null;
        propertyType: string | null;
        consentDate?: string | null;
        consentSource?: string | null;
    } | null;
    productInterest: string | null;
    avgMonthlyBillInr: number | null;
    sanctionedLoadKw: number | null;
    existingBackup: string | null;
    preferredCallTime: string | null;
    closureReason: string | null;
    closureNote: string | null;
    closedAt: string | null;
    hotToFirstCallHours: number | null;
    ageing: { inStageWorkingHours: number; openWorkingHours: number };
    createdAt: string;
}
