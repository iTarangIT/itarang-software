import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  digilockerTransactions,
  kycDocuments,
  kycVerifications,
  leads,
  personalDetails,
} from "@/lib/db/schema";
import { validateDocument } from "@/lib/decentro";

function nameSimilarity(a: string, b: string): number {
  const normalize = (s: string) =>
    s.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter(Boolean);
  const wordsA = new Set(normalize(a));
  const wordsB = new Set(normalize(b));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return Math.round((intersection / union) * 100);
}

function computeMatch(
  a: string,
  b: string,
  type: "similarity" | "exact" | "phone" = "similarity",
): { score: number | null; pass: boolean } {
  if (!a || !b) return { score: null, pass: true };
  if (type === "exact") {
    const match = a.trim().toLowerCase() === b.trim().toLowerCase();
    return { score: match ? 100 : 0, pass: match };
  }
  if (type === "phone") {
    const match =
      a.replace(/\D/g, "").slice(-10) === b.replace(/\D/g, "").slice(-10);
    return { score: match ? 100 : 0, pass: match };
  }
  const sim = nameSimilarity(a, b);
  return { score: sim, pass: sim >= 80 };
}

export type PanVerificationInput = {
  panNumber: string;
  documentType?: string;
  dob?: string;
};

export type PanVerificationResult = {
  success: boolean;
  message: string;
  data: {
    verificationId: string;
    pan_name: string;
    lead_name: string;
    pan_status: string | null;
    pan_category: string | null;
    pan_type: string | null;
    email: string | null;
    aadhaar_seeding: string | null;
    masked_aadhaar: string | null;
    father_name: string | null;
    name_match_score: number | null;
    crossMatchFields: Array<{
      field: string;
      leadValue: string | null;
      panValue: string | null;
      aadhaarValue: string | null;
      matchScore: number | null;
      pass: boolean;
    }>;
  };
  decentroTxnId?: string;
};

export type PanVerificationError = {
  success: false;
  status: number;
  error: string;
};

