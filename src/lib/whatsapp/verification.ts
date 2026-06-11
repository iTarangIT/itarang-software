// Document CHECK via Decentro (design §5 step 3, §6.1). Decentro proves the
// value Gemini READ is genuine (GSTIN/PAN registered & active; bank account
// valid). Legal docs (deed/MoU/AoA/ITR) have no Decentro API → status 'skipped'.
//
// Never throws — a failed/mismatched check returns a warning the orchestrator
// appends to application.verification_warnings (never a silent pass, design §0).

import { validateDocument, verifyBankAccount } from "@/lib/decentro";

export interface CheckResult {
  provider: "decentro" | "none";
  /** verified = passed; failed = invalid/mismatch; skipped = no API; error = call failed. */
  status: "verified" | "failed" | "skipped" | "error";
  warnings: string[];
  raw: unknown;
}

const skipped = (): CheckResult => ({
  provider: "none",
  status: "skipped",
  warnings: [],
  raw: null,
});

/** Decentro responses are not uniform — treat an explicit ERROR/INVALID as a fail. */
function looksFailed(data: any): boolean {
  const s = String(
    data?.responseStatus ?? data?.status ?? data?.kycStatus ?? "",
  ).toUpperCase();
  return s.includes("ERROR") || s.includes("INVALID") || s.includes("FAIL");
}

function normName(s: unknown): string {
  return String(s ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export async function checkDocument(
  docType: string,
  fields: Record<string, unknown>,
): Promise<CheckResult> {
  try {
    switch (docType) {
      case "gst": {
        const gstin = String(fields.gstin ?? "").trim();
        if (!gstin) return { ...skipped(), status: "skipped" };
        const raw = await validateDocument({
          document_type: "GSTIN",
          id_number: gstin,
        });
        const failed = looksFailed(raw);
        return {
          provider: "decentro",
          status: failed ? "failed" : "verified",
          warnings: failed ? [`GSTIN ${gstin} could not be verified.`] : [],
          raw,
        };
      }

      case "company_pan": {
        const pan = String(fields.pan ?? "").trim();
        if (!pan) return { ...skipped(), status: "skipped" };
        const raw = await validateDocument({
          document_type: "PAN",
          id_number: pan,
        });
        const failed = looksFailed(raw);
        return {
          provider: "decentro",
          status: failed ? "failed" : "verified",
          warnings: failed ? [`PAN ${pan} could not be verified.`] : [],
          raw,
        };
      }

      case "bank_statement":
      case "cancelled_cheque": {
        const account_number = String(fields.account_number ?? "").trim();
        const ifsc = String(fields.ifsc ?? "").trim();
        const name = String(fields.account_holder_name ?? "").trim();
        if (!account_number || !ifsc) return { ...skipped(), status: "skipped" };
        const raw: any = await verifyBankAccount({
          account_number,
          ifsc,
          name: name || undefined,
          perform_name_match: Boolean(name),
        });
        const warnings: string[] = [];
        if (looksFailed(raw)) {
          warnings.push(`Bank account ${account_number} could not be verified.`);
        }
        // Best-effort name-match warning when Decentro echoes a registered name.
        const registered =
          raw?.data?.nameAtBank ??
          raw?.data?.beneficiaryName ??
          raw?.beneficiaryName;
        if (name && registered && normName(name) !== normName(registered)) {
          warnings.push(
            `Bank account name "${registered}" does not match "${name}".`,
          );
        }
        return {
          provider: "decentro",
          status: warnings.length ? "failed" : "verified",
          warnings,
          raw,
        };
      }

      // Udyam, photo, legal docs, ITR — no Decentro check in Phase 1.
      default:
        return skipped();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "verification_error";
    console.error(`[WhatsApp/verification] ${docType} check failed:`, msg);
    return {
      provider: "decentro",
      status: "error",
      warnings: [`Could not run verification for ${docType}.`],
      raw: { error: msg },
    };
  }
}
