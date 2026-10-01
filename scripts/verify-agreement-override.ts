// Verifies the tracker ID 55 / E-318 build against the database in DATABASE_URL.
//   node --import tsx --env-file=.env.local scripts/verify-agreement-override.ts
//   node --import tsx --env-file=.env.local scripts/verify-agreement-override.ts --read-files
//
// Leaves nothing behind: the write path runs inside a transaction that is
// always rolled back. It uses the REAL Drizzle tables and the real completion
// column set, so a column that schema.ts names and the database lacks fails
// here rather than in the upload route.
//
// --read-files additionally re-reads every file already recorded in
// dealer_agreement_documents (Gemini + Digio, read-only) and prints what the
// checker now makes of it — how the tightened rules treat real uploads.

import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
    dealerAgreementDocuments,
    dealerAgreementEvents,
    dealerAgreementOverrideRequests,
    dealerOnboardingApplications,
} from "@/lib/db/schema";
import { agreementCompletionValues, readAgreementPdf } from "@/lib/agreement/executedAgreementStore";
import { checkUploadedAgreement } from "@/lib/agreement/readExecutedAgreement";
import { usesManualAgreement } from "@/lib/dealer/dealer-capabilities";

let failed = 0;
const pass = (label: string) => console.log(`PASS  ${label}`);
const fail = (label: string, detail: unknown) => {
    failed += 1;
    console.log(`FAIL  ${label}: ${detail instanceof Error ? detail.message : String(detail)}`);
};
const pgCode = (e: unknown): string | undefined => {
    let cur = e as { code?: string; cause?: unknown } | undefined;
    for (let i = 0; cur && i < 5; i += 1) {
        if (cur.code) return cur.code;
        cur = cur.cause as typeof cur;
    }
    return undefined;
};

class Rollback extends Error {}

