    # Lead Creation — Problems Solved

    Fixes made today for bugs occurring during the dealer lead-creation flow.

    ---

    ## 1. Customer consent asked for a 12-digit Aadhaar before sending the e-sign link

    **1. Details about the problem?**
    On the Customer Consent step, clicking "Send" was blocked with a validation error demanding a 12-digit Aadhaar be captured first. The dealer wanted to send the consent link without entering Aadhaar.

    **2. How you are going to approach this problem?**
    Trace where "Send consent" is handled, find the validation that fails when Aadhaar is missing, and confirm removing it does not break the downstream Aadhaar-match check.

    **3. How did you find the solution?**
    Found a fail-closed pre-send gate in `src/lib/kyc/consent-service.ts` that returned a 400 ("Capture the customer's 12-digit Aadhaar…") whenever Aadhaar was absent. Verified the later `checkAadhaarMatch` step already returns `{comparable:false, match:true}` when no expected Aadhaar exists, so callers don't block.

    **4. How does you fix this problem?**
    Removed the pre-send Aadhaar gate in `consent-service.ts`, leaving a note. The consent link now sends without Aadhaar; the downstream match check safely no-ops when Aadhaar is missing.

    ---

    ## 2. Step 4 (Product Selection) did not show the battery picked in Step 1

    **1. Details about the problem?**
    The battery a dealer selected in Step 1 did not appear in Step 4 — the battery section was empty — even though Step 1 still showed the selection.

    **2. How you are going to approach this problem?**
    Check whether Step 1 persists the pick and Step 4 reads it back, then inspect how Step 4 narrows the inventory list to the chosen product.

    **3. How did you find the solution?**
    Step 4 scoped the battery list by matching `products.sku` against `inventory.model_type` — two different columns from different tables. When they diverge, the scope filters everything out and the section goes empty. The batteries API also didn't return `inventory.product_id`, so there was no stable key to scope by. (Chargers had the identical bug.) Note: for the reported lead the real trigger was the dealer having no stock yet, but the scoping bug was real and would recur.

    **4. How does you fix this problem?**
    Added `product_id` to the batteries and chargers APIs, and changed Step 4 to scope by the stable `inventory.product_id → products.id` identity (with SKU as a fallback). Files: `inventory/dealer/[dealerId]/batteries/route.ts`, `chargers/route.ts`, and the `product-selection` page.

    ---

    ## 3. Empty Step 4 gave no explanation

    **1. Details about the problem?**
    When Step 4 showed no batteries/chargers, the dealer saw a blank section with no reason, making it look broken.

    **2. How you are going to approach this problem?**
    Distinguish the two empty cases — "no stock at all" vs "stock exists but none matches the selected product type" — and show a clear message for each.

    **3. How did you find the solution?**
    The page rendered nothing when the scoped list was empty, regardless of cause. Two states needed distinct copy.

    **4. How does you fix this problem?**
    Added explicit empty-state messages in the `product-selection` page: "No batteries match the selected product type" when scoped-out, and a clearer message when the dealer has no stock at all.

    ---

    ## 4. "Next: Product Selection" button dead-ended with a KYC gate error

    **1. Details about the problem?**
    Clicking "Next: Product Selection" failed with "Lead kyc_status=not_started does not permit Step 4 entry", even though the lead had been approved by admin.

    **2. How you are going to approach this problem?**
    Compare what unlocks the Next button on the Step 3 page vs what the Step 4 access gate requires, and align them so the dealer is never shown a Next button the gate rejects.

    **3. How did you find the solution?**
    The Step 3 client unlocks Next when `final_decision === 'approved'`, but the `step-4-access` gate only checked `kyc_status`. On this lead the admin approval hadn't propagated to `kyc_status`, so the gate rejected it.

    **4. How does you fix this problem?**
    Made `step-4-access` also allow entry when `final_decision === 'approved'`, matching the Step 3 unlock signal.

    ---

    ## 5. Step 4 returned 500 "Cannot convert undefined or null to object"

    **1. Details about the problem?**
    After fix #4, loading Step 4 threw a 500 and showed "Cannot convert undefined or null to object"; the `step-4-access` API failed.

    **2. How you are going to approach this problem?**
    The 500 appeared right after the previous change, so review that diff first and confirm every referenced DB column actually exists.

    **3. How did you find the solution?**
    Fix #4 selected `leads.final_decision`, but `final_decision` is a column on `kyc_verification_metadata`, not `leads`. The bad reference resolved to `undefined` and broke the Drizzle query. (TypeScript build errors are ignored in this project, so it only failed at runtime.)

    **4. How does you fix this problem?**
    Removed the bad `leads.final_decision` reference and read `final_decision` from `kyc_verification_metadata` (keyed by `lead_id`) — the same source the Step 3 client uses.
