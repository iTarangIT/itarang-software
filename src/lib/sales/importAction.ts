/**
 * What a Vyapar / GSTR-1 import does with one document (E-322; ID 200 #4).
 * Pure, so the rule is unit tested.
 *
 *   gstr1    a GSTR-1 file only records the filed rows
 *   update   the invoice is already in the CRM (Drive PDF or an earlier register)
 *   in_zoho  the number is an old Zoho invoice — already counted from Zoho, so
 *            the register must not add it a second time
 *   create   a new register-only invoice
 */
export type ImportAction = "update" | "create" | "gstr1" | "in_zoho";

export function importActionFor(
    kind: "vyapar_register" | "gstr1",
    existingId: string | null,
    inZoho: boolean,
): ImportAction {
    if (kind === "gstr1") return "gstr1";
    if (existingId) return "update";
    return inZoho ? "in_zoho" : "create";
}
