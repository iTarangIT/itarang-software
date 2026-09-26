// Resolve "Rahul" / "rahul sharma" / a user id to ONE colleague for a hand-off
// (transfer_to_asm, reassign_lead). Pure: the candidates come from the caller's
// query. Never guesses — no match or several matches go back to the user as a
// question listing names.

export type Person = { id: string; name: string | null };

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Best matches for `query`, strongest rule first:
 *   1. the exact user id
 *   2. the full name (case / spacing insensitive)
 *   3. every word of the query starts a word of the name ("rah sha" → Rahul Sharma)
 * Returns the matches of the first rule that matches anything.
 */
export function matchPeople<P extends Person>(people: readonly P[], query: string): P[] {
    const q = norm(query);
    if (!q) return [];
    const byId = people.filter((p) => p.id === query.trim());
    if (byId.length) return byId;
    const byName = people.filter((p) => p.name && norm(p.name) === q);
    if (byName.length) return byName;
    const words = q.split(" ");
    return people.filter((p) => {
        if (!p.name) return false;
        const nameWords = norm(p.name).split(" ");
        return words.every((w) => nameWords.some((n) => n.startsWith(w)));
    });
}

/** "Rahul Sharma, Rahul Verma and 3 more" — at most `max` names. */
export function nameList(people: readonly Person[], max = 10): string {
    const names = people.slice(0, max).map((p) => p.name?.trim() || p.id);
    const more = people.length - names.length;
    return more > 0 ? `${names.join(", ")} and ${more} more` : names.join(", ");
}
