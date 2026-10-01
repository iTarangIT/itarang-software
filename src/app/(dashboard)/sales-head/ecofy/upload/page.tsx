import { requireRole } from "@/lib/auth-utils";
import { ECOFY_MANAGER_ROLES } from "@/lib/ecofy/access";
import { EcofyLeadUploader } from "@/components/ecofy/EcofyLeadUploader";

export const dynamic = "force-dynamic";

// Tracker ID 51 gap 11 — the Ecofy lead uploader (M03 Intake). Sales Head and
// CEO only: creating leads and imports are iTarang Admin actions in Ecofy.
export default async function EcofyUploadPage() {
    await requireRole([...ECOFY_MANAGER_ROLES]);
    return (
        <div className="mx-auto max-w-[1600px] space-y-5 px-4 py-6 sm:px-6 md:px-8">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Ecofy — Upload Leads</h1>
                <p className="mt-1 text-sm text-gray-600">
                    Create one lead or import a file into Ecofy. Leads created by iTarang start at S1 (Pickup Queue), owned by
                    iTarang. Consent is mandatory for every lead; duplicates are matched by mobile number in Ecofy.
                </p>
            </header>
            <EcofyLeadUploader leadHrefBase="/sales-head/ecofy/leads" />
        </div>
    );
}
