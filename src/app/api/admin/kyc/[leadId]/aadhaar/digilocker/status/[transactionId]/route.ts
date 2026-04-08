import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  dealerLeads,
  digilockerTransactions,
  kycVerifications,
  personalDetails,
} from "@/lib/db/schema";
import { digilockerCheckStatus } from "@/lib/decentro";
import {
  crossMatchAadhaarData,
  type CrossMatchResult,
} from "@/lib/kyc/cross-match";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";

export async function GET(
  _req: NextRequest,
  {
    params,
  }: { params: Promise<{ leadId: string; transactionId: string }> },
) {
  try {
    const appUser = await requireAdminAppUser();
    if (!appUser) {
      return NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 403 },
      );
    }

    const { leadId, transactionId } = await params;

    // Fetch transaction
    const txnRows = await db
      .select()
      .from(digilockerTransactions)
      .where(
        and(
          eq(digilockerTransactions.id, transactionId),
          eq(digilockerTransactions.lead_id, leadId),
        ),
      )
      .limit(1);

    const txn = txnRows[0];
    if (!txn) {
      return NextResponse.json(
        {
          success: false,
          error: { message: "DigiLocker transaction not found" },
        },
        { status: 404 },
      );
    }

    // If already fetched, return cached data
    if (txn.status === "document_fetched" && txn.aadhaar_extracted_data) {
      return NextResponse.json({
        success: true,
        data: {
          transactionId: txn.id,
          status: txn.status,
          linkOpened: true,
          digilockerLoginComplete: true,
          consentGiven: true,
          documentFetched: true,
          aadhaarData: txn.aadhaar_extracted_data,
          crossMatchResult: txn.cross_match_result,
          linkExpiresAt: txn.expires_at?.toISOString(),
          timeRemaining: null,
        },
      });
    }

    // If expired
    if (txn.expires_at && new Date() > txn.expires_at) {
      if (txn.status !== "expired" && txn.status !== "document_fetched") {
        await db
          .update(digilockerTransactions)
          .set({ status: "expired", updated_at: new Date() })
          .where(eq(digilockerTransactions.id, transactionId));
      }

      return NextResponse.json({
        success: true,
        data: {
          transactionId: txn.id,
          status: "expired",
          linkOpened: !!txn.link_opened_at,
          digilockerLoginComplete: false,
          consentGiven: false,
          documentFetched: false,
          linkExpiresAt: txn.expires_at?.toISOString(),
          timeRemaining: "0",
        },
      });
    }

    // Poll Decentro for status if we have a txn ID
    let updatedStatus = txn.status;
    let aadhaarData = txn.aadhaar_extracted_data;
    let crossMatchResult = txn.cross_match_result as CrossMatchResult | null;

    if (txn.decentro_txn_id && txn.status !== "failed") {
      const statusRes = await digilockerCheckStatus(txn.decentro_txn_id);
      const remoteData = statusRes?.data || {};

      const now = new Date();
      const updates: Record<string, unknown> = { updated_at: now };

      if (remoteData.link_opened && txn.status === "link_sent") {
        updatedStatus = "link_opened";
        updates.status = "link_opened";
        updates.link_opened_at = now;
      }

      if (remoteData.consent_given && updatedStatus !== "document_fetched") {
        updatedStatus = "consent_given";
        updates.status = "consent_given";
        updates.customer_authorized_at = now;
      }

      if (remoteData.document_fetched || remoteData.aadhaar_data) {
        updatedStatus = "document_fetched";
        updates.status = "document_fetched";
        updates.digilocker_raw_response = statusRes;

        // Extract Aadhaar fields
        const raw = remoteData.aadhaar_data || remoteData;
        aadhaarData = {
          uid: raw.uid || raw.aadhaar_number || null,
          name: raw.name || null,
          gender: raw.gender || null,
          dob: raw.dob || raw.date_of_birth || null,
          careof: raw.careof || raw.care_of || null,
          address: raw.address || raw.full_address || null,
          district: raw.dist || raw.district || null,
          state: raw.state || null,
          pincode: raw.pincode || raw.zip || null,
          photo_base64: raw.photo_base64 || raw.photo || null,
          mobile: raw.mobile || raw.phone || null,
        };
        updates.aadhaar_extracted_data = aadhaarData;

        // Cross-match with lead data
        const [leadRows, personalRows] = await Promise.all([
          db
            .select()
            .from(dealerLeads)
            .where(eq(dealerLeads.id, leadId))
            .limit(1),
          db
            .select()
            .from(personalDetails)
            .where(eq(personalDetails.lead_id, leadId))
            .limit(1),
        ]);

        const lead = leadRows[0];
        const personal = personalRows[0];

        if (lead) {
          crossMatchResult = crossMatchAadhaarData(
            {
              name: (aadhaarData as Record<string, string>).name,
              dob: (aadhaarData as Record<string, string>).dob,
              phone: (aadhaarData as Record<string, string>).mobile,
              address: (aadhaarData as Record<string, string>).address,
              gender: (aadhaarData as Record<string, string>).gender,
              fatherOrHusbandName: (aadhaarData as Record<string, string>).careof,
            },
            {
              name: lead.dealer_name,
              dob: personal?.dob
                ? new Date(personal.dob).toISOString().slice(0, 10)
                : null,
              phone: lead.phone,
              address: personal?.local_address || lead.location,
              gender: null,
              fatherOrHusbandName: personal?.father_husband_name,
            },
          );
          updates.cross_match_result = crossMatchResult;
        }

        // Update verification record
        if (txn.verification_id) {
          await db
            .update(kycVerifications)
            .set({
              status: crossMatchResult?.overallPass
                ? "success"
                : "failed",
              api_response: statusRes,
              match_score: crossMatchResult?.nameSimilarity
                ? String(crossMatchResult.nameSimilarity)
                : null,
              completed_at: now,
              updated_at: now,
            })
            .where(eq(kycVerifications.id, txn.verification_id));
        }
      }

      if (Object.keys(updates).length > 1) {
        await db
          .update(digilockerTransactions)
          .set(updates)
          .where(eq(digilockerTransactions.id, transactionId));
      }
    }

    // Calculate time remaining
    let timeRemaining: string | null = null;
    if (txn.expires_at) {
      const ms = txn.expires_at.getTime() - Date.now();
      if (ms > 0) {
        const hours = Math.floor(ms / (1000 * 60 * 60));
        const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
        timeRemaining = `${hours} hours ${minutes} minutes`;
      } else {
        timeRemaining = "0";
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        transactionId: txn.id,
        status: updatedStatus,
        linkOpened:
          updatedStatus === "link_opened" ||
          updatedStatus === "consent_given" ||
          updatedStatus === "document_fetched",
        digilockerLoginComplete:
          updatedStatus === "consent_given" ||
          updatedStatus === "document_fetched",
        consentGiven:
          updatedStatus === "consent_given" ||
          updatedStatus === "document_fetched",
        documentFetched: updatedStatus === "document_fetched",
        aadhaarData,
        crossMatchResult,
        linkExpiresAt: txn.expires_at?.toISOString(),
        timeRemaining,
      },
    });
  } catch (error) {
    console.error("[DigiLocker Status] Error:", error);
    const message =
      error instanceof Error
        ? error.message
        : "Failed to check DigiLocker status";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
