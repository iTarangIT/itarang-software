import { requireRole } from "@/lib/auth-utils";
import { WhatsAppLanguageForm } from "../../_components/WhatsAppLanguageForm";

export const dynamic = "force-dynamic";

// Settings → WhatsApp → Language. One global switch for the language every
// bot message goes out in. Same gate as the other settings pages: middleware
// admits `ceo` to /admin but this does not.
export default async function WhatsAppLanguageSettingsPage() {
  await requireRole(["admin", "sales_head"]);

  return (
    <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1100px]">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          WhatsApp Language
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          The language the WhatsApp bot replies in — dealer onboarding, the
          dealer console, customer leads, offers and dispatch. Applies to every
          conversation from the next message onward.
        </p>
      </header>

      <div className="rounded-xl border border-border bg-surface shadow-card">
        <div className="p-5">
          <WhatsAppLanguageForm />
        </div>
      </div>
    </div>
  );
}
