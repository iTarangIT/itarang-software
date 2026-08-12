/**
 * Session-scoped render snapshots.
 *
 * Every hard navigation remounts the dashboard chrome. Components that gate
 * what they render on an on-mount `fetch` therefore render empty (or wrong)
 * on every single navigation until that request lands. A snapshot lets them
 * paint last-known-good state immediately and revalidate in the background.
 *
 * This is the pattern AuthProvider already uses for /api/user/profile; it was
 * file-local there. Extracted here so the sidebar can share it rather than
 * carry a second copy of the same try/catch-wrapped storage dance.
 *
 * Rules:
 *  - sessionStorage, not localStorage: this is per-tab, per-session cache, and
 *    it must die with the tab rather than outlive a sign-out.
 *  - Every key is versioned. Bumping the version is what actually evicts
 *    already-written entries — a stale entry otherwise survives for the life
 *    of the tab. (AuthProvider's v2 bump exists because v1 entries had cached
 *    a bcrypt hash; that is the precedent for taking this seriously.)
 *  - Never store anything sensitive. A snapshot is readable by any script in
 *    the tab and is not a security boundary.
 *  - All access is try/catch-wrapped: storage can be full, disabled, or
 *    throw in private-browsing modes. A snapshot is an optimisation only and
 *    must never be able to break a render.
 */

/** Prefix for every snapshot key, so clearSnapshots() can find them all. */
const SNAPSHOT_PREFIX = "itarang:";

export function readSnapshot<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    // Unavailable storage or corrupt JSON — fall back to "no snapshot", which
    // is exactly the pre-snapshot behaviour.
    return null;
  }
}

export function writeSnapshot(key: string, value: unknown | null) {
  try {
    if (value === null || value === undefined) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full/unavailable — snapshot is an optimisation only.
  }
}

/**
 * Drop every snapshot this module owns. Called on sign-out so the next user in
 * the same tab cannot inherit the previous user's chrome — a dealer's menu
 * gating must not survive into a CEO's session.
 */
export function clearSnapshots() {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(SNAPSHOT_PREFIX)) doomed.push(key);
    }
    // Collected first, removed after: removing during the scan reindexes
    // sessionStorage and would skip every other key.
    doomed.forEach((key) => sessionStorage.removeItem(key));
  } catch {
    // Nothing to do — see note above.
  }
}
