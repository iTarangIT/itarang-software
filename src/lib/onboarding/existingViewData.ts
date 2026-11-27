// Server only (db + storage). What the view-only "existing application" page
// shows, and the document pages it renders. Access is decided by the caller
// (lib/onboarding/existingView.ts → checkViewAccess) before anything here runs.

import { and, eq, ne } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { db } from "@/lib/db";
import { dealerOnboardingApplications, dealerOnboardingDocuments } from "@/lib/db/schema";
import { documentLabel } from "@/lib/onboarding/correction-catalog";
import { boundApplication } from "@/lib/onboarding/docBinding";
import { checkViewAccess, EXISTING_VIEW_COOKIE, maskTail, type ViewAccess } from "@/lib/onboarding/existingView";
import { ONBOARDING_LINK_BUCKETS } from "@/lib/storage/fileAccess";
import { contentTypeForName, readBucketObject } from "@/lib/storage/readStoredDocument";

type CookieJar = { get(name: string): { value: string } | undefined };

export function viewAccessFor(token: string, cookies: CookieJar): ViewAccess {
    return checkViewAccess({
        token,
        boundApplication: boundApplication(cookies),
        cookieNonce: cookies.get(EXISTING_VIEW_COOKIE)?.value ?? null,
    });
}

export function verifyViewAccessForRequest(req: NextRequest, token: string): ViewAccess {
    return viewAccessFor(token, req.cookies);
}

const EXTRA_LABELS: Record<string, string> = {
    pan_card: "Company PAN Card",
    owner_pan: "Owner PAN Card",
    signed_agreement: "Signed Agreement",
};

export type ExistingDocument = {
    id: string;
    label: string;
    fileName: string;
    kind: "pdf" | "image" | "other";
    status: string | null;
    uploadedAt: string | null;
};

export type ExistingApplicationView = {
    applicationId: string;
    companyName: string | null;
    companyType: string | null;
    dealerType: string | null;
    gstNumber: string | null;
    panNumber: string | null;
    cinNumber: string | null;
    address: string | null;
    cityLine: string | null;
    ownerName: string | null;
    ownerPhone: string | null;
    ownerEmail: string | null;
    bankName: string | null;
    accountNumberMasked: string | null;
    beneficiaryName: string | null;
    ifscCode: string | null;
    financeEnabled: boolean;
    salesManager: string | null;
    onboardingStatus: string;
    reviewStatus: string | null;
    isLocked: boolean;
    submittedAt: string | null;
    updatedAt: string | null;
    documents: ExistingDocument[];
};

function kindOf(name: string, mime: string | null, storagePath?: string | null): ExistingDocument["kind"] {
    let type = (mime || contentTypeForName(name)).toLowerCase();
    if (type === "application/octet-stream" && storagePath) type = contentTypeForName(storagePath).toLowerCase();
    if (type.includes("pdf")) return "pdf";
    if (type.startsWith("image/")) return "image";
    return "other";
}

function addressLine(value: unknown): string | null {
    if (typeof value === "string") {
        const t = value.trim();
        // business_address is text but often holds the form's JSON ({"address": "…"}).
        if (t.startsWith("{")) {
            try {
                return addressLine(JSON.parse(t));
            } catch {
                return t;
            }
        }
        return t || null;
    }
    if (value && typeof value === "object") {
        const r = value as Record<string, unknown>;
        const parts = ["address", "line1", "line2", "city", "state", "pincode"]
            .map((k) => (typeof r[k] === "string" ? (r[k] as string).trim() : ""))
            .filter(Boolean);
        return parts.length ? Array.from(new Set(parts)).join(", ") : null;
    }
    return null;
}

