// Storage + write helpers shared by the two routes that can put a manually
// executed dealer agreement on record (tracker ID 55):
//
//   upload-signed-agreement            a VERIFIED upload completes at once
//   agreement-override/[requestId]     a mismatch completes only when a SECOND
//                                      approver accepts it (E-318)
//
// Both must write exactly the same thing, so the column set lives here.

import { isS3Backend, putObject, filesProxyPath } from "@/lib/storage/s3";
import { readBucketObject } from "@/lib/storage/readStoredDocument";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { dealerOnboardingApplications } from "@/lib/db/schema";

export const AGREEMENT_BUCKET = "dealer-documents";

// Canonical paths — identical to ensureDealer*Url() and the download routes, so
// everything downstream resolves the manually uploaded copy. They hold the
// FIRST signed agreement / audit trail; every file also has a key of its own.
export const signedAgreementPath = (applicationId: string) => `agreements/${applicationId}/signed-agreement.pdf`;
export const auditTrailPath = (applicationId: string) => `agreements/${applicationId}/audit-trail.pdf`;

export { OVERRIDE_REASON_MIN } from "@/lib/agreement/executedAgreementCheck";

export async function storeAgreementPdf(path: string, buffer: Buffer): Promise<string | undefined> {
    if (isS3Backend) {
        await putObject(AGREEMENT_BUCKET, path, buffer, "application/pdf");
        return filesProxyPath(AGREEMENT_BUCKET, path);
    }
    const { error } = await supabaseAdmin.storage
        .from(AGREEMENT_BUCKET)
        .upload(path, buffer, { contentType: "application/pdf", upsert: true });
    if (error) throw new Error(`Failed to store ${path}: ${error.message}`);
    return supabaseAdmin.storage.from(AGREEMENT_BUCKET).getPublicUrl(path).data?.publicUrl;
}

export const readAgreementPdf = (bucket: string, path: string) => readBucketObject(bucket, path);

type Application = typeof dealerOnboardingApplications.$inferSelect;

/**
 * The column set that flips an agreement to completed (mirrors
 * refresh-agreement). `signedAgreementUrl` / `auditTrailUrl` are the canonical
 * copies just stored; `auditStored` says whether an audit trail was.
 */
export function agreementCompletionValues(
    application: Application,
    p: {
        manualMode: boolean;
        signedOn: string | null;
        agreementRef: string | null;
        signedAgreementUrl: string | undefined;
        auditTrailUrl: string | undefined;
        auditStored: boolean;
        now: Date;
    },
) {
    return {
        agreement_status: "completed",
        // An already-approved dealer completing their agreement via the
        // post-approval finance-enablement flow stays "approved" — rewinding
        // review_status would put a live dealer back in the pending queue.
        ...(application.onboarding_status === "approved"
            ? {}
            : { review_status: "agreement_completed", completion_status: "completed" }),
        signed_agreement_url: p.signedAgreementUrl || application.signed_agreement_url,
        signed_agreement_storage_path: signedAgreementPath(application.id),
        audit_trail_url: p.auditTrailUrl || application.audit_trail_url,
        // Only claim an audit trail when one was actually stored — otherwise a
        // manual-mode row would advertise a path the download route then 404s on.
        ...(p.auditStored ? { audit_trail_storage_path: auditTrailPath(application.id) } : {}),
        // E-225 — record HOW this was executed, and the paper's own provenance.
        agreement_mode: p.manualMode ? "manual" : application.agreement_mode ?? "esign",
        ...(p.agreementRef ? { agreement_ref: p.agreementRef } : {}),
        ...(p.signedOn ? { agreement_signed_on: p.signedOn } : {}),
        agreement_completed_at: application.agreement_completed_at || p.now,
        // The day the documents show the last party signed, over "when an admin
        // got round to uploading it" — signed_at is what the rest of the app
        // displays.
        signed_at:
            application.signed_at || (p.signedOn ? new Date(`${p.signedOn}T00:00:00+05:30`) : p.now),
        agreement_failure_reason: null,
        last_action_timestamp: p.now,
        updated_at: p.now,
    };
}

/** Postgres "relation / column does not exist" — E-313 or E-318 is not applied here. */
export function isMissingSchemaError(err: unknown): boolean {
    const seen = new Set<unknown>();
    let e = err as { code?: string; cause?: unknown } | null | undefined;
    while (e && !seen.has(e)) {
        seen.add(e);
        if (e.code === "42P01" || e.code === "42703") return true;
        e = e.cause as typeof e;
    }
    return false;
}

export const MIGRATION_MISSING_MESSAGE =
    "This host's database is missing migration E-318 (dealer agreement override requests). Apply it, then try again.";
