/**
 * nbfc-doc-fixtures — resolves placeholder PDF paths for the 11 NBFC compliance
 * document types (E-005). The skill nbfc-onboarding ships pre-generated minimal
 * PDFs at ~/.claude/skills/nbfc-onboarding/fixtures/docs/<type>.pdf. If those
 * are missing (e.g. the skill isn't installed), we fall back to writing the
 * same minimal-PDF bytes into the OS tmpdir so the spec still runs.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const NBFC_DOC_TYPES = [
  "rbi_cor",
  "certificate_of_incorporation",
  "pan_card_company",
  "gst_registration",
  "audited_financials",
  "board_resolution",
  "fair_practices_code",
  "kyc_policy",
  "lsp_agreement_executed",
  "nach_mandate_template",
  "recovery_immobilisation_sop",
] as const;

export type NbfcDocType = (typeof NBFC_DOC_TYPES)[number];

export const NBFC_DOC_REQUIRED: ReadonlySet<NbfcDocType> = new Set([
  "rbi_cor",
  "certificate_of_incorporation",
  "pan_card_company",
  "gst_registration",
  "audited_financials",
  "board_resolution",
  "fair_practices_code",
  "kyc_policy",
  "lsp_agreement_executed",
]);

const SKILL_DOCS_DIR = path.join(
  os.homedir(),
  ".claude",
  "skills",
  "nbfc-onboarding",
  "fixtures",
  "docs",
);

const FALLBACK_DIR = path.join(os.tmpdir(), "itarang-nbfc-doc-fixtures");

const MINIMAL_PDF =
  "%PDF-1.4\n" +
  "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
  "2 0 obj<</Type/Pages/Count 0>>endobj\n" +
  "xref\n0 3\n0000000000 65535 f\n0000000009 00000 n\n0000000052 00000 n\n" +
  "trailer<</Size 3/Root 1 0 R>>\n" +
  "startxref\n89\n%%EOF\n";

function ensureFallback(docType: NbfcDocType): string {
  fs.mkdirSync(FALLBACK_DIR, { recursive: true });
  const dest = path.join(FALLBACK_DIR, `${docType}.pdf`);
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, MINIMAL_PDF, "utf8");
  return dest;
}

/** Absolute path to the placeholder PDF for one document type. */
export function getNbfcDocPath(docType: NbfcDocType): string {
  const skillPath = path.join(SKILL_DOCS_DIR, `${docType}.pdf`);
  if (fs.existsSync(skillPath)) return skillPath;
  return ensureFallback(docType);
}

/** Map of every doc type → absolute path. */
export function getAllNbfcDocPaths(): Record<NbfcDocType, string> {
  const out = {} as Record<NbfcDocType, string>;
  for (const t of NBFC_DOC_TYPES) out[t] = getNbfcDocPath(t);
  return out;
}
