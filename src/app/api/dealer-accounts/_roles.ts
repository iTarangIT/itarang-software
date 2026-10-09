/**
 * Tracker ID 5 — who reaches the "My dealers" API: the page's roles (everyone
 * who can own a dealer account plus the managers who act on any).
 */
import { MY_DEALERS_PAGE_ROLES } from "@/lib/auth/staffPageRoles";
import { ORDER_CLAIM_VIEW_ROLES } from "@/lib/accounts/orderClaims";

export const MY_DEALERS_ROLES: string[] = [...MY_DEALERS_PAGE_ROLES];

/** MY_DEALERS_ROLES plus the roles that see every claim (finance included). */
export const ORDER_CLAIM_API_ROLES: string[] = [
    ...new Set<string>([...MY_DEALERS_ROLES, ...ORDER_CLAIM_VIEW_ROLES]),
];

export function seesEveryClaim(role: string): boolean {
    return (ORDER_CLAIM_VIEW_ROLES as readonly string[]).includes(role);
}