export async function executePanVerification(
  leadId: string,
  input: PanVerificationInput,
): Promise<PanVerificationResult | PanVerificationError> {
  const { panNumber, documentType = "PAN_DETAILED_COMPLETE" } = input;

  if (!panNumber) {
    return { success: false, status: 400, error: "PAN number is required" };
  }

  const [leadRows, pdRows] = await Promise.all([
    db
      .select({
        full_name: leads.full_name,
        owner_name: leads.owner_name,
        phone: leads.phone,
        mobile: leads.mobile,
        dob: leads.dob,
        current_address: leads.current_address,
        local_address: leads.local_address,
      })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1),
    db
      .select({
        pan_no: personalDetails.pan_no,
        aadhaar_no: personalDetails.aadhaar_no,
        dob: personalDetails.dob,
        local_address: personalDetails.local_address,
        father_husband_name: personalDetails.father_husband_name,
      })
      .from(personalDetails)
      .where(eq(personalDetails.lead_id, leadId))
      .limit(1),
  ]);

  const lead = leadRows[0];
  const pd = pdRows[0];

  if (!lead) {
    return { success: false, status: 404, error: "Lead not found" };
  }

  const decentroRes = await validateDocument({
    document_type: documentType,
    id_number: panNumber.toUpperCase().trim(),
  });

  console.log(
    "[Decentro PAN] document_type:",
    documentType,
    "| response:",
    JSON.stringify(decentroRes).slice(0, 500),
  );

  const decentroMessage =
    typeof decentroRes.message === "string"
      ? decentroRes.message
      : decentroRes.message?.message || decentroRes.error?.message || "";

  const apiSuccess =
    (decentroRes.responseStatus || decentroRes.status || "").toUpperCase() ===
      "SUCCESS" ||
    decentroMessage.toLowerCase().includes("retrieved successfully") ||
    decentroMessage.toLowerCase().includes("fetched successfully");

  const kycResult =
    decentroRes.kycResult || decentroRes.data?.kycResult || decentroRes.data || {};

  const panName =
    kycResult.fullName ||
    [kycResult.firstName, kycResult.middleName, kycResult.lastName]
      .filter(Boolean)
      .join(" ") ||
    kycResult.name ||
    "";

  const panStatus = (
    kycResult.idStatus ||
    kycResult.panStatus ||
    kycResult.status ||
    ""
  ).toUpperCase();
  const isPanValid = panStatus === "VALID" || panStatus === "ACTIVE";

  const reasons: string[] = [];
  let overallSuccess = apiSuccess;

  if (!apiSuccess) {
    reasons.push(
      `API error: ${decentroMessage || decentroRes.responseMessage || JSON.stringify(decentroRes).slice(0, 200)}`,
    );
    overallSuccess = false;
  } else if (!isPanValid) {
    reasons.push(`PAN status: ${kycResult.idStatus || "UNKNOWN"} (not valid)`);
    overallSuccess = false;
  }

  let matchScore: number | null = null;
  const leadName = lead.full_name || "";
  if (panName && leadName) {
    matchScore = nameSimilarity(panName, leadName);
    if (matchScore < 50) {
      reasons.push(
        `Name mismatch: PAN name "${panName}" does not match lead name "${leadName}" (${matchScore}% match)`,
      );
      overallSuccess = false;
    } else if (matchScore < 80) {
      reasons.push(
        `Partial name match: PAN "${panName}" vs lead "${leadName}" (${matchScore}% match)`,
      );
    }
  } else if (!leadName) {
    reasons.push("Lead name not available for comparison");
  }

  const failedReason = reasons.length > 0 ? reasons.join("; ") : null;
  const verificationStatus = overallSuccess ? "success" : "failed";
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
  const seq = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, "0");

  // Fetch Aadhaar data from DigiLocker transactions (if available)
  const digiRows = await db
    .select({
      aadhaar_extracted_data: digilockerTransactions.aadhaar_extracted_data,
    })
    .from(digilockerTransactions)
    .where(
      and(
        eq(digilockerTransactions.lead_id, leadId),
        eq(digilockerTransactions.status, "document_fetched"),
      ),
    )
    .orderBy(desc(digilockerTransactions.created_at))
    .limit(1);

  let aadhaarData = digiRows[0]?.aadhaar_extracted_data as
    | Record<string, string | null>
    | null;
  console.log(
    `[PAN Verify] DigiLocker rows found: ${digiRows.length}, aadhaarData:`,
    aadhaarData ? Object.keys(aadhaarData) : "null",
  );

  if (!aadhaarData && digiRows.length > 0) {
    const raw = digiRows[0].aadhaar_extracted_data as Record<string, unknown> | null;
    console.log(`[PAN Verify] DigiLocker raw data:`, JSON.stringify(raw).slice(0, 300));
  }

  if (!aadhaarData) {
    const allDigiRows = await db
      .select({
        status: digilockerTransactions.status,
        aadhaar_extracted_data: digilockerTransactions.aadhaar_extracted_data,
        cross_match_result: digilockerTransactions.cross_match_result,
      })
      .from(digilockerTransactions)
      .where(eq(digilockerTransactions.lead_id, leadId))
      .orderBy(desc(digilockerTransactions.created_at))
      .limit(5);

    console.log(
      `[PAN Verify] All DigiLocker txns: ${allDigiRows.length}`,
      allDigiRows.map((r) => ({ status: r.status, hasData: !!r.aadhaar_extracted_data })),
    );

    for (const row of allDigiRows) {
      const data = row.aadhaar_extracted_data as Record<string, string | null> | null;
      if (data && (data.name || data.uid)) {
        aadhaarData = data;
        console.log(
          `[PAN Verify] Found aadhaar data from txn with status="${row.status}"`,
        );
        break;
      }
      const crossResult = row.cross_match_result as
        | {
            fields?: Array<{
              aadhaarValue?: string;
              documentValue?: string;
              field?: string;
            }>;
          }
        | null;
      if (crossResult?.fields?.length) {
        const extracted: Record<string, string | null> = {};
        for (const f of crossResult.fields) {
          const val = f.aadhaarValue || f.documentValue || null;
          if (val) {
            const key = (f.field || "").toLowerCase().replace(/\s+/g, "_");
            extracted[key] = val;
          }
        }
        if (Object.keys(extracted).length > 0) {
          aadhaarData = {
            name: extracted.name || null,
            gender: extracted.gender || null,
            dob: extracted.dob || null,
            address: extracted.address || null,
            careof: extracted.father_husband_name || extracted.careof || null,
            mobile: extracted.phone || extracted.mobile || null,
          };
          console.log(`[PAN Verify] Extracted aadhaar data from cross_match_result`);
          break;
        }
      }
    }
  }

  if (!aadhaarData) {
    const aadhaarDocs = await db
      .select({ ocrData: kycDocuments.ocr_data, docType: kycDocuments.doc_type })
      .from(kycDocuments)
      .where(eq(kycDocuments.lead_id, leadId))
      .orderBy(desc(kycDocuments.uploaded_at));

    for (const adoc of aadhaarDocs) {
      if (adoc.docType !== "aadhaar_front" && adoc.docType !== "aadhaar_back") continue;
      const ocr = adoc.ocrData as Record<string, unknown> | null;
      if (!ocr) continue;
      const kycR = (ocr.kycResult || ocr.extractedData || ocr) as Record<string, unknown>;
      const name = (kycR.name || kycR.fullName || kycR.full_name || "") as string;
      const gender = (kycR.gender || "") as string;
      const adob = (kycR.dob || kycR.dateOfBirth || kycR.date_of_birth || "") as string;
      const address = (kycR.address || kycR.full_address || kycR.currentAddress || "") as string;
      const careof = (kycR.careof ||
        kycR.careOf ||
        kycR.fatherName ||
        kycR.father_name ||
        kycR.fatherOrHusbandName ||
        "") as string;
      if (name || adob || address) {
        aadhaarData = {
          name,
          gender,
          dob: adob,
          address: typeof address === "string" ? address : JSON.stringify(address),
          careof,
        };
        break;
      }
    }
  }

  console.log(
    `[PAN Verify] Final aadhaarData:`,
    aadhaarData ? JSON.stringify(aadhaarData).slice(0, 200) : "null",
  );

  const leadDob = pd?.dob
    ? new Date(pd.dob).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : lead.dob
      ? new Date(lead.dob).toLocaleDateString("en-IN", {
          day: "2-digit",
          month: "short",
          year: "numeric",
        })
      : "";
  const leadAddress = pd?.local_address || lead.local_address || lead.current_address || "";
  const leadPhone = lead.phone || lead.mobile || "";
  const leadGender = "";

  const panGender = kycResult.gender || "";
  const panDob = kycResult.dateOfBirth || kycResult.dob || "";
  const panAddress =
    kycResult.address?.full ||
    (typeof kycResult.address === "string" ? kycResult.address : "") ||
    "";
  const panMobile = kycResult.mobile || kycResult.phone || "";

  const nameMatch = computeMatch(leadName, panName);
  const genderMatch = computeMatch(leadGender, panGender, "exact");
  const dobMatch = computeMatch(leadDob, panDob, "exact");
  const addressMatch = computeMatch(
    leadAddress,
    typeof panAddress === "string" ? panAddress : "",
  );
  const mobileMatch = computeMatch(leadPhone, panMobile, "phone");

  const aadhaarName = aadhaarData?.name || null;
  const aadhaarGender = aadhaarData?.gender || null;
  const aadhaarDob = aadhaarData?.dob || null;
  const aadhaarAddress = aadhaarData?.address || null;
  const aadhaarMobile = aadhaarData?.mobile || aadhaarData?.phone || null;
  const aadhaarFather = aadhaarData?.careof || aadhaarData?.fatherName || null;

  const allCrossMatchFields = [
    {
      field: "Name",
      leadValue: leadName || null,
      panValue: panName || null,
      aadhaarValue: aadhaarName,
      matchScore: nameMatch.score,
      pass: nameMatch.pass,
    },
    {
      field: "Gender",
      leadValue: leadGender || null,
      panValue: panGender || null,
      aadhaarValue: aadhaarGender,
      matchScore: genderMatch.score,
      pass: genderMatch.pass,
    },
    {
      field: "DOB",
      leadValue: leadDob || null,
      panValue: panDob || null,
      aadhaarValue: aadhaarDob,
      matchScore: dobMatch.score,
      pass: dobMatch.pass,
    },
    {
      field: "Address",
      leadValue: leadAddress || null,
      panValue:
        typeof panAddress === "string" ? panAddress : JSON.stringify(panAddress) || null,
      aadhaarValue: aadhaarAddress,
      matchScore: addressMatch.score,
      pass: addressMatch.pass,
    },
    {
      field: "Mobile",
      leadValue: leadPhone || null,
      panValue: panMobile || null,
      aadhaarValue: aadhaarMobile,
      matchScore: mobileMatch.score,
      pass: mobileMatch.pass,
    },
    {
      field: "Father/Husband Name",
      leadValue: pd?.father_husband_name || null,
      panValue: kycResult.fatherName || null,
      aadhaarValue: aadhaarFather,
      matchScore:
        pd?.father_husband_name && kycResult.fatherName
          ? computeMatch(pd.father_husband_name, kycResult.fatherName).score
          : null,
      pass:
        pd?.father_husband_name && kycResult.fatherName
          ? computeMatch(pd.father_husband_name, kycResult.fatherName).pass
          : true,
    },
  ];

  const crossMatchFields = allCrossMatchFields.filter((f) => f.leadValue || f.panValue);

  let message = decentroMessage || "";
  if (overallSuccess) {
    message = isPanValid ? `PAN verified. Name: ${panName}` : message;
    if (matchScore !== null && matchScore >= 50) {
      message += ` (${matchScore}% name match with lead)`;
    }
  } else {
    message = reasons.join(". ");
  }

  const verRecord = {
    status: verificationStatus,
    api_provider: "decentro" as const,
    api_request: { pan_number: panNumber, document_type: documentType },
    api_response: {
      ...decentroRes,
      message,
      data: {
        crossMatchFields,
        pan_name: panName,
        lead_name: leadName,
        pan_status: kycResult.idStatus || kycResult.panStatus || null,
        name_match_score: matchScore,
      },
    },
    failed_reason: failedReason,
    match_score: matchScore !== null ? matchScore.toString() : null,
    completed_at: now,
    updated_at: now,
  };

  const panUpper = panNumber.toUpperCase().trim();
  if (pd) {
    await db
      .update(personalDetails)
      .set({ pan_no: panUpper })
      .where(eq(personalDetails.lead_id, leadId));
  } else {
    await db.insert(personalDetails).values({
      lead_id: leadId,
      pan_no: panUpper,
    });
  }

  const existing = await db
    .select({ id: kycVerifications.id })
    .from(kycVerifications)
    .where(
      and(
        eq(kycVerifications.lead_id, leadId),
        eq(kycVerifications.verification_type, "pan"),
      ),
    )
    .limit(1);

  const verificationId = existing[0]?.id || `KYCVER-${dateStr}-${seq}`;

  if (existing.length > 0) {
    await db
      .update(kycVerifications)
      .set(verRecord)
      .where(
        and(
          eq(kycVerifications.lead_id, leadId),
          eq(kycVerifications.verification_type, "pan"),
        ),
      );
  } else {
    await db.insert(kycVerifications).values({
      id: verificationId,
      lead_id: leadId,
      verification_type: "pan",
      submitted_at: now,
      created_at: now,
      ...verRecord,
    });
  }

  return {
    success: overallSuccess,
    message,
    data: {
      verificationId,
      pan_name: panName,
      lead_name: leadName,
      pan_status: kycResult.idStatus || kycResult.panStatus || null,
      pan_category: kycResult.category || null,
      pan_type: kycResult.panType || null,
      email: kycResult.email || null,
      aadhaar_seeding: kycResult.aadhaarSeedingStatus || null,
      masked_aadhaar: kycResult.maskedAadhaar || null,
      father_name: kycResult.fatherName || null,
      name_match_score: matchScore,
      crossMatchFields,
    },
    decentroTxnId: decentroRes.decentroTxnId,
  };
}
