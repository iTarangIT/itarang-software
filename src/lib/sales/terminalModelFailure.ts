/**
 * E-280 — is this extraction failure one that will hit every remaining file?
 *
 * The sales scan makes one vision call per new file. When that call fails for a
 * reason belonging to the FILE (a corrupt PDF, an oversized scan), the loop must
 * carry on; when it fails for a reason belonging to the ACCOUNT, carrying on
 * means downloading the rest of the folder to write the same error a hundred
 * times — burning the file budget, drowning the log, and hiding the one line
 * that explains it.
 *
 * This was not hypothetical. A run against the live folder hit
 * "429 You have no credits remaining" and dutifully recorded 30 identical
 * failures before the budget ran out.
 *
 * THE DISTINCTION THAT MATTERS: not every 429 is terminal.
 * A rate-limit 429 (too many requests per minute) is transient — the next file,
 * seconds later, may well succeed, and aborting on it would strand a scan that
 * only needed to slow down. A quota/billing 429 is permanent until somebody
 * pays. So this matches on the WORDING, never on the status code alone.
 */

/**
 * Deliberately specific. An earlier draft matched a bare `401`, which also
 * matches an invoice total of ₹1401 quoted back in an error message — and a
 * false positive here aborts a healthy scan.
 */
const TERMINAL_PATTERNS: RegExp[] = [
  /insufficient_quota/i,
  /no credits remaining/i,
  /exceeded your current quota/i,
  /billing (?:hard )?limit/i,
  /invalid[_ ]api[_ ]key/i,
  /incorrect api key/i,
  /\b401\s+unauthorized\b/i,
  /\bauthentication\s*(?:error|failed)\b/i,
];

export function isTerminalModelFailure(message: string | null | undefined): boolean {
  if (!message) return false;
  return TERMINAL_PATTERNS.some((re) => re.test(message));
}
