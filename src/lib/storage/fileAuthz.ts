// Loads the facts fileRules.ts needs to decide one file open (tracker ID 166),
// and records every open of a customer KYC file.
//
// Server-only. The decision itself lives in fileRules.ts (pure, unit-tested);
// this file only answers "who owns this file" from the database.

import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
    accountOwnership,
    dealerLeads,
    dealerOnboardingApplications,
    dealerOnboardingDocuments,
    leads,
    nbfcLeadAssignments,
    nbfcUsers,
} from "@/lib/db/schema";
import {
    classifyFile,
    isKycFile,
    mayOpenFile,
    FILE_TOP_ROLES,
    type FileFacts,
    type FileKind,
    type FileViewer,
} from "@/lib/storage/fileRules";

export type FileUser = { id: string; role: string | null; dealer_id: string | null };

function rowsOf<T>(result: unknown): T[] {
    return ((result as { rows?: T[] }).rows ?? (result as T[])) as T[];
}

async function viewerFor(user: FileUser): Promise<FileViewer> {
    const role = (user.role ?? "").toLowerCase();
    let dealerCode = user.dealer_id?.trim() || null;
    if (!dealerCode && role === "dealer") {
        // Same fallback as requireLeadAccess (ID 119): a dealer login with no
        // users.dealer_id takes the code on its approved onboarding application.
        const [app] = await db
            .select({ dealer_code: dealerOnboardingApplications.dealer_code })
            .from(dealerOnboardingApplications)
            .where(
                and(
                    eq(dealerOnboardingApplications.dealer_user_id, user.id),
                    isNotNull(dealerOnboardingApplications.dealer_code),
                ),
            )
            .orderBy(desc(dealerOnboardingApplications.updated_at))
            .limit(1);
        dealerCode = app?.dealer_code?.trim() || null;
    }
    const tenants = await db
        .select({ tenant_id: nbfcUsers.tenant_id })
        .from(nbfcUsers)
        .where(eq(nbfcUsers.user_id, user.id));
    return { id: user.id, role, dealerCode, nbfcTenantIds: tenants.map((t) => t.tenant_id) };
}

async function accountOwnerOf(accountId: string | null | undefined): Promise<string | null> {
    if (!accountId) return null;
    const [row] = await db
        .select({ owner: accountOwnership.owner_user_id })
        .from(accountOwnership)
        .where(eq(accountOwnership.account_id, accountId))
        .limit(1);
    return row?.owner ?? null;
}

async function applicationFacts(applicationId: string | null, bucket: string, key: string): Promise<FileFacts> {
    let appId = applicationId;
    if (!appId) {
        // The file row that points at this object (web form or WhatsApp upload).
        const [doc] = await db
            .select({ application_id: dealerOnboardingDocuments.application_id })
            .from(dealerOnboardingDocuments)
            .where(sql`${dealerOnboardingDocuments.file_url} LIKE ${`%/${bucket}/${key}`}`)
            .limit(1);
        appId = doc?.application_id ?? null;
    }
    if (!appId) return {};
    const [app] = await db
        .select({ dealer_user_id: dealerOnboardingApplications.dealer_user_id })
        .from(dealerOnboardingApplications)
        .where(eq(dealerOnboardingApplications.id, appId))
        .limit(1);
    const [own] = await db
        .select({ owner: accountOwnership.owner_user_id })
        .from(accountOwnership)
        .where(eq(accountOwnership.source_application_id, appId))
        .limit(1);
    return { applicationDealerUserId: app?.dealer_user_id ?? null, accountOwnerId: own?.owner ?? null };
}

async function dealerLeadOwners(ids: string[]): Promise<(string | null)[]> {
    if (ids.length === 0) return [];
    const rows = await db
        .select({ owner: dealerLeads.current_owner_id, asm: dealerLeads.asm_id })
        .from(dealerLeads)
        .where(inArray(dealerLeads.id, ids));
    return rows.flatMap((r) => [r.owner, r.asm]);
}

