import { Suspense } from "react";

import { requireRole } from "@/lib/auth-utils";
import { GdriveMirrorPanel } from "../_components/GdriveMirrorPanel";

export const dynamic = "force-dynamic";

// E-255 — Google Drive backup of every stored document. Own route beside
// KYC Automation / NBFC Request SLA, same gate.
export default async function GdriveMirrorSettingsPage() {
    await requireRole(["admin", "sales_head"]);

    return (
        <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1100px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">
                    Google Drive Backup
                </h1>
                <p className="mt-1 text-sm text-ink-muted">
                    The CRM&apos;s customer and partner documents in S3 — KYC uploads, lead
                    documents, WhatsApp uploads, dealer onboarding documents, dealer
                    agreements and NBFC agreements / compliance documents — are also copied
                    into Google Drive, filed under category folders. Other files (expenses,
                    quotations, buyback / auction photos, FI / video-KYC media, call
                    recordings) are deliberately not backed up — see the table below. New
                    uploads are mirrored within seconds; the backfill sweep copies everything
                    that was uploaded before this was switched on.
                </p>
            </header>

            {/* useSearchParams (OAuth return flag) needs a Suspense boundary. */}
            <Suspense fallback={null}>
                <GdriveMirrorPanel />
            </Suspense>
        </div>
    );
}
