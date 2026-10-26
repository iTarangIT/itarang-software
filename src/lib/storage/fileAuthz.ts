// Loads the facts fileRules.ts needs to decide one file open (tracker ID 166),
// and records every open of a customer KYC file.
//
// Server-only. The decision itself lives in fileRules.ts (pure, unit-tested);
// this file only answers "who owns this file" from the database.

import { and, desc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";

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
import { ACCOUNT_QUOTE_TEAM_ROLES, mayViewAccountQuotes } from "@/lib/accounts/quotationAccess";
import { getTeamMemberIds } from "@/lib/users/team";
import { filesProxyTarget } from "@/lib/storage/fileAccess";
import { supabaseUrlToProxyPath } from "@/lib/storage/legacyUrl";
import {
    classifyFile,
    dealerUploadedFile,
    isLoggedFile,
    loggedLeadId,
    mayOpenFile,
    FILE_TOP_ROLES,
    type FileFacts,
    type FileKind,
    type FileUpload,
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
    let refurbisherId: string | null = null;
    if (role === "refurbisher") {
        // E-292 column; read through to_jsonb so a DB without it reads null.
        const [row] = rowsOf<{ refurbisher_id: string | null }>(
            await db.execute(sql`SELECT to_jsonb(u) ->> 'refurbisher_id' AS refurbisher_id FROM users u WHERE u.id::text = ${user.id} LIMIT 1`),
        );
        refurbisherId = row?.refurbisher_id ?? null;
    }
    return { id: user.id, role, dealerCode, nbfcTenantIds: tenants.map((t) => t.tenant_id), refurbisherId };
}

/** One fact query; a missing table or bad id reads as "no facts" (a refusal), never a 500. */
async function safeRows<T>(label: string, q: SQL): Promise<T[]> {
    try {
        return rowsOf<T>(await db.execute(q));
    } catch (err) {
        console.error(`[files] fact lookup failed (${label}):`, err instanceof Error ? err.message : err);
        return [];
    }
}

/**
 * The dealer leads a quotation, commercials attachment or visit photo belongs
 * to: the commercials row that stores its link, the visit that lists it, or a
 * touchpoint that carries it as an attachment. Visit ASMs count as owners.
 */
async function dealerLeadAttachmentOwners(bucket: string, key: string): Promise<(string | null)[]> {
    const exact = `%/${bucket}/${key}`;
    const inJson = `%/${bucket}/${key}%`;
    const rows = await safeRows<{ dealer_lead_id: string; visitor: string | null }>(
        "dealer lead attachment",
        sql`
            SELECT dealer_lead_id, NULL::text AS visitor FROM dealer_lead_commercials
             WHERE quote_pdf_url LIKE ${exact} OR quote_document_url LIKE ${exact} OR brochure_url LIKE ${exact}
            UNION
            SELECT dealer_lead_id, asm_id AS visitor FROM lead_visits WHERE photos::text LIKE ${inJson}
            UNION
            SELECT dealer_lead_id, NULL::text FROM lead_touchpoints WHERE attachments::text LIKE ${inJson}
            LIMIT 20
        `,
    );
    const owners = await dealerLeadOwners([...new Set(rows.map((r) => r.dealer_lead_id))]);
    return [...owners, ...rows.map((r) => r.visitor)];
}

/**
 * E-358: an account quotation PDF (documents/quotations/ITQA-….pdf) shares the
 * folder with dealer lead quotes but lives on account_quotations. It opens for
 * whoever may read that account's quotations (mayViewAccountQuotes: the owner,
 * the owner's ASM, Partner) — returned as the viewer's id when allowed.
 */
async function accountQuotationViewers(bucket: string, key: string, viewer: FileViewer): Promise<string[]> {
    const rows = await safeRows<{ owner_id: string | null }>(
        "account quotation",
        sql`
            SELECT ao.owner_user_id::text AS owner_id FROM account_quotations q
              LEFT JOIN account_ownership ao ON ao.account_id = q.account_id
             WHERE q.quote_pdf_url LIKE ${`%/${bucket}/${key}`}
             LIMIT 20
        `,
    );
    if (rows.length === 0) return [];
    const teamIds = (ACCOUNT_QUOTE_TEAM_ROLES as readonly string[]).includes(viewer.role)
        ? await getTeamMemberIds(viewer.id)
        : [];
    const ok = rows.some((r) =>
        mayViewAccountQuotes({ role: viewer.role, userId: viewer.id, ownerId: r.owner_id, teamIds }),
    );
    return ok ? [viewer.id] : [];
}

/** Customer lead facts, shared by customer KYC files and the NBFC store's per-lead files. */
async function customerLeadFacts(leadId: string): Promise<FileFacts> {
    const [lead] = await db
        .select({
            dealer_id: leads.dealer_id,
            uploader_id: leads.uploader_id,
            assigned_to: leads.assigned_to,
            sm_assigned_to: leads.sm_assigned_to,
        })
        .from(leads)
        .where(eq(leads.id, leadId))
        .limit(1);
    if (!lead) return {};
    const shared = await db
        .select({ tenant_id: nbfcLeadAssignments.tenant_id })
        .from(nbfcLeadAssignments)
        .where(eq(nbfcLeadAssignments.lead_id, leadId));
    return {
        leadDealerId: lead.dealer_id,
        leadUploaderId: lead.uploader_id,
        leadAssignedTo: lead.assigned_to,
        leadSmAssignedTo: lead.sm_assigned_to,
        sharedTenantIds: shared.map((s) => s.tenant_id),
        // leads.dealer_id is the dealer's account id (users.dealer_id = accounts.id).
        accountOwnerId: await accountOwnerOf(lead.dealer_id),
    };
}

/** The tenant (and lead) of one NBFC case: field visit, video KYC or loan. */
async function nbfcCaseFacts(table: "fi" | "vkyc" | "emi", id: string): Promise<FileFacts> {
    const q =
        table === "fi"
            ? sql`SELECT tenant_id::text AS tenant_id, lead_id FROM field_investigations WHERE id::text = ${id} LIMIT 1`
            : table === "vkyc"
              ? sql`SELECT tenant_id::text AS tenant_id, lead_id FROM video_kyc_verifications WHERE id::text = ${id} LIMIT 1`
              : sql`SELECT nbfc_id::text AS tenant_id, lead_id FROM loan_sanctions WHERE id::text = ${id} LIMIT 1`;
    const [row] = await safeRows<{ tenant_id: string | null; lead_id: string | null }>(`nbfc ${table}`, q);
    if (!row) return {};
    const lead = row.lead_id ? await customerLeadFacts(row.lead_id) : {};
    return { ownerTenantIds: row.tenant_id ? [row.tenant_id] : [], accountOwnerId: lead.accountOwnerId ?? null };
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
        .select({
            dealer_user_id: dealerOnboardingApplications.dealer_user_id,
            salesperson_user_id: dealerOnboardingApplications.salesperson_user_id,
            owner_id: dealerOnboardingApplications.owner_id,
        })
        .from(dealerOnboardingApplications)
        .where(eq(dealerOnboardingApplications.id, appId))
        .limit(1);
    const [own] = await db
        .select({ owner: accountOwnership.owner_user_id })
        .from(accountOwnership)
        .where(eq(accountOwnership.source_application_id, appId))
        .limit(1);
    return {
        applicationDealerUserId: app?.dealer_user_id ?? null,
        accountOwnerId: own?.owner ?? null,
        // ID 166 (18 Oct): the application's owners — same people the Dealer
        // Validation page now lets in (dealerVerificationAccess.ts).
        applicationOwnerIds: [app?.salesperson_user_id ?? null, app?.owner_id ?? null],
    };
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

/**
 * ID 166 (E-349): the rows on this lead that hold exactly this file, with who
 * uploaded each — KYC documents, co-borrower documents and requested
 * documents. The E-349 columns are read through to_jsonb so a DB without the
 * migration reads them as NULL (no uploader: since 18 Oct not the dealer's).
 * A failed lookup refuses (one row with a source and no uploader), never opens.
 */
async function customerFileUploads(leadId: string, bucket: string, key: string): Promise<FileUpload[]> {
    const like = `%/${bucket}/${key}`;
    const all = await leadFileUploads(leadId, like);
    return all.map(({ uploaderId, uploaderDealerCode, source }) => ({ uploaderId, uploaderDealerCode, source }));
}

/** E-349 (16 Oct): uploaders are recorded from here on; older rows have none. */
const LEGACY_UPLOAD_CUTOFF = "2026-10-16T00:00:00+05:30";

/**
 * Every upload record on one lead (or only those whose stored link matches
 * `like`), with the stored link. One query, shared by the file opener and by
 * the dealer-facing lists (dealerViewableFiles) so a list never shows a dealer
 * a link the opener refuses.
 */
async function leadFileUploads(leadId: string, like: string): Promise<(FileUpload & { url: string | null })[]> {
    try {
        const rows = rowsOf<{
            url: string | null;
            uploaded_by: string | null;
            upload_source: string | null;
            uploader_dealer: string | null;
        }>(
            await db.execute(sql`
                -- 21 Oct (live check: every KYC row on production predates E-349
                -- and has no uploader): a row written BEFORE 16 Oct with no
                -- uploader and no source counts as uploaded by whoever created
                -- the lead (leads.uploader_id), marked 'lead_creator'. On the
                -- dealer's own leads that keeps its older files; on a pushed or
                -- house lead the creator is not the dealer, so they stay hidden.
                -- Rows from 16 Oct on record their uploader, so no fallback (a
                -- customer's public-link upload stays the customer's).
                SELECT x.url,
                       COALESCE(x.uploaded_by, CASE WHEN x.legacy THEN l.uploader_id::text END) AS uploaded_by,
                       CASE WHEN x.uploaded_by IS NULL AND x.legacy AND l.uploader_id IS NOT NULL
                            THEN 'lead_creator' ELSE x.upload_source END AS upload_source,
                       u.dealer_id AS uploader_dealer
                  FROM (
                    SELECT y.url, y.uploaded_by, y.upload_source,
                           (y.uploaded_by IS NULL AND y.upload_source IS NULL
                            AND COALESCE(y.made_at, 'epoch'::timestamptz) < ${LEGACY_UPLOAD_CUTOFF}::timestamptz) AS legacy
                      FROM (
                    SELECT k.file_url AS url,
                           COALESCE(to_jsonb(k) ->> 'uploaded_at', to_jsonb(k) ->> 'created_at')::timestamptz AS made_at,
                           k.uploaded_by::text AS uploaded_by,
                           -- ID 183: kyc_documents has no upload_source; an upload
                           -- Admin / Sales Head made acting for the dealer is
                           -- known by its "Done by" record (ACTED_FOR_DEALER,
                           -- changes.file_url) and counts as the dealer's own.
                           CASE WHEN EXISTS (
                             SELECT 1 FROM audit_logs a
                              WHERE a.entity_type = 'lead' AND a.entity_id = k.lead_id
                                AND a.action = 'ACTED_FOR_DEALER'
                                AND a.performed_by = k.uploaded_by
                                AND a.changes ->> 'file_url' = k.file_url
                           ) THEN 'act_for_dealer' END AS upload_source
                      FROM kyc_documents k WHERE k.lead_id = ${leadId} AND k.file_url LIKE ${like}
                    UNION ALL
                    SELECT c.document_url, COALESCE(to_jsonb(c) ->> 'uploaded_at', to_jsonb(c) ->> 'created_at')::timestamptz,
                           to_jsonb(c) ->> 'uploaded_by', to_jsonb(c) ->> 'upload_source'
                      FROM co_borrower_documents c WHERE c.lead_id = ${leadId} AND c.document_url LIKE ${like}
                    UNION ALL
                    SELECT o.file_url, COALESCE(to_jsonb(o) ->> 'uploaded_at', to_jsonb(o) ->> 'created_at')::timestamptz,
                           to_jsonb(o) ->> 'uploaded_by', to_jsonb(o) ->> 'upload_source'
                      FROM other_document_requests o
                     WHERE o.lead_id = ${leadId} AND o.file_url LIKE ${like}
                    UNION ALL
                    SELECT o.document_url, COALESCE(to_jsonb(o) ->> 'uploaded_at', to_jsonb(o) ->> 'created_at')::timestamptz,
                           to_jsonb(o) ->> 'uploaded_by', to_jsonb(o) ->> 'upload_source'
                      FROM other_document_requests o
                     WHERE o.lead_id = ${leadId} AND o.document_url LIKE ${like}
                       AND o.document_url IS DISTINCT FROM o.file_url
                      ) y
                  ) x
                  JOIN leads l ON l.id::text = ${leadId}
                  LEFT JOIN users u ON u.id::text = COALESCE(x.uploaded_by, CASE WHEN x.legacy THEN l.uploader_id::text END)
                 LIMIT 500
            `),
        );
        return rows.map((r) => ({
            url: r.url,
            uploaderId: r.uploaded_by,
            uploaderDealerCode: r.uploader_dealer,
            source: r.upload_source,
        }));
    } catch (err) {
        console.error("[files] uploader lookup failed:", err instanceof Error ? err.message : err);
        return [{ url: null, uploaderId: null, uploaderDealerCode: null, source: "unknown" }];
    }
}

/**
 * ID 166 item 12 (18 Oct): which of these stored links on one customer lead a
 * DEALER may open — the files it uploaded itself (dealerUploadedFile). For
 * every other viewer the answer is "all": their lists already follow the lead
 * rule. A link that is not a stored file (a provider URL) counts as openable.
 * One query for the whole list. The caller has already checked the dealer
 * owns the lead (requireLeadAccess).
 */
export async function dealerViewableFiles(
    user: FileUser,
    leadId: string,
    urls: readonly (string | null | undefined)[],
): Promise<(url: string | null | undefined) => boolean> {
    if ((user.role ?? "").toLowerCase() !== "dealer") return () => true;
    const viewer = await viewerFor(user);
    const uploads = await leadFileUploads(leadId, "%");
    const failed = uploads.some((u) => u.source === "unknown" && !u.url);
    const decided = new Map<string, boolean>();
    for (const url of urls) {
        if (!url || decided.has(url)) continue;
        const suffix = storedSuffix(url);
        if (!suffix) {
            decided.set(url, true);
            continue;
        }
        const mine = uploads.filter((u) => !!u.url && storedSuffix(u.url) === suffix);
        decided.set(url, !failed && dealerUploadedFile(viewer, mine));
    }
    return (url) => !url || decided.get(url) !== false;
}

/** `/<bucket>/<key>` of a stored link (relative or absolute), decoded the way the proxy decodes it. */
function storedSuffix(url: string): string | null {
    const t = filesProxyTarget(supabaseUrlToProxyPath(url) ?? url);
    return t ? `/${t.bucket}/${t.key}` : null;
}

async function factsFor(file: FileKind, bucket: string, key: string, viewer: FileViewer): Promise<FileFacts> {
    switch (file.kind) {
        case "customer_lead": {
            const facts = await customerLeadFacts(file.leadId);
            // Only a dealer is limited to its own uploads; nobody else pays for the lookup.
            if (viewer.role !== "dealer") return facts;
            return { ...facts, fileUploads: await customerFileUploads(file.leadId, bucket, key) };
        }
        case "nbfc_lead":
            return customerLeadFacts(file.leadId);
        case "autofill_scan":
            // The dealer is decided on the key alone; the lead's owners only
            // when the scan names a lead.
            return file.leadId && viewer.role !== "dealer" ? customerLeadFacts(file.leadId) : {};
        case "nbfc_case":
            return nbfcCaseFacts(file.table, file.id);
        case "nbfc_partner_doc": {
            const [row] = await safeRows<{ tenant_id: string | null }>(
                "nbfc partner",
                sql`SELECT tenant_id::text AS tenant_id FROM nbfc WHERE id = ${file.nbfcId} LIMIT 1`,
            );
            return { ownerTenantIds: row?.tenant_id ? [row.tenant_id] : [] };
        }
        case "dealer_lead_attachment": {
            const owners = await dealerLeadAttachmentOwners(bucket, key);
            if (file.source !== "quotation") return { dealerLeadOwnerIds: owners };
            return { dealerLeadOwnerIds: [...owners, ...(await accountQuotationViewers(bucket, key, viewer))] };
        }
        case "buyback": {
            if (!file.requestId) return {};
            const [row] = await safeRows<{ dealer_entity_id: string | null }>(
                "buyback request",
                sql`SELECT dealer_entity_id FROM buyback_requests WHERE id::text = ${file.requestId} LIMIT 1`,
            );
            return { buybackDealerId: row?.dealer_entity_id ?? null };
        }
        case "feature_request": {
            const [row] = await safeRows<{ ok: boolean }>(
                "feature seat",
                sql`SELECT TRUE AS ok FROM feature_request_members WHERE user_id::text = ${viewer.id} AND is_active LIMIT 1`,
            );
            return { hasFeatureSeat: !!row };
        }
        case "auction_battery": {
            const [battery] = await safeRows<{ tenant_id: string | null }>(
                "recovery battery",
                sql`SELECT tenant_id::text AS tenant_id FROM recovery_batteries WHERE id::text = ${file.batteryId} LIMIT 1`,
            );
            // Only a dealer can be in an auction audience; ask only for its own code.
            const audience =
                viewer.role === "dealer" && viewer.dealerCode
                    ? await safeRows<{ dealer_id: string }>(
                          "auction audience",
                          sql`
                              SELECT a.dealer_id FROM auction_lot_items i
                                JOIN auction_lot_audience a ON a.lot_id = i.lot_id
                               WHERE i.battery_id::text = ${file.batteryId} AND a.dealer_id = ${viewer.dealerCode}
                               LIMIT 1
                          `,
                      )
                    : [];
            return {
                ownerTenantIds: battery?.tenant_id ? [battery.tenant_id] : [],
                audienceDealerIds: audience.map((a) => a.dealer_id),
            };
        }
        case "refurb_lot": {
            const [lot] = await safeRows<{ tenant_id: string | null; refurbisher_id: string | null }>(
                "refurbishment lot",
                sql`SELECT tenant_id::text AS tenant_id, refurbisher_id::text AS refurbisher_id FROM refurbishment_lots WHERE id::text = ${file.lotId} LIMIT 1`,
            );
            return { ownerTenantIds: lot?.tenant_id ? [lot.tenant_id] : [], refurbisherId: lot?.refurbisher_id ?? null };
        }
        case "recovery_visit": {
            const [row] = await safeRows<{ tenant_id: string | null }>(
                "recovery assignment",
                sql`SELECT tenant_id::text AS tenant_id FROM recovery_assignments WHERE id::text = ${file.assignmentId} LIMIT 1`,
            );
            return { ownerTenantIds: row?.tenant_id ? [row.tenant_id] : [] };
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
    const isTop = (FILE_TOP_ROLES as readonly string[]).includes(role);
    const viewer: FileViewer = isTop ? { id: user.id, role, dealerCode: null, nbfcTenantIds: [] } : await viewerFor(user);
    // Every kind lets the top roles in on role alone (bills and invoice scans
    // decide on role too), so they skip the fact lookups safely.
    const facts = isTop ? {} : await factsFor(file, bucket, key, viewer);
    return { allowed: mayOpenFile(viewer, file, facts), file };
}

/**
 * ID 166 point 4: every open of a customer KYC file — allowed or refused,
 * by login or by signed link — is written down; since 16 Oct also a dealer's
 * onboarding papers and the NBFC store's identity files (isLoggedFile). Never
 * throws: a logging failure must not block a legitimate open, but it is
 * reported.
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
    if (!isLoggedFile(input.file)) return;
    const leadId = loggedLeadId(input.file);
    try {
        await db.execute(sql`
            INSERT INTO file_access_log (bucket, object_key, lead_id, user_id, role, via, allowed, ip)
            VALUES (${input.bucket}, ${input.key}, ${leadId}, ${input.userId}, ${input.role}, ${input.via}, ${input.allowed}, ${input.ip})
        `);
    } catch (err) {
        console.error("[files] KYC open log failed (is E-339 applied?):", err instanceof Error ? err.message : err);
    }
}