async function main() {
    console.log("database:", new URL(process.env.DATABASE_URL!).host.split(".")[0]);

    // ── every column schema.ts names exists ───────────────────────────────
    try {
        await db.select().from(dealerAgreementDocuments).limit(1);
        await db.select().from(dealerAgreementOverrideRequests).limit(1);
        pass("schema.ts columns exist on both tables");
    } catch (e) {
        fail("schema.ts columns exist on both tables", e);
        return;
    }

    const [application] = await db
        .select()
        .from(dealerOnboardingApplications)
        .orderBy(desc(dealerOnboardingApplications.created_at))
        .limit(1);
    if (!application) {
        console.log("SKIP  write path — no dealer application on this database");
    } else {
        // ── the write path, rolled back ───────────────────────────────────
        try {
            await db.transaction(async (tx) => {
                const appId = application.id;
                const docRow = (kind: string, status: string, requestId: string | null) => ({
                    application_id: appId,
                    kind,
                    file_name: `${kind}.pdf`,
                    byte_size: 1234,
                    storage_bucket: "dealer-documents",
                    storage_path: `agreements/${appId}/files/verify-${kind}.pdf`,
                    extracted: { kind },
                    verdict: "mismatch",
                    reasons: ["verify script"],
                    uploaded_by: "user-a",
                    status,
                    override_request_id: requestId,
                });

                // Clear any real pending request for the duration of this transaction.
                await tx
                    .update(dealerAgreementOverrideRequests)
                    .set({ status: "withdrawn" })
                    .where(
                        and(
                            eq(dealerAgreementOverrideRequests.application_id, appId),
                            eq(dealerAgreementOverrideRequests.status, "pending"),
                        ),
                    );

                const [request] = await tx
                    .insert(dealerAgreementOverrideRequests)
                    .values({
                        application_id: appId,
                        add_only: false,
                        provider_document_id: application.provider_document_id,
                        verdict: "mismatch",
                        reasons: ["verify script"],
                        read_values: { signedOn: "2026-09-12" },
                        typed_signed_on: "2026-09-12",
                        typed_ref: "VERIFY-1",
                        request_reason: "verify script — rolled back",
                        requested_by: "user-a",
                    })
                    .returning();
                await tx.insert(dealerAgreementDocuments).values([
                    docRow("signed_agreement", "pending_approval", request.id),
                    docRow("audit_trail", "pending_approval", request.id),
                ]);
                await tx.insert(dealerAgreementEvents).values({
                    application_id: appId,
                    event_type: "manual_override_requested",
                    event_status: "pending_approval",
                    event_payload: { overrideRequestId: request.id },
                });
                pass("request + files + event insert (upload route, not verified)");

                const second = await tx
                    .transaction((sp) =>
                        sp.insert(dealerAgreementOverrideRequests).values({
                            application_id: appId,
                            verdict: "mismatch",
                            request_reason: "second",
                            requested_by: "user-b",
                        }),
                    )
                    .then(() => null, pgCode);
                if (second === "23505") pass("a second pending request is refused (23505)");
                else fail("a second pending request is refused", second ?? "it was accepted");

                const claim = (decidedBy: string) =>
                    tx.transaction((sp) =>
                        sp
                            .update(dealerAgreementOverrideRequests)
                            .set({ status: "approved", decided_by: decidedBy, decided_at: new Date(), decision_note: "ok" })
                            .where(
                                and(
                                    eq(dealerAgreementOverrideRequests.id, request.id),
                                    eq(dealerAgreementOverrideRequests.status, "pending"),
                                ),
                            )
                            .returning({ id: dealerAgreementOverrideRequests.id }),
                    );
                const self = await claim("user-a").then(() => null, pgCode);
                if (self === "23514") pass("the requester approving their own request is refused (23514)");
                else fail("the requester approving their own request is refused", self ?? "it was accepted");

                const claimed = await claim("user-b");
                if (claimed.length === 1) pass("a second person claims the request");
                else fail("a second person claims the request", `${claimed.length} rows`);
                const again = await claim("user-c");
                if (again.length === 0) pass("a decided request cannot be claimed again");
                else fail("a decided request cannot be claimed again", `${again.length} rows`);

                // The completion column set, exactly as both routes write it.
                await tx
                    .update(dealerOnboardingApplications)
                    .set(
                        agreementCompletionValues(application, {
                            manualMode: usesManualAgreement(application.dealer_type),
                            signedOn: "2026-09-12",
                            agreementRef: "VERIFY-1",
                            signedAgreementUrl: undefined,
                            auditTrailUrl: undefined,
                            auditStored: true,
                            now: new Date(),
                        }),
                    )
                    .where(eq(dealerOnboardingApplications.id, appId));
                const accepted = await tx
                    .update(dealerAgreementDocuments)
                    .set({ status: "accepted" })
                    .where(eq(dealerAgreementDocuments.override_request_id, request.id))
                    .returning({ id: dealerAgreementDocuments.id });
                const [after] = await tx
                    .select({
                        status: dealerOnboardingApplications.agreement_status,
                        signedOn: dealerOnboardingApplications.agreement_signed_on,
                        ref: dealerOnboardingApplications.agreement_ref,
                    })
                    .from(dealerOnboardingApplications)
                    .where(eq(dealerOnboardingApplications.id, appId));
                if (
                    accepted.length === 2 &&
                    after.status === "completed" &&
                    after.signedOn === "2026-09-12" &&
                    after.ref === "VERIFY-1"
                ) {
                    pass("approval completes the agreement and accepts its files");
                } else {
                    fail("approval completes the agreement and accepts its files", JSON.stringify({ accepted: accepted.length, after }));
                }

                throw new Rollback();
            });
        } catch (e) {
            if (e instanceof Rollback) pass("write path rolled back — nothing changed");
            else fail("write path", e);
        }

        const [unchanged] = await db
            .select({ status: dealerOnboardingApplications.agreement_status, ref: dealerOnboardingApplications.agreement_ref })
            .from(dealerOnboardingApplications)
            .where(eq(dealerOnboardingApplications.id, application.id));
        if (unchanged.status === application.agreement_status && unchanged.ref === application.agreement_ref) {
            pass("the application is as it was before the run");
        } else {
            fail("the application is as it was before the run", JSON.stringify(unchanged));
        }
    }

    // ── real uploads through the tightened checker (read-only) ────────────
    if (process.argv.includes("--read-files")) {
        const rows = await db.select().from(dealerAgreementDocuments).orderBy(dealerAgreementDocuments.uploaded_at);
        const byApp = new Map<string, typeof rows>();
        for (const r of rows) byApp.set(r.application_id, [...(byApp.get(r.application_id) ?? []), r]);
        for (const [appId, docs] of byApp) {
            const [app] = await db
                .select()
                .from(dealerOnboardingApplications)
                .where(eq(dealerOnboardingApplications.id, appId))
                .limit(1);
            if (!app) {
                console.log(`\n${appId}: application not found — skipped`);
                continue;
            }
            const files: Array<{ kind: "signed_agreement" | "audit_trail"; buffer: Buffer; fileName: string | null }> = [];
            for (const d of docs) {
                const buffer = await readAgreementPdf(d.storage_bucket, d.storage_path);
                if (!buffer) {
                    console.log(`  ${d.file_name}: not in storage — skipped`);
                    continue;
                }
                files.push({ kind: d.kind as "signed_agreement" | "audit_trail", buffer, fileName: d.file_name });
            }
            if (!files.length) continue;
            const { result, docs: read } = await checkUploadedAgreement({
                application: app,
                manualMode: usesManualAgreement(app.dealer_type),
                files,
            });
            console.log(`\n${app.company_name} — recorded as ${docs[0].verdict}, now ${result.verdict}`);
            for (const r of read) {
                console.log(
                    `  ${r.fileName}: ${r.ok ? r.documentType : "unreadable"} · id ${r.documentId ?? "—"} · gstin ${r.gstin ?? "—"} · name ${r.dealerName ?? "—"} · signed ${r.allPartiesSigned}`,
                );
            }
            console.log(`  signed on ${result.signedOn ?? "—"}`);
            for (const reason of result.reasons) console.log(`  - ${reason}`);
        }
    }

    console.log(failed ? `\n${failed} FAILED` : "\nall checks passed");
}

main()
    .catch((e) => {
        console.error(e);
        failed += 1;
    })
    .finally(() => process.exit(failed ? 1 : 0));
