// Data Analyst agent — error normalisation.
//
// The agent speaks several error shapes, and a client that assumes one renders "undefined":
//   { "error": "connection not found" }              domain errors (400/401/403/404/409/429)
//   { "error": "...", "code": "onboarding_required" }
//   { "detail": "missing bearer token" }             HTTPException
//   { "detail": [ { "loc": [...], "msg": ... } ] }   pydantic validation, 422
// plus HTML or nothing at all from a dead upstream.

export type AnalystErrorCode =
  | "unauthorized"
  | "forbidden"
  | "onboarding_required"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "budget_exhausted"
  | "invalid_request"
  | "not_configured"
  | "upstream"
  | "unknown";

export class AnalystError extends Error {
  readonly status: number;
  readonly code: AnalystErrorCode;

  constructor(message: string, status: number, code: AnalystErrorCode) {
    super(message);
    this.name = "AnalystError";
    this.status = status;
    this.code = code;
  }
}

export function errorResponse(error: unknown, fallback: string): Response {
  // requireAuth() signs a missing session out with redirect(), which throws NEXT_REDIRECT.
  // A fetch caller cannot follow that usefully, so it is answered as a 401 instead.
  const digest = (error as { digest?: unknown } | null)?.digest;
  const redirected = typeof digest === "string" && digest.startsWith("NEXT_REDIRECT");
  const status = (error as { status?: unknown } | null)?.status;

  const api =
    error instanceof AnalystError
      ? error
      : redirected
        ? new AnalystError("your session has ended", 401, "unauthorized")
        : status === 403
          ? new AnalystError("the analyst is only open to CEO and Sales Head", 403, "forbidden")
          : new AnalystError(fallback, 500, "unknown");

  return Response.json({ error: api.message, code: api.code }, { status: api.status });
}

function codeFor(status: number, message: string): AnalystErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 422 || status === 400) return "invalid_request";
  // Both are 429 but need different words: one says wait a moment, the other until tomorrow.
  if (status === 429) return message.includes("budget") ? "budget_exhausted" : "rate_limited";
  if (status >= 500) return "upstream";
  return "unknown";
}

/** Read a failed agent response into one shape. Never throws. */
export async function normalizeAgentError(response: Response): Promise<AnalystError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // HTML from a proxy, or an empty body.
  }

  let message = "";
  let agentCode: AnalystErrorCode | undefined;

  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (record.code === "onboarding_required") agentCode = "onboarding_required";
    if (typeof record.error === "string") message = record.error;
    else if (typeof record.detail === "string") message = record.detail;
    else if (Array.isArray(record.detail)) {
      const first = (record.detail as { msg?: string }[]).find((d) => d?.msg);
      message = first?.msg ?? "that request was not valid";
    }
  }

  if (!message) {
    message =
      response.status >= 500
        ? "the analyst service is not responding"
        : `request failed (${response.status})`;
  }

  // The agent authenticates the CRM's service login, not the person asking. Its 401/403 is
  // therefore a CRM configuration problem, and telling the CEO to "sign in again" would be wrong.
  if (response.status === 401 || agentCode === "onboarding_required") {
    return new AnalystError(
      "the CRM's analyst service login was refused — check ANALYST_SERVICE_EMAIL/PASSWORD",
      502,
      "not_configured",
    );
  }

  return new AnalystError(message, response.status, agentCode ?? codeFor(response.status, message));
}
