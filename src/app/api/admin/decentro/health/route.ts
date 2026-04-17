import { NextResponse } from "next/server";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";

// Read-only diagnostic: shows which Decentro env vars this server instance sees.
// Does not hit Decentro APIs — safe to call from prod without spending credits.
// Response masks secrets so the output can be shared in a support ticket.
export async function GET() {
  const appUser = await requireAdminAppUser();
  if (!appUser) {
    return NextResponse.json(
      { success: false, error: { message: "Unauthorized" } },
      { status: 403 },
    );
  }

  const mask = (val: string | undefined): string | null => {
    if (!val) return null;
    if (val.length < 8) return "***";
    return `${val.slice(0, 3)}***${val.slice(-3)} (len=${val.length})`;
  };

  const isPlaceholder = (val: string | undefined): boolean => {
    if (!val) return true;
    return val.startsWith("your_") || val.length < 6;
  };

  const baseUrl =
    process.env.DECENTRO_BASE_URL ||
    (process.env.NODE_ENV === "production"
      ? "https://in.decentro.tech"
      : "https://in.staging.decentro.tech");

  const environment = baseUrl.includes("staging") ? "staging" : "production";

  const modules = {
    kyc: {
      configured: !isPlaceholder(process.env.DECENTRO_MODULE_SECRET_KYC),
      preview: mask(process.env.DECENTRO_MODULE_SECRET_KYC),
      usedFor: [
        "PAN validate",
        "Aadhaar OTP",
        "DigiLocker eAadhaar",
        "Face match",
        "Document OCR",
        "Document classification",
        "RC verify",
      ],
    },
    banking: {
      configured: !isPlaceholder(process.env.DECENTRO_MODULE_SECRET_BANKING),
      preview: mask(process.env.DECENTRO_MODULE_SECRET_BANKING),
      usedFor: ["Bank account verification (penny drop / penniless)"],
    },
    credit: {
      configured: !isPlaceholder(process.env.DECENTRO_MODULE_SECRET_CREDIT),
      preview: mask(process.env.DECENTRO_MODULE_SECRET_CREDIT),
      usedFor: [
        "CIBIL score (Bytes)",
        "CIBIL full report",
        "(module secret optional — most accounts don't require it)",
      ],
    },
  };

  const consumerUrn = {
    configured: !!process.env.DECENTRO_CONSUMER_URN,
    preview: mask(process.env.DECENTRO_CONSUMER_URN),
    usedFor: ["Bank account verification (required)"],
  };

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || null;
  const callbackSample = appUrl
    ? `${appUrl}/api/kyc/digilocker/callback/DIGI-XXXXXXXX`
    : null;

  return NextResponse.json({
    success: true,
    data: {
      environment,
      baseUrl,
      nodeEnv: process.env.NODE_ENV,
      clientId: {
        configured: !isPlaceholder(process.env.DECENTRO_CLIENT_ID),
        preview: mask(process.env.DECENTRO_CLIENT_ID),
      },
      clientSecret: {
        configured: !isPlaceholder(process.env.DECENTRO_CLIENT_SECRET),
        preview: mask(process.env.DECENTRO_CLIENT_SECRET),
      },
      modules,
      consumerUrn,
      digilocker: {
        appUrl,
        callbackSample,
        warning: !appUrl
          ? "NEXT_PUBLIC_APP_URL is not set — DigiLocker callback URL will be wrong"
          : null,
      },
    },
  });
}
