import { requireRole } from "@/lib/auth-utils";
import { ASSISTANT_ROLES } from "@/lib/assistant/types";
import { LinkWhatsApp } from "./_components/LinkWhatsApp";

export const dynamic = "force-dynamic";

// Settings → Link WhatsApp (BRD §8.5). An ASM or ISR links their phone to the
// iTarang Sales Assistant: this page issues a one-time code, they send
// "LINK <code>" from that phone. The API re-checks role and active status.
export default async function LinkWhatsAppPage() {
    const user = await requireRole([...ASSISTANT_ROLES]);

    return (
        <div className="px-6 md:px-8 py-6 space-y-5 max-w-2xl">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Link WhatsApp</h1>
                <p className="mt-1 text-sm text-gray-600">
                    {user.name}, link your phone to the iTarang Sales Assistant to check your queue,
                    log calls and visits, and see your numbers from WhatsApp. Every change still needs
                    your tap on Confirm.
                </p>
            </header>
            <LinkWhatsApp />
        </div>
    );
}
