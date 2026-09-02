"use client";

// Settings → WhatsApp → Language. Three radio cards + Save.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";

type Language = "english" | "hindi" | "hinglish";

type Settings = { language: Language };

const OPTIONS: {
  value: Language;
  label: string;
  native: string;
  blurb: string;
  sample: string;
}[] = [
  {
    value: "english",
    label: "English",
    native: "English",
    blurb: "The copy exactly as written in the flows. No translation step.",
    sample: "Welcome to iTarang! What would you like to do today?",
  },
  {
    value: "hindi",
    label: "Hindi",
    native: "हिंदी",
    blurb: "Devanagari script. Amounts, OTPs, names and ids stay unchanged.",
    sample: "iTarang में आपका स्वागत है! आज आप क्या करना चाहेंगे?",
  },
  {
    value: "hinglish",
    label: "Hinglish",
    native: "Hindi in English letters",
    blurb: "Everyday spoken Hindi typed in Roman letters, the WhatsApp way.",
    sample: "iTarang mein aapka swagat hai! Aaj aap kya karna chahenge?",
  },
];

export function WhatsAppLanguageForm() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Language | null>(null);
  const [saving, setSaving] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["whatsapp-language-settings"],
    queryFn: async () => {
      const res = await fetch("/api/admin/settings/whatsapp-language");
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(
          json?.error?.message ?? "Failed to load WhatsApp language settings",
        );
      }
      return json.data.settings as Settings;
    },
  });

  const selected: Language | undefined = draft ?? data?.language;
  const dirty = draft !== null && draft !== data?.language;

  async function save() {
    if (!selected) return;
    setSaving(true);
    try {
      const res = await fetch("/api/admin/settings/whatsapp-language", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: selected }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error?.message ?? "Save failed");
      }
      setDraft(null);
      qc.invalidateQueries({ queryKey: ["whatsapp-language-settings"] });
      const label = OPTIONS.find((o) => o.value === selected)?.label ?? selected;
      toast.success(`Saved. WhatsApp replies will now be in ${label}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (isLoading || !data) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-ink-muted">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading WhatsApp language settings…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-ink">
          Bot reply language
        </legend>
        <div className="grid gap-3 md:grid-cols-3">
          {OPTIONS.map((opt) => {
            const active = selected === opt.value;
            return (
              <label
                key={opt.value}
                data-testid={`wa-lang-${opt.value}`}
                className={[
                  "relative flex cursor-pointer flex-col gap-2 rounded-lg border p-4 transition",
                  active
                    ? "border-brand-teal bg-brand-teal/5 ring-1 ring-brand-teal"
                    : "border-border bg-surface-subtle hover:border-ink-muted/40",
                ].join(" ")}
              >
                <input
                  type="radio"
                  name="whatsapp-language"
                  value={opt.value}
                  checked={active}
                  onChange={() => setDraft(opt.value)}
                  className="sr-only"
                />
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold text-ink">
                      {opt.label}
                    </div>
                    <div className="text-xs text-ink-muted">{opt.native}</div>
                  </div>
                  {active && (
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-teal text-white">
                      <Check className="h-3 w-3" />
                    </span>
                  )}
                </div>
                <p className="text-xs text-ink-muted">{opt.blurb}</p>
                <p className="rounded-md bg-surface px-2 py-1.5 text-xs text-ink border border-border">
                  {opt.sample}
                </p>
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="rounded-lg border border-border bg-surface-subtle p-4 text-xs text-ink-muted space-y-1">
        <p>
          Hindi and Hinglish copy is generated from the English flow text by
          Gemini the first time a message is sent, then cached — so the first
          send of a new message can take a second longer.
        </p>
        <p>
          Numbers, ₹ amounts, OTPs, names, serials and links are kept exactly
          as-is. Buttons keep WhatsApp&apos;s 20-character limit.
        </p>
        <p>
          Meta template nudges (sent when a chat has been idle for 24h) stay in
          English until Hindi templates are approved by Meta.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={!dirty || saving}>
          {saving ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Saving…
            </>
          ) : (
            "Save"
          )}
        </Button>
        {dirty && (
          <button
            type="button"
            className="text-sm text-ink-muted hover:text-ink"
            onClick={() => setDraft(null)}
          >
            Discard
          </button>
        )}
        {!dirty && (
          <span className="text-xs text-ink-muted">
            Current:{" "}
            <strong className="text-ink">
              {OPTIONS.find((o) => o.value === data.language)?.label}
            </strong>
          </span>
        )}
      </div>
    </div>
  );
}