function addressText(registered: unknown, business: string | null): string | null {
    return addressLine(business) ?? addressLine(registered);
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export async function loadExistingApplication(applicationId: string): Promise<ExistingApplicationView | null> {
    const [a] = await db
        .select()
        .from(dealerOnboardingApplications)
        .where(eq(dealerOnboardingApplications.id, applicationId))
        .limit(1);
    if (!a) return null;

    const docs = await db
        .select({
            id: dealerOnboardingDocuments.id,
            type: dealerOnboardingDocuments.document_type,
            fileName: dealerOnboardingDocuments.file_name,
            bucket: dealerOnboardingDocuments.bucket_name,
            path: dealerOnboardingDocuments.storage_path,
            mime: dealerOnboardingDocuments.mime_type,
            status: dealerOnboardingDocuments.verification_status,
            uploadedAt: dealerOnboardingDocuments.uploaded_at,
        })
        .from(dealerOnboardingDocuments)
        .where(
            and(
                eq(dealerOnboardingDocuments.application_id, applicationId),
                ne(dealerOnboardingDocuments.doc_status, "superseded"),
            ),
        );

    const cityLine = [a.city, a.state, a.pincode].filter((v) => v && String(v).trim()).join(", ") || null;

    return {
        applicationId: a.id,
        companyName: a.company_name,
        companyType: a.company_type,
        dealerType: a.dealer_type,
        gstNumber: a.gst_number,
        panNumber: a.pan_number,
        cinNumber: a.cin_number,
        address: addressText(a.registered_address, a.business_address),
        cityLine,
        ownerName: a.owner_name,
        ownerPhone: a.owner_phone,
        ownerEmail: a.owner_email,
        bankName: a.bank_name,
        accountNumberMasked: maskTail(a.account_number),
        beneficiaryName: a.beneficiary_name,
        ifscCode: a.ifsc_code,
        financeEnabled: !!a.finance_enabled,
        salesManager: a.sales_manager_name,
        onboardingStatus: a.onboarding_status ?? "draft",
        reviewStatus: a.review_status,
        isLocked: !!a.is_locked,
        submittedAt: iso(a.submitted_at),
        updatedAt: iso(a.updated_at),
        documents: docs
            .filter((d) => ONBOARDING_LINK_BUCKETS.includes(d.bucket))
            .map((d) => ({
                id: d.id,
                label: EXTRA_LABELS[d.type] ?? documentLabel(d.type).replace(/_/g, " "),
                fileName: d.fileName,
                kind: kindOf(d.fileName, d.mime, d.path),
                status: d.status,
                uploadedAt: iso(d.uploadedAt),
            })),
    };
}

/** Max PDF pages the viewer renders. */
export const VIEW_MAX_PAGES = 20;

/**
 * One page of a document as an image — never the original file. A PDF page is
 * rasterised on the server, so there is no PDF for the browser to save.
 */
export async function renderDocumentPage(
    applicationId: string,
    documentId: string,
    pageIndex: number,
): Promise<{ body: Buffer; contentType: string; pageCount: number } | null> {
    const [d] = await db
        .select({
            bucket: dealerOnboardingDocuments.bucket_name,
            path: dealerOnboardingDocuments.storage_path,
            fileName: dealerOnboardingDocuments.file_name,
            mime: dealerOnboardingDocuments.mime_type,
        })
        .from(dealerOnboardingDocuments)
        .where(
            and(
                eq(dealerOnboardingDocuments.id, documentId),
                eq(dealerOnboardingDocuments.application_id, applicationId),
                ne(dealerOnboardingDocuments.doc_status, "superseded"),
            ),
        )
        .limit(1);
    if (!d || !ONBOARDING_LINK_BUCKETS.includes(d.bucket)) return null;

    const buf = await readBucketObject(d.bucket, d.path);
    if (!buf) return null;

    const kind = kindOf(d.fileName || d.path, d.mime, d.path);
    if (kind === "image") {
        if (pageIndex !== 0) return null;
        return { body: buf, contentType: d.mime || contentTypeForName(d.path), pageCount: 1 };
    }
    if (kind !== "pdf") return null;

    const mupdf = await import("mupdf");
    const doc = mupdf.Document.openDocument(buf, "application/pdf");
    try {
        const pageCount = Math.min(doc.countPages(), VIEW_MAX_PAGES);
        if (pageIndex < 0 || pageIndex >= pageCount) return null;
        const page = doc.loadPage(pageIndex);
        try {
            const pixmap = page.toPixmap(mupdf.Matrix.scale(130 / 72, 130 / 72), mupdf.ColorSpace.DeviceRGB, false);
            try {
                return { body: Buffer.from(pixmap.asPNG()), contentType: "image/png", pageCount };
            } finally {
                pixmap.destroy();
            }
        } finally {
            page.destroy();
        }
    } finally {
        doc.destroy();
    }
}
