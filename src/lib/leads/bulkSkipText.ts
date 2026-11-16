// ID 233: one line naming why each skipped lead in a bulk action was left
// alone — shown as a yellow warning, never folded into the success message.
// Pure; used by the admin BulkActionBar.

export type BulkResult = {
    affected: number;
    skipped?: number;
    skip_reasons?: Record<string, number>;
    skipped_won?: number;
    skipped_visit_booked?: number;
    skipped_won_to_asm?: number;
};

/** "3 marked lost" style headline. */
export function bulkDoneText(r: BulkResult, verb: string): string {
    return `${r.affected} ${verb}.`;
}

/** null when nothing was skipped; else "2 skipped — Already Lost: 1 · Won (…): 1". */
export function bulkSkipWarning(r: BulkResult): string | null {
    const skipped = r.skipped ?? 0;
    if (skipped <= 0) return null;
    const parts: string[] = Object.entries(r.skip_reasons ?? {})
        .filter(([, n]) => n > 0)
        .map(([why, n]) => `${why}: ${n}`);
    // Actions that do not fill skip_reasons yet still name their known reasons.
    if (parts.length === 0) {
        if (r.skipped_won) parts.push(`Won (close it from the onboarding drop-out review): ${r.skipped_won}`);
        if (r.skipped_visit_booked)
            parts.push(`Kept with the ASM, a visit is booked (cancel or complete it first): ${r.skipped_visit_booked}`);
        if (r.skipped_won_to_asm) parts.push(`Won, cannot be given to an ASM: ${r.skipped_won_to_asm}`);
    }
    const named = parts.reduce((n, p) => n + Number(p.slice(p.lastIndexOf(":") + 1)), 0);
    if (named < skipped) parts.push(`Other: ${skipped - named}`);
    return `${skipped} skipped — ${parts.join(" · ")}`;
}
