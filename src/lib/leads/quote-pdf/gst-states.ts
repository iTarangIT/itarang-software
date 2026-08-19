/**
 * GST state codes, and the place of supply a quotation prints.
 *
 * ## Why this is a table in code and not a database lookup
 *
 * The first version resolved `dealer_leads.state` against the `states` table
 * and used its `code` column. That column holds POSTAL-style alpha codes —
 * 'MH', 'HR', 'UK', and not one of its 36 rows is numeric — while a GST
 * document needs the statutory NUMERIC code.
 *
 * The consequence was not cosmetic. `computeTotals` decides IGST vs CGST+SGST
 * by comparing the place-of-supply code with the seller's, which is derived
 * from our GSTIN as '06'. `'HR' === '06'` is never true, so every supply was
 * treated as inter-state and a Haryana dealer — an intra-state sale — would
 * have been charged IGST. Found by rendering a real quotation, not by a unit
 * test: the tax maths in ./tax was always right, it was being handed the wrong
 * kind of code.
 *
 * The list is fixed by statute and moves only when a state or union territory
 * is redrawn — twice in the last decade. That belongs in versioned, testable
 * code rather than in a table that drifts per environment.
 *
 * Codes 25 (Daman and Diu) and 28 (undivided Andhra Pradesh) are deliberately
 * absent: both were retired, by the 2020 UT merger and the 2014 bifurcation.
 * Their territory is reachable through 26 and 37, which is where a GSTIN issued
 * today points.
 */
import { stateCodeFromGstin } from "./config";
import type { PlaceOfSupply } from "./view";

interface GstState {
  /** The two-digit code that appears in a GSTIN and on the document. */
  code: string;
  /** Canonical name, as printed. */
  name: string;
  /** Spellings a CRM free-text field realistically contains. */
  aliases?: string[];
}

/** The 36 jurisdictions in force, plus the "Other Territory" bucket. */
const GST_STATES: GstState[] = [
  { code: "01", name: "Jammu and Kashmir", aliases: ["J&K"] },
  { code: "02", name: "Himachal Pradesh" },
  { code: "03", name: "Punjab" },
  { code: "04", name: "Chandigarh" },
  { code: "05", name: "Uttarakhand", aliases: ["Uttaranchal"] },
  { code: "06", name: "Haryana" },
  { code: "07", name: "Delhi", aliases: ["New Delhi", "NCT of Delhi", "Delhi NCT"] },
  { code: "08", name: "Rajasthan" },
  { code: "09", name: "Uttar Pradesh" },
  { code: "10", name: "Bihar" },
  { code: "11", name: "Sikkim" },
  { code: "12", name: "Arunachal Pradesh" },
  { code: "13", name: "Nagaland" },
  { code: "14", name: "Manipur" },
  { code: "15", name: "Mizoram" },
  { code: "16", name: "Tripura" },
  { code: "17", name: "Meghalaya" },
  { code: "18", name: "Assam" },
  { code: "19", name: "West Bengal" },
  { code: "20", name: "Jharkhand" },
  { code: "21", name: "Odisha", aliases: ["Orissa"] },
  { code: "22", name: "Chhattisgarh", aliases: ["Chattisgarh"] },
  { code: "23", name: "Madhya Pradesh" },
  { code: "24", name: "Gujarat" },
  {
    code: "26",
    name: "Dadra and Nagar Haveli and Daman and Diu",
    // The two pre-2020 union territories, both now inside code 26.
    aliases: ["Dadra and Nagar Haveli", "Daman and Diu"],
  },
  { code: "27", name: "Maharashtra" },
  { code: "29", name: "Karnataka" },
  { code: "30", name: "Goa" },
  { code: "31", name: "Lakshadweep" },
  { code: "32", name: "Kerala" },
  { code: "33", name: "Tamil Nadu" },
  { code: "34", name: "Puducherry", aliases: ["Pondicherry"] },
  { code: "35", name: "Andaman and Nicobar Islands", aliases: ["Andaman & Nicobar"] },
  { code: "36", name: "Telangana" },
  { code: "37", name: "Andhra Pradesh" },
  { code: "38", name: "Ladakh" },
  { code: "97", name: "Other Territory" },
];

/**
 * Fold the spellings a free-text CRM field actually produces onto one key:
 * case, "&" for "and", stray punctuation, doubled spaces.
 */
function normalise(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[.'‘’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const CODE_BY_NAME = new Map<string, string>();
const NAME_BY_CODE = new Map<string, string>();
for (const s of GST_STATES) {
  NAME_BY_CODE.set(s.code, s.name);
  CODE_BY_NAME.set(normalise(s.name), s.code);
  for (const a of s.aliases ?? []) CODE_BY_NAME.set(normalise(a), s.code);
}

/** The GST code for a state NAME, or null when it is not one we recognise. */
export function gstStateCode(stateName: string | null | undefined): string | null {
  if (!stateName) return null;
  return CODE_BY_NAME.get(normalise(stateName)) ?? null;
}

/** The canonical name for a GST code, or null for a code outside the table. */
export function gstStateName(code: string | null | undefined): string | null {
  if (!code) return null;
  return NAME_BY_CODE.get(code.trim()) ?? null;
}

/**
 * The place of supply for one quotation: the code that decides the tax split,
 * and the label the document prints.
 *
 * THE DEALER'S GSTIN WINS over the lead's state. For a B2B supply the place of
 * supply is the recipient's registration, and its first two digits say so
 * authoritatively; `dealer_leads.state` is a free-text field nobody validates.
 * When they disagree the GSTIN is the one that would survive an assessment.
 *
 * An unrecognised state still prints its name — that is useful to a reader —
 * but yields no code, and `computeTotals` then treats the supply as
 * inter-state. See the reasoning there: guessing intra-state would silently
 * split a rate into two registers naming the wrong state.
 */
export function resolvePlaceOfSupply(
  stateName: string | null | undefined,
  gstin?: string | null,
): PlaceOfSupply {
  const name = (stateName ?? "").trim();
  const code = stateCodeFromGstin(gstin) ?? gstStateCode(name);

  if (!code) return { stateCode: null, label: name || null };

  // Prefer the canonical name so the label and the code cannot disagree; fall
  // back to whatever the lead said for a code outside the table (a GSTIN from
  // a jurisdiction added after this list was written).
  const label = gstStateName(code) ?? (name || null);
  return { stateCode: code, label: label ? `${label} (${code})` : code };
}
