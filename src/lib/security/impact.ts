/**
 * What a detected attack would have MEANT for this CRM.
 *
 * The event row answers "what was sent"; a responder still has to answer "so
 * what?" before they can triage. Without that, `proto_pollution` on a Low badge
 * and `jndi_injection` on a Critical one look like the same kind of noise to
 * anyone who isn't an appsec specialist — and this console is for the IT admin,
 * not for a security team.
 *
 * The wording is deliberately iTarang-specific: the assets named here are the
 * ones this app actually holds (KYC PII, loan sanctions, dealer accounts, the
 * S3 document store, provider credentials), not generic OWASP text. Impact is
 * stated as WOULD-IF-SUCCEEDED — detection means the probe was seen, not that
 * it worked, and `action: blocked` means it was stopped outright.
 */

export interface AttackImpact {
  /** What the sender was attempting, in one plain sentence. */
  what: string;
  /** What it would mean for iTarang if the attempt had succeeded. */
  crmRisk: string;
  /** Concrete systems or data in the blast radius. */
  assets: string[];
  /** The next action for whoever is triaging this row. */
  response: string;
}

const DB_ASSETS = ["Lead & customer KYC records (Aadhaar, PAN, bank)", "Loan sanctions & EMI schedules", "Dealer and user accounts"];

