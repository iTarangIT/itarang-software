// The "IVR" chip on a lead row (D2).
//
// Shown when an AI call to the lead's CURRENT number was answered by an IVR
// menu, a hold message or another company's voice bot (dealer_lead_phone_type
// 'switchboard'; src/lib/ai-dialer/phoneTypeStore.ts). The dialler never rings
// that number again; somebody has to find the dealer's own mobile.
//
// Renders NOTHING unless set, so it can be dropped into a row unconditionally.
// Slate, matching the IVR badge on the campaign page.

export function IvrTag({
    isIvr,
    className = "",
}: {
    isIvr: boolean | null | undefined;
    className?: string;
}) {
    if (!isIvr) return null;

    return (
        <span
            title="An IVR menu or company bot answered the AI call on this number. It is not redialled — find the dealer's own mobile."
            className={`inline-flex items-center gap-1 rounded-full border border-slate-300 bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-700 ${className}`}
        >
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-slate-500" />
            IVR
        </span>
    );
}
