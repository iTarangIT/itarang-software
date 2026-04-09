import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  leads,
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

    // If already fetched, return cached data — but only if data is actually populated
    const cachedData = txn.aadhaar_extracted_data as Record<string, string | null> | null;
    const cachedCross = txn.cross_match_result as Record<string, unknown> | null;
    const crossFields = Array.isArray(cachedCross?.fields) ? cachedCross.fields as Record<string, unknown>[] : [];
    const hasCorrectFormat = crossFields.length > 0 && 'leadValue' in (crossFields[0] || {});
    const hasRealData = cachedData && (cachedData.name || cachedData.uid) && hasCorrectFormat;
    if (txn.status === "document_fetched" && hasRealData) {
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
    // IMPORTANT: Only call Decentro API after consent_given stage.
    // Calling eAadhaar endpoint too early (during link_sent) can invalidate the session.
    let updatedStatus = txn.status;
    let aadhaarData = txn.aadhaar_extracted_data;
    let crossMatchResult = txn.cross_match_result as CrossMatchResult | null;

    const shouldPollDecentro = txn.decentro_txn_id
      && txn.status !== "failed"
      && txn.status !== "link_sent"
      && (txn.status !== "document_fetched" || !hasRealData);

    if (shouldPollDecentro) {
      const statusRes = await digilockerCheckStatus(txn.decentro_txn_id!);
      console.log("[DigiLocker Status] Decentro eAadhaar response:", JSON.stringify(statusRes));
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

      // Check if eAadhaar data is available — Decentro may return it under various keys
      const hasDocument = remoteData.document_fetched
        || remoteData.aadhaar_data
        || remoteData.kycResult
        || remoteData.name  // eAadhaar fields directly in data
        || statusRes?.kycResult
        || (statusRes?.status === "SUCCESS" && statusRes?.responseKey?.includes("eaadhaar"));

      if (hasDocument) {
        updatedStatus = "document_fetched";
        updates.status = "document_fetched";
        updates.digilocker_raw_response = statusRes;

        // Extract Aadhaar fields — Decentro returns proofOfIdentity + proofOfAddress
        const poi = remoteData.proofOfIdentity || {};
        const poa = remoteData.proofOfAddress || {};
        const raw = remoteData.aadhaar_data || statusRes?.kycResult || remoteData;

        // Build full address from proofOfAddress components
        const addressParts = [
          poa.house, poa.street, poa.landmark, poa.locality,
          poa.vtc, poa.subDistrict, poa.district, poa.state, poa.pincode,
        ].filter(Boolean);
        const fullAddress = addressParts.length > 0 ? addressParts.join(", ") : (raw.address || raw.full_address || null);

        aadhaarData = {
          uid: remoteData.aadhaarUid || raw.uid || raw.aadhaar_number || null,
          name: poi.name || raw.name || null,
          gender: poi.gender || raw.gender || null,
          dob: poi.dob || raw.dob || raw.date_of_birth || null,
          careof: poa.careOf || poa.careof || raw.careof || raw.care_of || null,
          address: fullAddress,
          district: poa.district || raw.dist || raw.district || null,
          state: poa.state || raw.state || null,
          pincode: poa.pincode || raw.pincode || raw.zip || null,
          photo_base64: remoteData.image || raw.photo_base64 || raw.photo || null,
          mobile: poi.hashedMobileNumber || raw.mobile || raw.phone || null,
        };
        updates.aadhaar_extracted_data = aadhaarData;

        // Cross-match with lead data
        const [leadRows, personalRows] = await Promise.all([
          db
            .select()
            .from(leads)
            .where(eq(leads.id, leadId))
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
          const rawCrossMatch = crossMatchAadhaarData(
            {
              name: (aadhaarData as Record<string, string>).name,
              dob: (aadhaarData as Record<string, string>).dob,
              phone: (aadhaarData as Record<string, string>).mobile,
              address: (aadhaarData as Record<string, string>).address,
              gender: (aadhaarData as Record<string, string>).gender,
              fatherOrHusbandName: (aadhaarData as Record<string, string>).careof,
            },
            {
              name: lead.full_name || lead.owner_name,
              dob: lead.dob
                ? new Date(lead.dob).toISOString().slice(0, 10)
                : personal?.dob
                  ? new Date(personal.dob).toISOString().slice(0, 10)
                  : null,
              phone: lead.phone || lead.mobile || lead.owner_contact,
              address: personal?.local_address || lead.shop_address || lead.city,
              gender: null,
              fatherOrHusbandName: personal?.father_husband_name,
            },
          );
          // Map to UI-expected format: leadValue/aadhaarValue/pass
          crossMatchResult = {
            ...rawCrossMatch,
            fields: rawCrossMatch.fields.map(f => ({
              field: f.field,
              leadValue: f.inputValue,
              aadhaarValue: f.documentValue,
              similarity: f.similarity,
              threshold: f.threshold,
              pass: f.matchResult === "strong" || f.matchResult === "moderate",
            })),
          } as unknown as CrossMatchResult;
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