export const ATTACK_IMPACT: Record<string, AttackImpact> = {
  sql_injection: {
    what: "Tried to smuggle SQL into a query parameter so the database runs the attacker's statement instead of ours.",
    crmRisk:
      "A working SQLi against this app would expose or alter anything in Postgres — the full KYC PII set for every lead, loan sanction amounts, and the users table. It is also the usual route to privilege escalation: rewrite a role and the attacker owns an admin session.",
    assets: [...DB_ASSETS, "Entire Postgres database (database-1 / database-2)"],
    response:
      "Check whether the target route builds SQL by string concatenation. Drizzle's parameterised queries are safe; raw sql`` templates with interpolated user input are not.",
  },
  nosql_injection: {
    what: "Sent MongoDB-style query operators ($ne, $gt, $where) in a parameter, hoping a filter object gets built from raw user input.",
    crmRisk:
      "Operator injection turns an equality check into 'match anything' — most commonly on a login or lookup, which returns another user's record. Lower direct risk here since the app is on Postgres/Drizzle, so this usually indicates automated scanning rather than a targeted attempt.",
    assets: ["Any endpoint that builds a filter from request JSON"],
    response: "Low priority on this stack. Treat a repeated source as a scanner and consider blocking the IP upstream.",
  },
  xss: {
    what: "Injected script markup into a parameter, aiming to have it reflected back into a page and executed in a logged-in user's browser.",
    crmRisk:
      "Executing script in an admin or CEO session means acting AS that user — approving a dealer, downloading customer profiles, or exfiltrating the session cookie. React escapes by default, so real risk concentrates on any dangerouslySetInnerHTML or raw HTML rendering.",
    assets: ["Admin / CEO / finance sessions", "Any page rendering unescaped user input"],
    response: "Confirm the target page doesn't render this parameter as raw HTML. If a session was active during the hit, consider forcing a re-login for that user.",
  },
  command_injection: {
    what: "Appended a shell metacharacter plus a real command, trying to get the server to execute it.",
    crmRisk:
      "Success is full server compromise — the VPS runs the app, the PM2 worker, and holds shared/.env with DATABASE_URL, the Supabase service-role key, and the AWS S3 credentials. That is every secret in one file.",
    assets: ["The VPS itself", "shared/.env (DB, Supabase service-role, AWS keys)", "S3 document store"],
    response: "Treat as urgent if it wasn't blocked. Audit any route that shells out (PDF rendering, OCR, image processing) for unsanitised input.",
  },
  jndi_injection: {
    what: "Sent a Log4Shell-style ${jndi:...} lookup, trying to make a logging layer fetch and execute remote code.",
    crmRisk:
      "The classic pre-auth remote-code-execution payload. This stack is Node, not Java, so it is not directly exploitable — but it is never ambiguous and never accidental. Someone is actively probing, not fuzzing.",
    assets: ["No direct Node exposure", "Signals a targeted attacker worth watching"],
    response: "Not exploitable here, but log the source IP. A JNDI probe is a strong signal the same IP will try other payloads.",
  },
  ssrf: {
    what: "Supplied a URL pointing at cloud metadata or an internal address, trying to make the server fetch it on the attacker's behalf.",
    crmRisk:
      "The high-value target is the cloud metadata endpoint (169.254.169.254), which can hand out IAM credentials. It also reaches anything bound to loopback that isn't publicly exposed — including the risk-engine sandbox on 127.0.0.1:8091 and the app's own internal ingest route.",
    assets: ["AWS instance credentials", "Loopback-only services (risk sandbox on :8091)", "Internal API routes"],
    response: "Check any route that fetches a user-supplied URL (scraping, webhook callbacks, document fetch) and enforce an allow-list.",
  },
  path_traversal: {
    what: "Used ../ sequences to try to escape the intended directory and read an arbitrary file.",
    crmRisk:
      "Reading outside the intended path means shared/.env, private keys, or uploaded KYC documents. This app serves files through /api/files and /api/nbfc-uploads, so those routes are the natural target.",
    assets: ["shared/.env", "Uploaded KYC documents & signed agreements", "Server filesystem"],
    response: "Verify /api/files and /api/nbfc-uploads still reject absolute and .. segments — both normalise keys, but confirm the specific path hit.",
  },
  lfi_rfi: {
    what: "Used a PHP stream wrapper (php://filter, phar://, expect://) to try to include a local or remote file.",
    crmRisk:
      "Meaningless against a Next.js app — these wrappers only exist in PHP. Its presence means the attacker is running a generic scanner and has not fingerprinted the stack.",
    assets: ["None on this stack"],
    response: "Safe to ignore individually. Useful only as evidence of an ongoing scan from that IP.",
  },
  xxe: {
    what: "Sent an XML external-entity declaration, trying to make an XML parser read local files or call out to a remote host.",
    crmRisk:
      "Only exploitable where XML is actually parsed. Worth a look at any provider webhook that accepts XML, since those routes are unauthenticated by design.",
    assets: ["XML-accepting webhook routes"],
    response: "Confirm no route parses XML with external entities enabled.",
  },
  crlf_injection: {
    what: "Embedded encoded carriage-return/newline sequences, trying to inject headers or split the HTTP response.",
    crmRisk: "Header injection enables cookie setting and cache poisoning — a poisoned response served to a logged-in admin is the realistic worst case.",
    assets: ["Response headers", "Any CDN or proxy cache in front of the app"],
    response: "Check whether the target route copies request values into response headers.",
  },
  proto_pollution: {
    what: "Sent __proto__ or constructor.prototype keys, trying to poison JavaScript object prototypes globally.",
    crmRisk:
      "A successful pollution changes behaviour app-wide — commonly used to flip an authorisation flag on an object that never explicitly set it. Impact depends entirely on whether the payload reaches a recursive merge.",
    assets: ["Any deep-merge of request JSON into config or auth objects"],
    response: "Audit deep-merge helpers that take request bodies. Object.create(null) or a key denylist fixes it.",
  },
  null_byte: {
    what: "Injected a NUL byte, an old trick for truncating a string so an extension or suffix check is bypassed.",
    crmRisk: "Mostly used to defeat file-extension validation on upload paths — e.g. passing a .pdf check while writing something else.",
    assets: ["Upload validation on document routes"],
    response: "Confirm upload routes validate by parsed content type, not by a truncatable filename string.",
  },
  scanner_ua: {
    what: "The request identified itself as a known attack tool (sqlmap, nikto, nmap, nuclei and similar).",
    crmRisk:
      "No damage on its own — this is reconnaissance. It matters as an early warning: an automated scan is mapping the app and will follow with whatever it finds.",
    assets: ["None directly"],
    response: "Expect follow-up traffic from this IP. If it persists, block it at nginx rather than in the app.",
  },
  sensitive_file_probe: {
    what: "Requested a file that should never be web-reachable — .env, .git/config, backup archives, config dumps.",
    crmRisk:
      "If any of these were ever served, the finder gets DATABASE_URL, the Supabase service-role key (which bypasses RLS entirely) and the AWS keys in one request. The probe failing is the expected outcome; it failing is also worth confirming.",
    assets: ["shared/.env", "Supabase service-role key", "AWS S3 credentials"],
    response: "Confirm the response was a 404. If anything returned 200, rotate every credential in that file immediately.",
  },
  sensitive_unauth: {
    what: "Reached a sensitive endpoint with no authenticated session.",
    crmRisk:
      "Indicates someone enumerating the API surface directly rather than through the UI. Real exposure depends on whether that specific route enforces its own auth check rather than relying on the page around it.",
    assets: ["Whichever API route was hit"],
    response: "Verify the named route calls requireAuth / resolveActor itself. Middleware passes /api/* through without a redirect.",
  },
  open_redirect: {
    what: "Passed an off-site URL in a redirect parameter, trying to make the app bounce users to an attacker-controlled domain.",
    crmRisk:
      "The phishing primitive: a link that genuinely starts at sandbox.itarang.com is far more convincing to a dealer or customer than a lookalike domain. Frequently paired with credential-harvesting pages.",
    assets: ["Dealer and customer trust in iTarang links", "Login flow"],
    response: "Ensure redirect targets are validated against an allow-list of in-app paths.",
  },
  method_abuse: {
    what: "Used an unusual HTTP method (TRACE, TRACK, CONNECT) that a normal client never sends.",
    crmRisk: "Low. TRACE can echo headers back — historically used to read cookies — and CONNECT probes for an open proxy.",
    assets: ["Request headers"],
    response: "Low priority. Reject these methods at nginx if you want them gone entirely.",
  },
  rate_flood: {
    what: "One IP sent enough requests per minute to cross the flood threshold.",
    crmRisk:
      "Availability, not confidentiality. The sandbox runs a single PM2 fork with a 700 MB restart ceiling — sustained flooding will push it into a restart loop and take the CRM offline for dealers mid-transaction.",
    assets: ["App availability", "PM2 process stability", "Database connection pool"],
    response: "Set SECURITY_RATE_BLOCK=1 to answer with 429, or rate-limit at nginx, which is cheaper than doing it in the app.",
  },
  path_enumeration: {
    what: "One IP requested many distinct paths in a short window — directory or endpoint brute-forcing.",
    crmRisk:
      "Reconnaissance. The attacker is building a map of routes that exist, which is the step before targeting whichever one looks weakest.",
    assets: ["API surface disclosure"],
    response: "Correlate with the paths in the evidence below. If they cluster on /api/admin or /api/nbfc, treat the source as targeted rather than opportunistic.",
  },
  auth_bruteforce: {
    what: "Repeated hits against the login surface from one IP, above the per-minute threshold.",
    crmRisk:
      "Account takeover. A compromised dealer login exposes that dealer's leads and customer documents; a compromised admin or CEO login exposes everything and can approve dealers or sanction loans.",
    assets: ["All user accounts", "Admin / CEO / finance dashboards"],
    response: "Check whether the attempts targeted one account or many. A single account under sustained attack warrants a forced password reset for that user.",
  },
  ip_blocked: {
    what: "A request from an IP that is already under an automatic ban. It was refused before any application code ran — this row is the record of the ban working, not of a new attack.",
    crmRisk:
      "None from this request: it never reached routing, the database, or a session. The ban exists because this IP already sent enough blocked attacks to earn it, so what matters is that the source is still trying after being cut off — that is a deliberate operator, not a passing scanner.",
    assets: ["Nothing was reached — the request was refused at the edge"],
    response:
      "No action needed for this row. If the same IP keeps appearing after the ban expires, block it permanently at nginx or Cloudflare, which costs the app nothing at all.",
  },
  burst: {
    what: "Many separate events from one IP inside a short window — escalated automatically.",
    crmRisk: "Not an attack type of its own. It means one source produced a sustained stream of distinct hostile requests, which raises confidence that this is deliberate rather than incidental.",
    assets: ["See the individual events from this IP"],
    response: "Filter the table by this source IP to see the full sequence.",
  },
};

const FALLBACK: AttackImpact = {
  what: "A request matched a detection rule.",
  crmRisk: "This event type has no impact profile yet — assess the evidence and target path directly.",
  assets: [],
  response: "Review the evidence below, then mark the event reviewed or ignored.",
};

export function impactFor(eventType: string): AttackImpact {
  return ATTACK_IMPACT[eventType] ?? FALLBACK;
}
