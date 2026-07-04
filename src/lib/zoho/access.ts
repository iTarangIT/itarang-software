// Shared access gate for the CEO-only Zoho endpoints (invoices list + manual
// sync). Kept in one place so the role/email rule can't drift between routes.
//
// Allows the `ceo` role, or the hardcoded founder email as a transitional
// fallback for an auth user whose DB row may not yet carry the ceo role.

export function isCeo(user: { role?: string; email?: string }): boolean {
  const role = (user.role || "").toLowerCase();
  const email = (user.email || "").toLowerCase();
  return role === "ceo" || email === "sanchit@itarang.com";
}
