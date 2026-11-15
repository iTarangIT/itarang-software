import { RESUME_TOKEN_TTL_MS, verifyResumeToken } from "@/lib/onboarding/submitAccess";

// ID 166-C (decision 17, 23 Oct): a dealer with no login opens its own
// onboarding uploads through links signed for the APPLICATION (`by = app:<id>`).
// Such a link used to open for anyone who had it for 15 minutes — a View link
// forwarded on WhatsApp opened the dealer's PAN card. Now the link opens only
// in the browser where the dealer entered the code: entering it sets this
// httpOnly cookie, holding the signed resume token for that application, and
// the files route serves an application link only when the cookie names the
// same application. Copy the link to another browser or phone → refused.
//
// The cookie lives as long as the resume token (30 minutes); the links still
// expire after 15 minutes and a new View mints a fresh one.

export const DOC_BINDING_COOKIE = "itg_onboarding_docs";

type CookieJar = { get(name: string): { value: string } | undefined };

/** Options for NextResponse.cookies.set(): bind this browser to the application of `resumeToken`. */
export function docBindingCookie(resumeToken: string) {
  return {
    name: DOC_BINDING_COOKIE,
    value: resumeToken,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: Math.floor(RESUME_TOKEN_TTL_MS / 1000),
  };
}

/** The application this browser proved with a code in the last 30 minutes, or null. */
export function boundApplication(cookies: CookieJar): string | null {
  return verifyResumeToken(cookies.get(DOC_BINDING_COOKIE)?.value ?? null);
}
