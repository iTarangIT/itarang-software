/**
 * Small helpers every descriptor needs (E-288).
 */

import type { DigestDetailRow } from "../types";

/**
 * Turn a `json_agg` result into detail rows.
 *
 * Every descriptor builds its lists with `json_agg` of a subquery aliased to the
 * DigestDetailRow field names, so this one coercion serves all of them. Anything
 * missing becomes null rather than the string "null", which is what would reach
 * the mail if these were interpolated raw.
 */
export function toDetailRows(raw: unknown): DigestDetailRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (v == null ? null : String(v));
    return {
      id: String(o.id ?? ""),
      title: o.title == null ? "—" : String(o.title),
      subtitle: str(o.subtitle),
      city: str(o.city),
      state: str(o.state),
      source: str(o.source),
      at: str(o.at),
    };
  });
}
