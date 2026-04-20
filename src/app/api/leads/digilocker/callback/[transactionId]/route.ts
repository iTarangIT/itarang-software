// Public redirect target from Decentro DigiLocker after the customer
// finishes (or cancels) the SSO consent. Runs in a popup window opened
// by the dealer. Fetches the eAadhaar, normalizes it into the same
// shape the OCR autofill produces, persists a kyc_verifications row
// tagged as government-verified, then returns a tiny HTML page that
// postMessages the extracted data back to the opener and closes.

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
    digilockerTransactions,
    kycVerifications,
} from "@/lib/db/schema";
import { digilockerGetEaadhaar } from "@/lib/decentro";
import { createWorkflowId } from "@/lib/kyc/admin-workflow";
import {
    buildFinalData,
    extractStructuredAadhaar,
    type FinalAadhaarData,
} from "@/lib/kyc/aadhaarNormalize";

// Escape </script> and </style> so injected JSON can't close the
// surrounding <script> tag and break out.
function safeJson(value: unknown): string {
    return JSON.stringify(value).replace(/</g, "\\u003c");
}

function renderResultHtml(opts: {
    origin: string;
    ok: boolean;
    transactionId: string;
    data?: FinalAadhaarData;
    error?: string;
}): string {
    const payload = {
        type: "itarang:digilocker",
        ok: opts.ok,
        transactionId: opts.transactionId,
        data: opts.data ?? null,
        error: opts.error ?? null,
    };
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>DigiLocker — ${opts.ok ? "Success" : "Failed"}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #F8F9FB; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; color: #1f2937; }
  .card { background: white; padding: 32px 40px; border-radius: 16px; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08); text-align: center; max-width: 360px; }
  .icon { width: 56px; height: 56px; border-radius: 50%; margin: 0 auto 16px; display: flex; align-items: center; justify-content: center; font-size: 28px; }
  .ok { background: #ecfdf5; color: #059669; }
  .err { background: #fef2f2; color: #dc2626; }
  h1 { font-size: 18px; margin: 0 0 8px; font-weight: 700; }
  p { font-size: 13px; color: #6b7280; margin: 0; line-height: 1.5; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon ${opts.ok ? "ok" : "err"}">${opts.ok ? "✓" : "!"}</div>
    <h1>${opts.ok ? "Aadhaar verified" : "Verification failed"}</h1>
    <p>${opts.ok ? "You can close this window." : opts.error ?? "Please try again."}</p>
  </div>
<script>
(function () {
  var payload = ${safeJson(payload)};
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(payload, ${safeJson(opts.origin)});
    }
  } catch (e) { /* noop */ }
  setTimeout(function () { try { window.close(); } catch (e) {} }, 800);
})();
</script>
</body>
</html>`;
}

function htmlResponse(html: string): NextResponse {
    return new NextResponse(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
    });
}

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ transactionId: string }> },
) {
    const origin = new URL(req.url).origin;
    const { transactionId } = await params;
    const url = new URL(req.url);
    const status = url.searchParams.get("status");
    const decentroTxnIdFromQuery = url.searchParams.get(
        "initiation_decentro_transaction_id",
    );

    try {
        const txnRows = await db
            .select()
            .from(digilockerTransactions)
            .where(eq(digilockerTransactions.id, transactionId))
            .limit(1);

        const txn = txnRows[0];
        if (!txn) {
            return htmlResponse(
                renderResultHtml({
                    origin,
                    ok: false,
                    transactionId,
                    error: "Transaction not found.",
                }),
            );
        }

        const now = new Date();

        // Terminal rejection / cancellation from Decentro.
        if (status && status !== "SUCCESS") {
            await db
                .update(digilockerTransactions)
                .set({ status: "failed", updated_at: now })
                .where(eq(digilockerTransactions.id, transactionId));
            return htmlResponse(
                renderResultHtml({
                    origin,
                    ok: false,
                    transactionId,
                    error: `DigiLocker reported: ${status}`,
                }),
            );
        }

        // Idempotency — if we've already fetched eAadhaar for this txn,
        // just re-post the stored data and close.
        if (
            txn.status === "document_fetched" &&
            txn.aadhaar_extracted_data &&
            typeof txn.aadhaar_extracted_data === "object"
        ) {
            return htmlResponse(
                renderResultHtml({
                    origin,
                    ok: true,
                    transactionId,
                    data: txn.aadhaar_extracted_data as FinalAadhaarData,
                }),
            );
        }

        const decentroTxnId = decentroTxnIdFromQuery || txn.decentro_txn_id;
        if (!decentroTxnId) {
            await db
                .update(digilockerTransactions)
                .set({ status: "failed", updated_at: now })
                .where(eq(digilockerTransactions.id, transactionId));
            return htmlResponse(
                renderResultHtml({
                    origin,
                    ok: false,
                    transactionId,
                    error: "Missing Decentro transaction id.",
                }),
            );
        }

        // Mark consent received before the eAadhaar fetch so polling
        // observers see progress even if the fetch is slow.
        await db
            .update(digilockerTransactions)
            .set({
                status: "consent_given",
                customer_authorized_at: now,
                decentro_txn_id: decentroTxnId,
                updated_at: now,
            })
            .where(eq(digilockerTransactions.id, transactionId));

        const eaadhaarRes = await digilockerGetEaadhaar({
            initial_decentro_transaction_id: decentroTxnId,
            reference_id: `${txn.reference_id}-FETCH`,
            consent_purpose:
                "Aadhaar verification via DigiLocker for lead creation",
        });

        const responseStatus =
            eaadhaarRes?.status || eaadhaarRes?.responseStatus;
        if (responseStatus !== "SUCCESS") {
            await db
                .update(digilockerTransactions)
                .set({
                    status: "failed",
                    digilocker_raw_response: eaadhaarRes,
                    updated_at: now,
                })
                .where(eq(digilockerTransactions.id, transactionId));
            return htmlResponse(
                renderResultHtml({
                    origin,
                    ok: false,
                    transactionId,
                    error:
                        eaadhaarRes?.message ||
                        "Decentro eAadhaar fetch failed.",
                }),
            );
        }

        // eAadhaar responses nest fields similarly to OCR responses, so
        // the same extractor produces consistent output.
        const structured = extractStructuredAadhaar(eaadhaarRes);
        const finalData = buildFinalData(
            structured,
            extractStructuredAadhaar(null),
        );

        await db
            .update(digilockerTransactions)
            .set({
                status: "document_fetched",
                digilocker_raw_response: eaadhaarRes,
                aadhaar_extracted_data: finalData,
                updated_at: now,
            })
            .where(eq(digilockerTransactions.id, transactionId));

        // Persist a kyc_verifications row so the later KYC step sees
        // Aadhaar as already government-verified. We flag the api
        // provider distinctly from the OCR pathway.
        try {
            const verificationId = createWorkflowId("KYCVER", now);
            await db.insert(kycVerifications).values({
                id: verificationId,
                lead_id: txn.lead_id,
                verification_type: "aadhaar",
                applicant: "primary",
                status: "success",
                api_provider: "decentro_digilocker",
                api_request: {
                    reference_id: txn.reference_id,
                    transaction_id: transactionId,
                },
                api_response: finalData,
                submitted_at: txn.created_at ?? now,
                completed_at: now,
            });
            await db
                .update(digilockerTransactions)
                .set({ verification_id: verificationId, updated_at: now })
                .where(eq(digilockerTransactions.id, transactionId));
        } catch (verErr) {
            console.error(
                "[leads/digilocker/callback] kyc_verifications insert failed:",
                verErr,
            );
            // Non-fatal — the form prefill still works.
        }

        return htmlResponse(
            renderResultHtml({
                origin,
                ok: true,
                transactionId,
                data: finalData,
            }),
        );
    } catch (error) {
        console.error("[leads/digilocker/callback] Error:", error);
        return htmlResponse(
            renderResultHtml({
                origin,
                ok: false,
                transactionId,
                error: "Unexpected error — please try again.",
            }),
        );
    }
}
