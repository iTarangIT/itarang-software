/**
 * Merge-field rendering for campaign messages and invite notes (doc §6.1).
 * v1 fields: first_name, company, headline, city — written {{first_name}}.
 * A field the prospect does not have, or a field name we do not know, is
 * reported in `missing`; such a prospect is flagged in preview and not sent.
 * Pure.
 */

export const MERGE_FIELDS = ["first_name", "company", "headline", "city"] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];
export type MergeValues = Partial<Record<MergeField, string | null | undefined>>;

/** LinkedIn's limit on a connection-request note. */
export const INVITE_NOTE_MAX = 300;
/** Practical cap on a first message body. */
export const MESSAGE_MAX = 8000;

const FIELD_RE = /\{\{\s*([a-zA-Z_]+)\s*\}\}/g;

export type Rendered = { text: string; missing: string[] };

export function renderTemplate(template: string, values: MergeValues): Rendered {
  const missing = new Set<string>();
  const text = template.replace(FIELD_RE, (_m, raw: string) => {
    const name = raw.toLowerCase();
    if (!(MERGE_FIELDS as readonly string[]).includes(name)) {
      missing.add(name);
      return "";
    }
    const v = values[name as MergeField]?.trim();
    if (!v) {
      missing.add(name);
      return "";
    }
    return v;
  });
  return { text: text.trim(), missing: [...missing] };
}

/** Merge fields a template uses (for the composer's "uses" chips). */
export function fieldsUsed(template: string): string[] {
  return [...new Set([...template.matchAll(FIELD_RE)].map((m) => m[1].toLowerCase()))];
}

/** First name from a full name, for prospects the provider gave only "Full Name". */
export function firstNameOf(fullName: string | null | undefined): string | null {
  const first = (fullName ?? "").trim().split(/\s+/)[0];
  if (!first) return null;
  // Drop honorifics so "Dr. Asha Rao" greets "Asha".
  if (/^(mr|mrs|ms|dr|er|prof)\.?$/i.test(first)) {
    return (fullName ?? "").trim().split(/\s+/)[1] ?? null;
  }
  return first;
}