/** The dealer leads whose call rows point at this recording. */
async function leadsForRecording(key: string): Promise<string[]> {
    const suffix = `%/call-recordings/${key}`;
    const result = await db.execute(sql`
        SELECT lead_id::text AS id FROM bolna_calls WHERE recording_url LIKE ${suffix} AND lead_id IS NOT NULL
        UNION SELECT lead_id::text FROM ai_call_logs WHERE recording_url LIKE ${suffix} AND lead_id IS NOT NULL
        UNION SELECT lead_id::text FROM call_records WHERE recording_url LIKE ${suffix} AND lead_id IS NOT NULL
        UNION SELECT dealer_lead_id FROM lead_touchpoints WHERE recording_url LIKE ${suffix}
        LIMIT 20
    `);
    return rowsOf<{ id: string }>(result).map((r) => r.id);
}

async function factsFor(file: FileKind, bucket: string, key: string): Promise<FileFacts> {
    switch (file.kind) {
        case "customer_lead": {
            const [lead] = await db
                .select({ dealer_id: leads.dealer_id, uploader_id: leads.uploader_id })
                .from(leads)
                .where(eq(leads.id, file.leadId))
                .limit(1);
            if (!lead) return {};
            const shared = await db
                .select({ tenant_id: nbfcLeadAssignments.tenant_id })
                .from(nbfcLeadAssignments)
                .where(eq(nbfcLeadAssignments.lead_id, file.leadId));
            return {
                leadDealerId: lead.dealer_id,
                leadUploaderId: lead.uploader_id,
                sharedTenantIds: shared.map((s) => s.tenant_id),
                // leads.dealer_id is the dealer's account id (users.dealer_id = accounts.id).
                accountOwnerId: await accountOwnerOf(lead.dealer_id),
            };
        }
        case "dealer_lead":
            return { dealerLeadOwnerIds: await dealerLeadOwners([file.dealerLeadId]) };
        case "provider_recording":
            return { dealerLeadOwnerIds: await dealerLeadOwners(await leadsForRecording(key)) };
        case "account":
            return { accountOwnerId: await accountOwnerOf(file.accountId) };
        case "dealer_onboarding":
        case "dealer_agreement":
            return applicationFacts(file.applicationId, bucket, key);
        default:
            return {};
    }
}

/**
 * May this signed-in user open bucket/key? The top roles never touch the
 * database for the facts; everyone else gets exactly one rule evaluation.
 */
export async function canOpenStoredFile(
    user: FileUser,
    bucket: string,
    key: string,
): Promise<{ allowed: boolean; file: FileKind }> {
    const file = classifyFile(bucket, key);
    const role = (user.role ?? "").toLowerCase();
    const viewer = (FILE_TOP_ROLES as readonly string[]).includes(role)
        ? { id: user.id, role, dealerCode: null, nbfcTenantIds: [] }
        : await viewerFor(user);
    const facts = (FILE_TOP_ROLES as readonly string[]).includes(role) ? {} : await factsFor(file, bucket, key);
    // Bills and invoice scans are decided on role alone, so top roles skip facts safely.
    return { allowed: mayOpenFile(viewer, file, facts), file };
}

/**
 * ID 166 point 4: every open of a customer KYC file — allowed or refused,
 * by login or by signed link — is written down. Never throws: a logging
 * failure must not block a legitimate open, but it is reported.
 */
export async function logFileOpen(input: {
    file: FileKind;
    bucket: string;
    key: string;
    userId: string | null;
    role: string | null;
    via: "session" | "signed_link";
    allowed: boolean;
    ip: string | null;
}): Promise<void> {
    if (!isKycFile(input.file)) return;
    const leadId = input.file.kind === "customer_lead" ? input.file.leadId : null;
    try {
        await db.execute(sql`
            INSERT INTO file_access_log (bucket, object_key, lead_id, user_id, role, via, allowed, ip)
            VALUES (${input.bucket}, ${input.key}, ${leadId}, ${input.userId}, ${input.role}, ${input.via}, ${input.allowed}, ${input.ip})
        `);
    } catch (err) {
        console.error("[files] KYC open log failed (is E-339 applied?):", err instanceof Error ? err.message : err);
    }
}
