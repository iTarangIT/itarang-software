// Initiates a DigiLocker SSO session for the lead-creation flow.
// Unlike the admin KYC initiate (which sends an SMS link to the
// customer), this one returns the authorization URL straight to the
// UI so the dealer can open it in a popup while the customer is
// sitting with them. No SMS/WhatsApp notification is sent.

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads, digilockerTransactions } from "@/lib/db/schema";
import { digilockerInitiateSession } from "@/lib/decentro";
import { createWorkflowId } from "@/lib/kyc/admin-workflow";
import { requireRole } from "@/lib/auth-utils";

const LINK_VALIDITY_HOURS = 24;

// Derive the public origin the browser sees from the incoming request.
// Honours Vercel's x-forwarded-host/proto so the callback URL always
// points back at the exact deployment that initiated the flow — sandbox,
// preview, prod, or localhost — regardless of NEXT_PUBLIC_APP_URL
// being set correctly in each env.
function resolvePublicOrigin(req: NextRequest): string {
    const forwardedHost = req.headers.get("x-forwarded-host");
    const forwardedProto = req.headers.get("x-forwarded-proto");
    if (forwardedHost) {
        return `${forwardedProto || "https"}://${forwardedHost}`;
    }
    const host = req.headers.get("host");
    if (host) {
        const proto = host.startsWith("localhost") ? "http" : "https";
        return `${proto}://${host}`;
    }
    return req.nextUrl.origin;
}

export async function POST(req: NextRequest) {
    try {
        const user = await requireRole(["dealer"]);

        const body = (await req.json().catch(() => ({}))) as {
            leadId?: string;
            phone?: string;
        };

        const leadId = typeof body.leadId === "string" ? body.leadId.trim() : "";
        if (!leadId) {
            return NextResponse.json(
                { success: false, error: { message: "leadId is required" } },
                { status: 400 },
            );
        }

        // Ownership check — the dealer who owns the draft must be the
        // one initiating the KYC. Prevents lead-id guessing.
        const leadRows = await db
            .select()
            .from(leads)
            .where(eq(leads.id, leadId))
            .limit(1);
        const lead = leadRows[0];
        if (!lead) {
            return NextResponse.json(
                { success: false, error: { message: "Lead not found" } },
                { status: 404 },
            );
        }
        if (lead.uploader_id && lead.uploader_id !== user.id) {
            return NextResponse.json(
                { success: false, error: { message: "Not authorized for this lead" } },
                { status: 403 },
            );
        }

        // Reuse an in-flight session if the dealer clicks the button twice
        // before the first popup completes — avoids spamming Decentro.
        const now = new Date();
        const digiId = createWorkflowId("DIGI", now);
        const referenceId = `LEAD-DIGI-${leadId}-${Date.now()}`;
        const callbackBase = resolvePublicOrigin(req);
        const redirectUrl = `${callbackBase}/api/leads/digilocker/callback/${encodeURIComponent(digiId)}`;

        // Decentro caps consent_purpose at 50 chars.
        const decentroRes = await digilockerInitiateSession({
            reference_id: referenceId,
            redirect_url: redirectUrl,
            consent_purpose: "Aadhaar verification for lead creation",
        });

        const resData = decentroRes?.data ?? {};
        const authorizationUrl =
            resData.authorizationUrl ||
            resData.authorization_url ||
            resData.digilocker_url ||
            resData.url ||
            null;
        const decentroTxnId =
            decentroRes?.decentroTxnId ||
            resData.decentroTxnId ||
            resData.decentro_transaction_id ||
            null;
        const sessionId = resData.session_id ?? null;

        const apiSuccess =
            (decentroRes?.status === "SUCCESS" ||
                decentroRes?.responseStatus === "SUCCESS") &&
            authorizationUrl &&
            decentroTxnId;

        if (!apiSuccess) {
            console.error(
                "[leads/digilocker/initiate] Decentro failure:",
                JSON.stringify(decentroRes),
            );
            return NextResponse.json(
                {
                    success: false,
                    error: {
                        message:
                            decentroRes?.message ||
                            "Failed to initiate DigiLocker session",
                    },
                },
                { status: 502 },
            );
        }

        const expiresAt = resData.expires_at
            ? new Date(resData.expires_at)
            : new Date(now.getTime() + LINK_VALIDITY_HOURS * 60 * 60 * 1000);

        const phone =
            (typeof body.phone === "string" && body.phone.trim()) ||
            lead.phone ||
            lead.mobile ||
            "UNKNOWN";

        await db.insert(digilockerTransactions).values({
            id: digiId,
            lead_id: leadId,
            reference_id: referenceId,
            decentro_txn_id: decentroTxnId,
            session_id: sessionId,
            status: "initiated",
            customer_phone: phone,
            digilocker_url: authorizationUrl,
            notification_channel: "sms",
            expires_at: expiresAt,
        });

        return NextResponse.json({
            success: true,
            data: {
                transactionId: digiId,
                authorizationUrl,
                expiresAt: expiresAt.toISOString(),
            },
        });
    } catch (error) {
        console.error("[leads/digilocker/initiate] Error:", error);
        const message =
            error instanceof Error
                ? error.message === "Forbidden: Insufficient permissions"
                    ? "Forbidden"
                    : error.message
                : "Failed to initiate DigiLocker";
        const status =
            message === "Forbidden" ? 403 : 500;
        return NextResponse.json(
            { success: false, error: { message } },
            { status },
        );
    }
}
