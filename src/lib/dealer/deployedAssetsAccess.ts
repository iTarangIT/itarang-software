// Who may read deployed assets — customer name, phone and GPS (tracker ID 118,
// item 5). Pure: no db import, so it is unit-tested directly.
//
//   dealer                         only its own dealer_id's assets
//   nbfc_partner, scrap_vendor,    none — outside parties with their own portals
//   refurbisher
//   every other (internal) role    all assets, as before

const EXTERNAL_ROLES = new Set(["nbfc_partner", "scrap_vendor", "refurbisher"]);

export type DeployedAssetScope =
  | { kind: "deny" }
  | { kind: "all" }
  | { kind: "dealer"; dealerId: string };

export function deployedAssetScope(user: { role: string; dealer_id: string | null }): DeployedAssetScope {
  const role = (user.role ?? "").toLowerCase();
  if (EXTERNAL_ROLES.has(role)) return { kind: "deny" };
  if (role === "dealer") {
    // A dealer login with no dealer_id has nothing it may see.
    return user.dealer_id ? { kind: "dealer", dealerId: user.dealer_id } : { kind: "deny" };
  }
  return { kind: "all" };
}

/** May this user read this one asset? */
export function canReadDeployedAsset(scope: DeployedAssetScope, assetDealerId: string | null): boolean {
  if (scope.kind === "all") return true;
  if (scope.kind === "dealer") return assetDealerId === scope.dealerId;
  return false;
}
