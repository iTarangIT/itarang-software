// ID 119 (decided 16 Oct): the SQL half of the owner rule, for LIST endpoints.
//
// backOfficeOwnsLead (src/lib/auth/leadAccessRules.ts) decides one lead; this
// is the same rule as a WHERE condition so a list of customer files can be
// cut down to the leads the caller owns without loading every row first:
// the caller uploaded the lead, it is assigned to them (leads.assigned_to),
// they are its sales manager (leads.sm_assigned_to), or they own the account
// of the lead's dealer (account_ownership.owner_user_id).

import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

import { kycLeadScope } from "@/lib/auth/leadAccessRules";

/**
 * A WHERE condition on `leadIdColumn` (any column or expression holding a
 * leads.id) that keeps only the leads this user may see in a KYC list.
 * `undefined` = no filter (Admin, CEO, Sales Head), which `and()` ignores;
 * `FALSE` for a role with no KYC reach or a user with no id.
 */
export function ownedLeadsWhere(
  user: { id: string | null | undefined; role: string | null | undefined },
  leadIdColumn: SQLWrapper,
): SQL | undefined {
  const scope = kycLeadScope(user.role);
  if (scope === "all") return undefined;
  const me = (user.id ?? "").trim();
  if (scope === "none" || !me) return sql`FALSE`;
  return sql`${leadIdColumn} IN (
    SELECT ol.id FROM leads ol
      LEFT JOIN account_ownership oao ON oao.account_id = ol.dealer_id
     WHERE ol.uploader_id::text = ${me}
        OR ol.assigned_to::text = ${me}
        OR ol.sm_assigned_to::text = ${me}
        OR oao.owner_user_id::text = ${me}
  )`;
}
