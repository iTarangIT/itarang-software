// Translates Decentro CIBIL responses into messages a non-technical admin can
// act on. The Decentro JSON shapes are inconsistent across endpoints (score
// vs. report) and across SKUs, so we look at three signals:
//   - responseKey  (e.g. "error_credits_score_not_found")
//   - rawMessage   (free-form text from the API)
//   - bureauError  (cIRReportDataLst[0].error from the report endpoint)
// The output carries a plain-English message + an actionable suggestion.

export type CibilEndpoint = "score" | "report";

export interface FriendlyCibilError {
  message: string;
  suggestion: string;
  /** Stable code so the frontend can branch on specific cases if needed. */
  code:
    | "score_not_found"
    | "consumer_not_found"
    | "invalid_pan"
    | "invalid_mobile"
    | "tier_unauthorized"
    | "network"
    | "unknown";
}

interface HumanizeInput {
  endpoint: CibilEndpoint;
  responseKey?: string | null;
  rawMessage?: string | null;
  bureauErrorDesc?: string | null;
}

export function humanizeCibilError(input: HumanizeInput): FriendlyCibilError {
  const key = (input.responseKey || "").toLowerCase();
  const msg = (input.rawMessage || "").toLowerCase();
  const bureau = (input.bureauErrorDesc || "").toLowerCase();

  // Score endpoint: lightweight mobile+name index miss
  if (key === "error_credits_score_not_found" && input.endpoint === "score") {
    return {
      message: "Mobile number isn't linked to a credit profile in the fast lookup.",
      suggestion: "Click 'Get Report' for a full PAN + DOB bureau search.",
      code: "score_not_found",
    };
  }

  // Report endpoint: bureau says no consumer
  if (
    bureau.includes("consumer not found") ||
    msg.includes("consumer not found")
  ) {
    return {
      message: "PAN is not registered with CIBIL — no credit history exists for this person.",
      suggestion: "Confirm the PAN is correct, or proceed without a credit score.",
      code: "consumer_not_found",
    };
  }

  // PAN format / validity issues
  if (
    key.includes("invalid_pan") ||
    (msg.includes("pan") && (msg.includes("invalid") || msg.includes("incorrect"))) ||
    (msg.includes("document") && msg.includes("invalid") && msg.includes("pan"))
  ) {
    return {
      message: "PAN format is invalid.",
      suggestion: "Re-check the PAN on the lead's profile (10 chars, e.g. ABCDE1234F).",
      code: "invalid_pan",
    };
  }

  // Mobile format issues
  if (
    key.includes("invalid_mobile") ||
    (msg.includes("mobile") && msg.includes("invalid")) ||
    (msg.includes("phone") && msg.includes("invalid"))
  ) {
    return {
      message: "Mobile number doesn't pass bureau format checks.",
      suggestion: "Re-check the lead's phone — must be a 10-digit Indian mobile.",
      code: "invalid_mobile",
    };
  }

  // Decentro tier doesn't include this call (module_secret missing or wrong)
  if (
    key.includes("unauthorized_module") ||
    msg.includes("pricing configuration") ||
    msg.includes("api usage disallowed")
  ) {
    return {
      message: "Decentro plan doesn't include this credit-bureau call on production.",
      suggestion: "Contact tech — DECENTRO_MODULE_SECRET_CREDIT may be missing in env.",
      code: "tier_unauthorized",
    };
  }

  // Network / transport
  if (msg.includes("network") || msg.includes("timeout") || msg.includes("econn")) {
    return {
      message: "Network error reaching the credit bureau.",
      suggestion: "Retry in a few seconds.",
      code: "network",
    };
  }

  return {
    message: input.rawMessage?.trim() || "Couldn't fetch CIBIL data.",
    suggestion:
      input.endpoint === "score"
        ? "Try 'Get Report' for a full bureau search, or contact tech if it persists."
        : "Re-check the lead's PAN, DOB, mobile, and address pincode, or contact tech.",
    code: "unknown",
  };
}
