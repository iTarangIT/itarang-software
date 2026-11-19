// E-392 — Battery Pool diagram 1, part 3. GET /api/kyc/[leadId]/doc-requirements
//
// Which customer KYC documents this lead is asked for (Aadhaar front/back +
// PAN always; the rest per Settings › Customer KYC documents), which may be
// skipped, and the open skips with their reasons.

import { NextResponse } from "next/server";

import { requireLeadAccess } from "@/lib/auth/requireLeadAccess";
import { askedDocs, getCustomerDocConfig, listSkips, MANDATORY_CUSTOMER_DOCS } from "@/lib/kyc/customer-doc-config";

export async function GET(_req: Request, { params }: { params: Promise<{ leadId: string }> }) {
  const { leadId } = await params;
  const gate = await requireLeadAccess(leadId);
  if (!gate.ok) return gate.response;
  const [config, skipped] = await Promise.all([getCustomerDocConfig(), listSkips(leadId)]);
  return NextResponse.json({
    success: true,
    data: { asked: askedDocs(config), mandatory: MANDATORY_CUSTOMER_DOCS, skipped },
  });
}
