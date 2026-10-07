import { describe, expect, it } from "vitest";

import { canReadDeployedAsset, deployedAssetScope } from "../deployedAssetsAccess";

describe("deployedAssetScope (ID 118 item 5)", () => {
  it("scopes a dealer to its own dealer_id", () => {
    const scope = deployedAssetScope({ role: "dealer", dealer_id: "D1" });
    expect(scope).toEqual({ kind: "dealer", dealerId: "D1" });
    expect(canReadDeployedAsset(scope, "D1")).toBe(true);
    expect(canReadDeployedAsset(scope, "D2")).toBe(false);
    expect(canReadDeployedAsset(scope, null)).toBe(false);
  });

  it("denies a dealer login with no dealer_id", () => {
    expect(deployedAssetScope({ role: "dealer", dealer_id: null })).toEqual({ kind: "deny" });
  });

  it("denies outside parties", () => {
    for (const role of ["nbfc_partner", "scrap_vendor", "refurbisher"]) {
      const scope = deployedAssetScope({ role, dealer_id: null });
      expect(scope, role).toEqual({ kind: "deny" });
      expect(canReadDeployedAsset(scope, "D1")).toBe(false);
    }
  });

  it("lets internal roles read every asset", () => {
    for (const role of ["admin", "ceo", "service_engineer", "inventory_manager"]) {
      const scope = deployedAssetScope({ role, dealer_id: null });
      expect(scope, role).toEqual({ kind: "all" });
      expect(canReadDeployedAsset(scope, "anything")).toBe(true);
    }
  });
});
